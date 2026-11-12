// SPDX-License-Identifier: AGPL-3.0-or-later
// Forget project (docs/memory-core.md section 9): deleting a project removes everything HQ holds for it
// (memory graph, summaries, tasks, findings, ledgers, backups, folders) and writes a deletion record the
// owner can hand to the client. The repo's own files and git history are never touched.
//
// Usage events are anonymized rather than deleted: they keep only tokens, model and account, with no
// project, task or agent, so an account's spend stays true. The HQ audit log is kept as a security record.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { BRAND } from "../src/data/brand";
import { tx } from "./lib/docs";
import type { Neo4jMemory } from "./memory";
import { homeRoot } from "./paths";

export interface DeletionRecord {
  projectId: string;
  projectName: string;
  deletedAt: string;
  deletedBy: string;
  /** What was removed, with counts. */
  removed: { what: string; count: number | null }[];
  /** Whether the memory graph was wiped now, or (Neo4j unreachable) will be when it is back. */
  graph: "deleted" | "queued";
  /** What stays, and why. */
  kept: string[];
}

/** Project-scoped tables and what each holds, deleted children first. */
const TABLES: [table: string, what: string][] = [
  ["gate_events", "Gate evidence entries"],
  ["tasks", "Tasks"],
  ["boards", "Boards"],
  ["findings", "Findings"],
  ["ledger", "Ledger entries (before Phase 2)"],
  ["task_summaries", "Task summaries"],
  ["memory_keep_out", "Keep-out names"],
  ["usage_marks", "Usage meter marks"],
  ["projects_model", "Team template copy"],
];

export const recordsDir = () => join(homeRoot(), "deletion-records");

export async function forgetProject(opts: {
  db: DatabaseSync;
  mem: Neo4jMemory;
  projectId: string;
  projectName: string;
  by: string;
  backupsRoot: string;
  /** Folders HQ keeps for the project (agent folders, logs, the repo's HQ folder); removed here. */
  folders: string[];
  now?: Date;
}): Promise<DeletionRecord> {
  const { db, mem, projectId } = opts;
  const removed: DeletionRecord["removed"] = [];

  // The memory graph: count what is there (when Neo4j answers), then forget through the outbox.
  let counts: Record<string, number> | null = null;
  try {
    const { records } = await (await mem.connected()).executeQuery(
      "MATCH (n) WHERE n.projectId = $p RETURN CASE WHEN n:Memory THEN 'memories' WHEN n:LedgerEntry THEN 'ledger' ELSE 'other' END AS k, count(n) AS n",
      { p: projectId },
    );
    counts = Object.fromEntries(records.map((r) => [r.get("k"), r.get("n")]));
  } catch {
    /* offline: counted as unknown */
  }
  const queued = (db.prepare("SELECT count(*) AS n FROM memory_outbox WHERE project_id = ?").get(projectId) as { n: number }).n;
  mem.forgetProject(projectId);
  await mem.flush();
  const left = (db.prepare("SELECT count(*) AS n FROM memory_outbox WHERE project_id = ?").get(projectId) as { n: number }).n;
  const graph = left === 0 ? "deleted" : "queued";
  removed.push(
    { what: "Memories (decisions, lessons, dead ends)", count: counts ? (counts.memories ?? 0) : null },
    { what: "Ledger entries", count: counts ? (counts.ledger ?? 0) : null },
    { what: "Graph links (tasks, files, agents)", count: counts ? (counts.other ?? 0) : null },
    { what: "Memory writes still queued", count: queued },
  );

  // The HQ database.
  tx(db, () => {
    db.prepare("UPDATE ledger SET superseded_by = NULL WHERE project_id = ?").run(projectId); // revisions point at each other
    for (const [table, what] of TABLES) removed.push({ what, count: Number(db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId).changes) });
    const anon = db.prepare("UPDATE usage_events SET project_id = '', task_id = NULL, agent_id = NULL WHERE project_id = ?").run(projectId).changes;
    removed.push({ what: "Usage events (anonymized: tokens and model kept for account totals, no project, task or agent)", count: Number(anon) });
  });

  // Backups: one folder per project, so the others keep their restore points.
  const backupDir = join(opts.backupsRoot, projectId);
  const backups = existsSync(backupDir) ? readdirSync(backupDir).length : 0;
  rmSync(backupDir, { recursive: true, force: true });
  removed.push({ what: "Memory backups", count: backups });

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
    graph,
    kept: [
      "The repository's own files and git history (they are yours, not HQ's).",
      `The ${BRAND.name} audit log: who did what and when, without task content (a security record).`,
      "Usage totals per account, anonymized as above.",
      ...(graph === "queued" ? ["The memory graph was unreachable; its deletion is queued and runs as soon as it is back."] : []),
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
<div class="box"><b>Project:</b> ${esc(r.projectName)} (<code>${esc(r.projectId)}</code>)<br><b>Deleted:</b> ${esc(r.deletedAt)}<br><b>By:</b> ${esc(r.deletedBy)}<br><b>Memory graph:</b> ${r.graph === "deleted" ? "deleted" : "deletion queued (runs when the graph is reachable)"}</div>
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
