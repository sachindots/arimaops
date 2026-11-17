// SPDX-License-Identifier: AGPL-3.0-or-later
// One-time move of memory from the Neo4j era into the HQ database, with no Neo4j needed:
//   1. each project's newest nightly export (~/.arima/backups/memory/<project>/<day>.jsonl.gz),
//   2. then every write still queued in memory_outbox (Neo4j never received those, so they are newer).
// Then memory_outbox is dropped: its absence means the move is done. The old export files are left in place.
//
// shortcut: writes Neo4j received after its last nightly export (at most a day) aren't in either place and
// can't be recovered without Neo4j; the log says how much was moved so the owner can tell.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { cleanMemory } from "./memoryClean";
import { tx } from "./lib/docs";
import { log } from "./lib/log";
import { homeRoot } from "./paths";

type Value = string | number | boolean | null | (string | number | boolean)[];
interface NodeLine { n: number; labels: string[]; p: Record<string, Value> }
interface EdgeLine { r: string; from: number; to: number; p: Record<string, Value> }

const NAME = /^[A-Z][A-Za-z]{0,39}$/;
const DAY = /^(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/;
const plain = (v: unknown): v is Value =>
  v === null || ["string", "number", "boolean"].includes(typeof v) || (Array.isArray(v) && v.every((x) => ["string", "number", "boolean"].includes(typeof x)));

export const legacyBackupsRoot = () => join(homeRoot(), "backups", "memory");

/** Checks an old export's text: its project, labels and edges. */
export function parseBackup(text: string, projectId: string): { nodes: NodeLine[]; edges: EdgeLine[] } {
  const [head, ...rest] = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  if (head?.v !== 1) throw new Error("Not a memory backup this HQ can read.");
  if (head.projectId !== projectId) throw new Error(`This backup is of project ${String(head.projectId)}, not ${projectId}.`);
  const nodes: NodeLine[] = [];
  const edges: EdgeLine[] = [];
  for (const l of rest) {
    const p = l.p as Record<string, unknown>;
    if (!p || typeof p !== "object" || !Object.values(p).every(plain)) throw new Error("A backup line has properties HQ didn't write.");
    if ("n" in l) {
      const labels = l.labels as unknown;
      if (!Number.isInteger(l.n) || !Array.isArray(labels) || !labels.length || !labels.every((x) => typeof x === "string" && NAME.test(x)))
        throw new Error(`A node in the backup has a bad label: ${JSON.stringify(labels)}.`);
      nodes.push({ n: l.n as number, labels: labels as string[], p: { ...(p as Record<string, Value>), projectId } });
    } else if ("r" in l) {
      if (typeof l.r !== "string" || !/^[A-Z][A-Z_]{0,39}$/.test(l.r)) throw new Error(`Bad edge type ${String(l.r)} in the backup.`);
      if (!Number.isInteger(l.from) || !Number.isInteger(l.to)) throw new Error("An edge in the backup doesn't name its nodes.");
      edges.push(l as unknown as EdgeLine);
    } else throw new Error("A backup line is neither a node nor an edge.");
  }
  const known = new Set(nodes.map((x) => x.n));
  if (edges.some((e) => !known.has(e.from) || !known.has(e.to))) throw new Error("An edge in the backup points at a node that isn't in it.");
  return { nodes, edges };
}

/** Moves Neo4j-era memory in, once. Safe to call on every start: it does nothing after the first time. */
export function importLegacyMemory(db: DatabaseSync, root = legacyBackupsRoot()) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_outbox'").get()) return;
  const moved = { ledger: 0, memories: 0, queued: 0, failed: [] as string[] };
  tx(db, () => {
    for (const projectId of existsSync(root) ? readdirSync(root) : []) {
      const newest = (readdirSync(join(root, projectId)).flatMap((f) => DAY.exec(f)?.[1] ?? []).sort().pop());
      if (!newest) continue;
      try {
        const { nodes, edges } = parseBackup(gunzipSync(readFileSync(join(root, projectId, `${newest}.jsonl.gz`))).toString("utf8"), projectId);
        const byN = new Map(nodes.map((x) => [x.n, x]));
        for (const { labels, p } of nodes) {
          if (labels.includes("LedgerEntry")) moved.ledger += ledger(db, p);
          else if (labels.includes("Memory")) moved.memories += memory(db, { ...p, type: labels.find((l) => l !== "Memory") ?? "Lesson" });
        }
        for (const e of edges) {
          const [a, b] = [byN.get(e.from)!, byN.get(e.to)!];
          if (e.r === "ABOUT" && a.labels.includes("Memory") && typeof b.p.name === "string") about(db, projectId, String(a.p.id), b.p.name);
        }
      } catch (err) {
        moved.failed.push(`${projectId}: ${err instanceof Error ? err.message : err}`);
      }
    }
    for (const r of db.prepare("SELECT project_id, op FROM memory_outbox WHERE failed IS NULL ORDER BY id").all() as { project_id: string; op: string }[]) {
      replay(db, r.project_id, JSON.parse(r.op) as Op);
      moved.queued++;
    }
    db.exec("DROP TABLE memory_outbox");
  });
  for (const f of moved.failed) log.warn(`memory: couldn't read an old backup (${f})`);
  if (moved.ledger + moved.memories + moved.queued)
    log.info(`memory: moved from Neo4j into the HQ database: ${moved.memories} memories, ${moved.ledger} ledger entries, ${moved.queued} queued writes.`);
}

