// SPDX-License-Identifier: AGPL-3.0-or-later
// Backups of the team's memory (docs/memory-core.md section 2). Neo4j Community can only dump a stopped
// database, and HQ doesn't run Neo4j, so HQ exports its own data over Bolt instead: one gzipped JSON-lines
// file per project per night, kept 7 days. Per-project files let "forget project" delete one project's
// backups without touching the others' restore points.
//
// File format, one JSON object per line:
//   {"v":1,"projectId":"…","at":"…"}                      header
//   {"n":0,"labels":["LedgerEntry"],"p":{…}}               a node; `n` numbers it within the file
//   {"r":"SUPERSEDES","from":3,"to":0,"p":{…}}             an edge between two numbered nodes

import type { Driver } from "neo4j-driver";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { log } from "./lib/log";
import type { Neo4jMemory } from "./memory";
import { homeRoot } from "./paths";

export const KEEP_DAYS = 7;
const BACKUP_HOUR = 3;
const NAME = /^[A-Z][A-Za-z]{0,39}$/; // node labels: the same rule templates follow for memoryTypes
const FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/;

type Value = string | number | boolean | null | (string | number | boolean)[];
interface NodeLine { n: number; labels: string[]; p: Record<string, Value> }
interface EdgeLine { r: string; from: number; to: number; p: Record<string, Value> }

export const backupsRoot = () => join(homeRoot(), "backups", "memory");

const projectDir = (root: string, projectId: string) => {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(projectId)) throw new Error(`"${projectId}" isn't a project id.`);
  return join(root, projectId);
};

/** Local date, YYYY-MM-DD: the backup's name. */
export const dayOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The next 03:00 local after `now`. */
export function nextBackupAt(now: Date): Date {
  const at = new Date(now);
  at.setHours(BACKUP_HOUR, 0, 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at;
}

const plain = (v: unknown): v is Value =>
  v === null || ["string", "number", "boolean"].includes(typeof v) || (Array.isArray(v) && v.every((x) => ["string", "number", "boolean"].includes(typeof x)));

/** The project's nodes and the edges between them, read in one transaction. */
export async function exportProject(driver: Driver, projectId: string, now = new Date()): Promise<string> {
  const session = driver.session();
  try {
    return await session.executeRead(async (tx) => {
      const nodes = await tx.run("MATCH (n) WHERE n.projectId = $p RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS p ORDER BY id", { p: projectId });
      const edges = await tx.run(
        "MATCH (a)-[r]->(b) WHERE a.projectId = $p AND b.projectId = $p RETURN elementId(a) AS a, type(r) AS t, properties(r) AS p, elementId(b) AS b",
        { p: projectId },
      );
      const num = new Map<string, number>();
      const lines: string[] = [JSON.stringify({ v: 1, projectId, at: now.toISOString() })];
      for (const r of nodes.records) {
        const p = r.get("p") as Record<string, unknown>;
        const bad = Object.entries(p).find(([, v]) => !plain(v));
        if (bad) throw new Error(`Node property ${bad[0]} can't be backed up (only text, numbers, true/false and lists of them).`);
        const n = num.size;
        num.set(r.get("id"), n);
        lines.push(JSON.stringify({ n, labels: r.get("labels"), p: p as Record<string, Value> } satisfies NodeLine));
      }
      for (const r of edges.records) lines.push(JSON.stringify({ r: r.get("t"), from: num.get(r.get("a"))!, to: num.get(r.get("b"))!, p: r.get("p") } satisfies EdgeLine));
      return lines.join("\n") + "\n";
    });
  } finally {
    await session.close();
  }
}

/** Checks a backup file's text before anything is deleted. */
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

/** Replaces the project's graph with the backup's, in one transaction: all of it or none. */
export async function importProject(driver: Driver, projectId: string, text: string) {
  const { nodes, edges } = parseBackup(text, projectId);
  const session = driver.session();
  try {
    await session.executeWrite(async (tx) => {
      await tx.run("MATCH (n) WHERE n.projectId = $p DETACH DELETE n", { p: projectId });
      await tx.run("UNWIND $nodes AS x CREATE (n:$(x.labels)) SET n = x.p, n._restore = x.n", { nodes });
      await tx.run(
        `UNWIND $edges AS e
         MATCH (a {projectId: $p, _restore: e.from}), (b {projectId: $p, _restore: e.to})
         CREATE (a)-[r:$(e.r)]->(b) SET r = e.p`,
        { p: projectId, edges },
      );
      await tx.run("MATCH (n) WHERE n.projectId = $p REMOVE n._restore", { p: projectId });
    });
  } finally {
    await session.close();
  }
}

/** Backups of a project, newest first (dates). */
export function listBackups(projectId: string, root = backupsRoot()): string[] {
  const dir = projectDir(root, projectId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => FILE.exec(f)?.[1] ?? []).sort().reverse();
}

/** Writes today's backup of one project and keeps the newest KEEP_DAYS. */
export async function backupProject(mem: Neo4jMemory, projectId: string, root = backupsRoot(), now = new Date()): Promise<string> {
  const text = await exportProject(await mem.connected(), projectId, now);
  const dir = projectDir(root, projectId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${dayOf(now)}.jsonl.gz`);
  writeFileSync(file + ".tmp", gzipSync(text), { mode: 0o600 });
  renameSync(file + ".tmp", file);
  chmodSync(file, 0o600);
  for (const old of listBackups(projectId, root).slice(KEEP_DAYS)) rmSync(join(dir, `${old}.jsonl.gz`), { force: true });
  return file;
}

/** Puts a project's memory back as it was on `date`, and re-reads the ledgers. */
export async function restoreProject(mem: Neo4jMemory, projectId: string, date: string, root = backupsRoot()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Pick a backup by its date.");
  const file = join(projectDir(root, projectId), `${date}.jsonl.gz`);
  if (!existsSync(file)) throw new Error(`No memory backup of ${projectId} from ${date}.`);
  await importProject(await mem.connected(), projectId, gunzipSync(readFileSync(file)).toString("utf8"));
  await mem.reload();
}

/** Every project that has memory: tonight's backups. A failed one doesn't stop the others. */
export async function backupAll(mem: Neo4jMemory, root = backupsRoot(), now = new Date()): Promise<{ done: string[]; failed: string[] }> {
  const { records } = await (await mem.connected()).executeQuery("MATCH (n) WHERE n.projectId IS NOT NULL RETURN DISTINCT n.projectId AS p");
  const out = { done: [] as string[], failed: [] as string[] };
  for (const r of records) {
    const p = r.get("p") as string;
    try {
      await backupProject(mem, p, root, now);
      out.done.push(p);
    } catch (err) {
      log.warn(`memory backup of ${p} failed: ${err instanceof Error ? err.message : err}`);
      out.failed.push(p);
    }
  }
  return out;
}

/** Runs backupAll at 03:00 local every night. Returns a stop function. */
export function scheduleBackups(mem: Neo4jMemory, after: () => void = () => {}): () => void {
  let timer: NodeJS.Timeout;
  const arm = () => {
    timer = setTimeout(async () => {
      try {
        const r = await backupAll(mem);
        log.info(`memory backup: ${r.done.length} project${r.done.length === 1 ? "" : "s"} saved${r.failed.length ? `, ${r.failed.join(", ")} failed` : ""}.`);
      } catch (err) {
        log.warn(`memory backup skipped: ${err instanceof Error ? err.message : err}`);
      }
      after();
      arm();
    }, nextBackupAt(new Date()).getTime() - Date.now());
    timer.unref();
  };
  arm();
  return () => clearTimeout(timer);
}
