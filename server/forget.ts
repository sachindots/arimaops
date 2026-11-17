// SPDX-License-Identifier: AGPL-3.0-or-later
// Forget project (docs/memory-core.md section 9): deleting a project removes everything HQ holds for it
// (memories, summaries, tasks, findings, ledgers, the copies in every nightly backup, folders) and writes a
// deletion record the owner can hand to the client. The repo's own files and git history are never touched.
//
// Usage events are anonymized rather than deleted: they keep only tokens, model and account, with no
// project, task or agent, so an account's spend stays true. The HQ audit log is kept as a security record.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { BRAND } from "../src/data/brand";
import { tx } from "./lib/docs";
import { eachBackup } from "./backups";
import { legacyBackupsRoot } from "./memoryImport";
import { homeRoot } from "./paths";

export interface DeletionRecord {
  projectId: string;
  projectName: string;
  deletedAt: string;
  deletedBy: string;
  /** What was removed, with counts. */
  removed: { what: string; count: number | null }[];
  /** What stays, and why. */
  kept: string[];
}

/** Project-scoped tables and what each holds, deleted children first. */
const TABLES: [table: string, what: string][] = [
  ["memories", "Memories (decisions, lessons, dead ends)"],
  ["memory_about", "Memory links to files"],
  ["ledger_entries", "Ledger entries"],
  ["gate_events", "Gate evidence entries"],
  ["tasks", "Tasks"],
  ["boards", "Boards"],
  ["findings", "Findings"],
  ["ledger", "Ledger entries (before Phase 2)"],
  ["task_summaries", "Task summaries"],
  ["specs", "Board specs"],
  ["memory_keep_out", "Keep-out names"],
  ["usage_marks", "Usage meter marks"],
  ["projects_model", "Team template copy"],
];

export const recordsDir = () => join(homeRoot(), "deletion-records");

/** Deletes the project's rows (usage anonymized) from one HQ database. Tables an older backup lacks are skipped. */
export function purgeProject(db: DatabaseSync, projectId: string): DeletionRecord["removed"] {
  const removed: DeletionRecord["removed"] = [];
  db.exec("PRAGMA secure_delete = ON"); // freed pages are zeroed, not left readable in the file
  const has = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  tx(db, () => {
    if (has("ledger")) db.prepare("UPDATE ledger SET superseded_by = NULL WHERE project_id = ?").run(projectId); // revisions point at each other
    for (const [table, what] of TABLES) if (has(table)) removed.push({ what, count: Number(db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId).changes) });
    const anon = has("usage_events") ? db.prepare("UPDATE usage_events SET project_id = '', task_id = NULL, agent_id = NULL WHERE project_id = ?").run(projectId).changes : 0;
    removed.push({ what: "Usage events (anonymized: tokens and model kept for account totals, no project, task or agent)", count: Number(anon) });
  });
  // The search index keeps deleted words in old segments until they are merged.
  if (has("memory_text")) db.exec("INSERT INTO memory_text (memory_text) VALUES ('optimize')");
  return removed;
}

export async function forgetProject(opts: {
  db: DatabaseSync;
  projectId: string;
  projectName: string;
  by: string;
  /** Where the nightly backups are; each one loses the project too. */
  backupsDir: string;
  /** Folders HQ keeps for the project (agent folders, logs, the repo's HQ folder); removed here. */
  folders: string[];
  now?: Date;
}): Promise<DeletionRecord> {
  const { db, projectId } = opts;
  const removed = purgeProject(db, projectId);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); // and out of the write-ahead log
  removed.push({ what: "Nightly backups the project was removed from", count: eachBackup((b) => purgeProject(b, projectId), opts.backupsDir) });
  // Memory exports from before memory moved into the HQ database.
  const legacy = /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(projectId) ? join(legacyBackupsRoot(), projectId) : null;
  if (legacy && existsSync(legacy)) {
    rmSync(legacy, { recursive: true, force: true });
    removed.push({ what: "Old memory exports (from the Neo4j era)", count: 1 });
  }

  let folders = 0;
  for (const f of opts.folders) {
    if (!existsSync(f)) continue;
    rmSync(f, { recursive: true, force: true });
    folders++;
  }
  removed.push({ what: `${BRAND.name} folders (agent workspaces, chats, logs, secrets)`, count: folders });

  const record: DeletionRecord = {
    projectId,
    projectName: opts.projectName,
    deletedAt: (opts.now ?? new Date()).toISOString(),
    deletedBy: opts.by,
    removed,
    kept: [
      "The repository's own files and git history (they are yours, not HQ's).",
      `The ${BRAND.name} audit log: who did what and when, without task content (a security record).`,
      "Usage totals per account, anonymized as above.",
    ],
  };
  return record;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A printable page for the client (Save as PDF from the browser). */
export function recordHtml(r: DeletionRecord): string {
  const rows = r.removed.map((x) => `<tr><td>${esc(x.what)}</td><td class="n">${x.count === null ? "not counted (offline)" : x.count}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Deletion record: ${esc(r.projectName)}</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;color:#1b1424;max-width:760px;margin:40px auto;padding:0 20px}
h1{font-size:24px;margin:0 0 4px}.muted{color:#6b6175}table{width:100%;border-collapse:collapse;margin:16px 0}
td,th{border-bottom:1px solid #ddd;padding:8px 6px;text-align:left;vertical-align:top}.n{text-align:right;white-space:nowrap}
.box{border:2px solid #1b1424;padding:12px 16px;margin:16px 0}@media print{body{margin:0}}
</style></head><body>
<h1>Deletion record</h1>
<p class="muted">${esc(BRAND.name)} · generated ${esc(r.deletedAt)}</p>
<div class="box"><b>Project:</b> ${esc(r.projectName)} (<code>${esc(r.projectId)}</code>)<br><b>Deleted:</b> ${esc(r.deletedAt)}<br><b>By:</b> ${esc(r.deletedBy)}</div>
<h2>Removed</h2><table><tr><th>What</th><th class="n">Count</th></tr>${rows}</table>
<h2>Kept</h2><ul>${r.kept.map((k) => `<li>${esc(k)}</li>`).join("")}</ul>
</body></html>`;
}

/** Saves the record as JSON and HTML under ~/.arima/deletion-records; returns the file name (without extension). */
export function saveRecord(r: DeletionRecord, dir = recordsDir()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${r.projectId}-${r.deletedAt.replace(/[:.]/g, "-")}`;
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(r, null, 2), { mode: 0o600 });
  writeFileSync(join(dir, `${name}.html`), recordHtml(r), { mode: 0o600 });
  return name;
}