// ---------------------------------------------------------------- one row each, idempotent

const s = (v: unknown) => (typeof v === "string" ? v : null);

function ledger(db: DatabaseSync, p: Record<string, unknown>): number {
  if (typeof p.id !== "number") return 0;
  return Number(
    db.prepare("INSERT OR IGNORE INTO ledger_entries (id, project_id, task_id, ledger, kind, text, by, at, superseded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(p.id, s(p.projectId), s(p.taskId), s(p.ledger) ?? "task", s(p.kind) ?? "note", s(p.text) ?? "", s(p.by) ?? "hq", s(p.at) ?? new Date(0).toISOString(), typeof p.supersededBy === "number" ? p.supersededBy : null).changes,
  );
}

function memory(db: DatabaseSync, p: Record<string, unknown>): number {
  if (!s(p.id) || !s(p.text)) return 0;
  const created = s(p.createdAt) ?? new Date().toISOString();
  return Number(
    db.prepare(
      `INSERT OR IGNORE INTO memories (id, project_id, type, text, task_id, source, by, created_at, last_used_at, certified, certified_by, superseded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(s(p.id), s(p.projectId), s(p.type), s(p.text), s(p.taskId), s(p.source) ?? "remember", s(p.by) ?? "hq", created, s(p.lastUsedAt) ?? created, p.certified === true ? 1 : 0, s(p.certifiedBy), s(p.supersededBy)).changes,
  );
}

const about = (db: DatabaseSync, projectId: string, memoryId: string, path: string) =>
  db.prepare("INSERT OR IGNORE INTO memory_about (project_id, memory_id, path) VALUES (?, ?, ?)").run(projectId, memoryId, path);

/** The queued writes of the Neo4j era, as they were defined there. */
type Op =
  | { op: "ledger"; e: Record<string, unknown> }
  | { op: "supersede"; id: number; by: number }
  | { op: "remember"; m: Record<string, unknown> & { about?: string[] } }
  | { op: "touch"; ids: string[]; at: string }
  | { op: "task" }
  | { op: "scrub"; term: string }
  | { op: "merge"; keep: string; drop: string; text: string | null }
  | { op: "certify"; ids: string[]; by: string }
  | { op: "reject"; ids: string[] }
  | { op: "forget" };

function replay(db: DatabaseSync, projectId: string, op: Op) {
  const ids = (list: string[]) => JSON.stringify(list ?? []);
  switch (op.op) {
    case "ledger":
      return void ledger(db, { ...op.e, projectId });
    case "supersede":
      return void db.prepare("UPDATE ledger_entries SET superseded_by = ? WHERE id = ?").run(op.by, op.id);
    case "remember":
      memory(db, { ...op.m, projectId });
      for (const a of op.m.about ?? []) about(db, projectId, String(op.m.id), a);
      return;
    case "touch":
      return void db.prepare("UPDATE memories SET last_used_at = ? WHERE project_id = ? AND id IN (SELECT value FROM json_each(?))").run(op.at, projectId, ids(op.ids));
    case "certify":
      return void db.prepare("UPDATE memories SET certified = 1, certified_by = ? WHERE project_id = ? AND id IN (SELECT value FROM json_each(?))").run(op.by, projectId, ids(op.ids));
    case "reject":
      db.prepare("DELETE FROM memory_about WHERE memory_id IN (SELECT id FROM memories WHERE project_id = ? AND certified = 0 AND id IN (SELECT value FROM json_each(?)))").run(projectId, ids(op.ids));
      return void db.prepare("DELETE FROM memories WHERE project_id = ? AND certified = 0 AND id IN (SELECT value FROM json_each(?))").run(projectId, ids(op.ids));
    case "merge":
      db.prepare("UPDATE memories SET superseded_by = ? WHERE project_id = ? AND id = ? AND certified = 0 AND superseded_by IS NULL").run(op.keep, projectId, op.drop);
      if (op.text !== null) db.prepare("UPDATE memories SET text = ? WHERE project_id = ? AND id = ?").run(op.text, projectId, op.keep);
      return void db.prepare("INSERT OR IGNORE INTO memory_about (project_id, memory_id, path) SELECT project_id, ?, path FROM memory_about WHERE memory_id = ?").run(op.keep, op.drop);
    case "scrub": {
      const clean = (x: string) => cleanMemory(x, { redact: (v) => v, keepOut: [op.term] });
      for (const t of ["memories", "ledger_entries"] as const)
        for (const r of db.prepare(`SELECT id, text FROM ${t} WHERE project_id = ?`).all(projectId) as { id: string | number; text: string }[])
          db.prepare(`UPDATE ${t} SET text = ? WHERE id = ?`).run(clean(r.text), r.id);
      return;
    }
    case "forget":
      for (const t of ["ledger_entries", "memory_about", "memories"]) db.prepare(`DELETE FROM ${t} WHERE project_id = ?`).run(projectId);
      return;
    case "task":
      return; // the task's links now come from its summary, which was always in this database
  }
}
