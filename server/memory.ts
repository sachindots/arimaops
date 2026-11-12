// SPDX-License-Identifier: AGPL-3.0-or-later
// The memory interface (docs/core-model.md sections 7 and 8, docs/memory-core.md). The ledgers live in
// Neo4j; Phase 2 adds recall, related and remember on the same store.
//
// Task ledger: the lead's facts, guesses and plan. Progress ledger: HQ's stall checks and replans.
// Entries are never edited: a revision is a new entry, and the old one points at it.
//
// Neo4j is run by the user (compose, or their own install), so HQ must keep working while it is
// down. Every write goes to an outbox table in the HQ database first and replays in order; reads come
// from an in-process copy of the ledgers, loaded from Neo4j on connect. HQ is the only writer, and an
// entry only ever changes by gaining `supersededBy`, so the copy can't drift from the graph.

import neo4j, { type Driver } from "neo4j-driver";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { BRAND } from "../src/data/brand";
import { CORE_MEMORY_TYPES, LEDGER_KINDS, type LedgerEntry, type LedgerKind, type LedgerName, type Memory, type TaskSummary } from "../src/data/model";
import type { MemoryInput, MemoryState, Scope } from "../src/data/types";
import { credentialsVault, redactor } from "./credentials/registry";
import { cleanMemory, saysSomething, type MemoryContext } from "./memoryClean";
import type { ExtractionSettings } from "./memoryExtract";
import { hqDb } from "./lib/db";
import { readDoc, tx, writeDoc } from "./lib/docs";
import { log } from "./lib/log";
import { homeRoot } from "./paths";
import { projectTemplate } from "./templates";

export interface MemoryStore {
  addLedger(e: Omit<LedgerEntry, "id" | "at" | "supersededBy">): LedgerEntry;
  /** Replaces an entry's text with a new entry; the old one stays, marked superseded. */
  reviseLedger(projectId: string, id: number, text: string, by: string): LedgerEntry;
  /** Current entries (superseded ones left out), oldest first. */
  ledger(projectId: string, opts?: { taskId?: string | null; ledger?: LedgerName }): LedgerEntry[];
  /** Removes everything the project remembered. */
  forgetProject(projectId: string): void;
  /** Stores a memory, uncertified. Its type is a core one or one of the project template's memoryTypes. */
  remember(m: RememberInput): Memory;
  /** Memories matching the words of `query`, certified first. Needs Neo4j. */
  recall(projectId: string, query: string, opts?: { limit?: number; types?: string[] }): Promise<Memory[]>;
  /** Memories linked to a task, a file or component, or another memory, within `depth` hops. Needs Neo4j. */
  related(projectId: string, ref: { taskId?: string; path?: string; memoryId?: string }, opts?: { depth?: 1 | 2; limit?: number }): Promise<Memory[]>;
  /** Keeps a finished task's summary, and puts the task, what it built on, its files and its owner in the graph. */
  summarise(s: TaskSummary): void;
  summary(projectId: string, taskId: string): TaskSummary | null;
}

export interface RememberInput {
  projectId: string;
  type: string;
  text: string;
  taskId?: string | null;
  /** File paths or component names it is about. */
  about?: string[];
  by: string;
  source?: Memory["source"];
}

/** What the lead may write to its task ledger; stall and replan entries are HQ's. */
export const LEAD_KINDS = ["fact", "guess", "plan", "note"] as const satisfies readonly LedgerKind[];

const MAX_TEXT = 2000;
const RETRY_MS = 30_000;

export interface Neo4jConfig {
  url: string;
  user: string;
  password: string;
}

/** One queued write. Each is idempotent, so replaying one that already reached Neo4j is harmless. */
type Op =
  | { op: "ledger"; e: Omit<LedgerEntry, "supersededBy"> }
  | { op: "supersede"; id: number; by: number }
  | { op: "remember"; m: Omit<Memory, "certified" | "certifiedBy" | "lastUsedAt">; edge: string }
  | { op: "touch"; ids: string[]; at: string }
  | { op: "task"; t: Pick<TaskSummary, "taskId" | "title" | "stageId" | "ownerId" | "needs" | "files" | "finishedAt"> }
  | { op: "scrub"; term: string }
  | { op: "merge"; keep: string; drop: string; text: string | null }
  | { op: "forget" };

/** How a task points at what it produced (docs/memory-core.md section 3). */
const TASK_EDGE: Record<string, string> = { Decision: "DECIDED", Lesson: "LEARNED", DeadEnd: "HIT" };
const MAX_ABOUT = 20;

const CYPHER: { [K in Exclude<Op["op"], "scrub">]: string } = {
  ledger: `MERGE (e:LedgerEntry {id: $e.id})
           ON CREATE SET e.projectId = $e.projectId, e.taskId = $e.taskId, e.ledger = $e.ledger, e.kind = $e.kind,
                         e.text = $e.text, e.by = $e.by, e.at = $e.at
           WITH e WHERE e.taskId IS NOT NULL
           MERGE (t:Task {projectId: e.projectId, taskId: e.taskId})
           MERGE (t)-[:HAS_ENTRY]->(e)`,
  // Labels and edge types can't be parameters: `type` and `edge` are checked against the template before queueing.
  remember: `MERGE (m:Memory {id: $m.id})
             ON CREATE SET m.projectId = $m.projectId, m.text = $m.text, m.taskId = $m.taskId, m.certified = false,
                           m.source = $m.source, m.by = $m.by, m.createdAt = $m.createdAt, m.lastUsedAt = $m.createdAt
             SET m:$($m.type)
             WITH m
             CALL (m) {
               WITH m WHERE m.taskId IS NOT NULL
               MERGE (t:Task {projectId: m.projectId, taskId: m.taskId})
               MERGE (t)-[:$($edge)]->(m)
             }
             WITH m
             UNWIND $m.about AS name
             MERGE (c:Component {projectId: m.projectId, name: name})
             MERGE (m)-[:ABOUT]->(c)`,
  task: `MERGE (t:Task {projectId: $projectId, taskId: $t.taskId})
         SET t.title = $t.title, t.stageId = $t.stageId, t.finishedAt = $t.finishedAt
         WITH t
         CALL (t) { UNWIND $t.needs AS n MERGE (d:Task {projectId: t.projectId, taskId: n}) MERGE (t)-[:FOLLOWS]->(d) }
         CALL (t) { UNWIND $t.files AS f MERGE (c:Component {projectId: t.projectId, name: f}) MERGE (t)-[:TOUCHED]->(c) }
         CALL (t) {
           WITH t WHERE $t.ownerId IS NOT NULL
           MERGE (a:Agent {projectId: t.projectId, agentId: $t.ownerId})
           MERGE (a)-[:WORKED_ON]->(t)
         }`,
  // Consolidation: the dropped memory stays as history, pointed at by the kept one, which takes over its links.
  merge: `MATCH (k:Memory {projectId: $projectId, id: $keep}), (l:Memory {projectId: $projectId, id: $drop})
          WHERE l.supersededBy IS NULL AND k.supersededBy IS NULL AND NOT l.certified
          SET l.supersededBy = k.id, k.text = coalesce($text, k.text),
              k.lastUsedAt = CASE WHEN l.lastUsedAt > k.lastUsedAt THEN l.lastUsedAt ELSE k.lastUsedAt END
          MERGE (k)-[:SUPERSEDES]->(l)
          WITH k, l
          CALL (k, l) { MATCH (l)-[:ABOUT]->(c:Component) MERGE (k)-[:ABOUT]->(c) }
          CALL (k, l) { MATCH (t:Task)-[r]->(l) WHERE type(r) IN ['DECIDED', 'LEARNED', 'HIT', 'NOTED'] MERGE (t)-[:$(type(r))]->(k) }`,
  touch: `MATCH (m:Memory) WHERE m.projectId = $projectId AND m.id IN $ids SET m.lastUsedAt = $at`,
  supersede: `MATCH (old:LedgerEntry {id: $id}), (new:LedgerEntry {id: $by})
              SET old.supersededBy = $by
              MERGE (new)-[:SUPERSEDES]->(old)`,
  forget: `MATCH (n) WHERE n.projectId = $projectId DETACH DELETE n`,
};

const SCHEMA = [
  "CREATE CONSTRAINT ledger_id IF NOT EXISTS FOR (e:LedgerEntry) REQUIRE e.id IS UNIQUE",
  "CREATE INDEX ledger_project IF NOT EXISTS FOR (e:LedgerEntry) ON (e.projectId)",
  "CREATE CONSTRAINT memory_id IF NOT EXISTS FOR (m:Memory) REQUIRE m.id IS UNIQUE",
  "CREATE INDEX memory_project IF NOT EXISTS FOR (m:Memory) ON (m.projectId)",
  "CREATE CONSTRAINT task_key IF NOT EXISTS FOR (t:Task) REQUIRE (t.projectId, t.taskId) IS UNIQUE",
  "CREATE CONSTRAINT agent_key IF NOT EXISTS FOR (a:Agent) REQUIRE (a.projectId, a.agentId) IS UNIQUE",
  "CREATE CONSTRAINT component_key IF NOT EXISTS FOR (c:Component) REQUIRE (c.projectId, c.name) IS UNIQUE",
  "CREATE FULLTEXT INDEX memory_text IF NOT EXISTS FOR (m:Memory) ON EACH [m.text]",
];

/** A memory as Cypher returns it: its type is the label other than Memory, `about` follows ABOUT edges. */
const MEMORY_RETURN = `m { .*, type: [l IN labels(m) WHERE l <> 'Memory'][0], about: [(m)-[:ABOUT]->(c:Component) | c.name] } AS m`;
const toMemory = (m: Record<string, unknown>): Memory => ({
  id: m.id as string,
  projectId: m.projectId as string,
  type: m.type as string,
  text: m.text as string,
  taskId: (m.taskId as string | undefined) ?? null,
  about: ((m.about as string[] | undefined) ?? []).sort(),
  certified: m.certified === true,
  certifiedBy: (m.certifiedBy as string | undefined) ?? null,
  source: m.source as Memory["source"],
  by: m.by as string,
  createdAt: m.createdAt as string,
  lastUsedAt: m.lastUsedAt as string,
});
const ORDER = "ORDER BY m.certified DESC, score DESC, m.createdAt DESC, m.id";

/** A query or data problem: retrying won't help. Anything else (refused, auth, timeout) means "offline". */
const isOpError = (err: unknown) => /^Neo\.ClientError\.(Statement|Schema|Procedure)\./.test(String((err as { code?: string })?.code ?? ""));

export type MemoryStatus = { state: "unconfigured" } | { state: "offline"; error: string } | { state: "online"; queued: number };

export class Neo4jMemory implements MemoryStore {
  private entries = new Map<number, LedgerEntry>();
  private driver: Driver | null = null;
  private driverFor = "";
  private loaded = false;
  private schemaDone = false;
  private flushing: Promise<void> | null = null;
  private retry: NodeJS.Timeout | null = null;
  private lastError = "";
  private closed = false;
  /** Called after each attempt to reach Neo4j (the server tells every open browser). */
  onChange: (() => void) | null = null;

  constructor(
    private db: DatabaseSync,
    private config: () => Neo4jConfig | null,
    /** The project template's own memory types (beyond the core ones). */
    private project: {
      /** The project template's own memory types (beyond the core ones). */
      templateTypes?: (projectId: string) => string[];
      /** The vault's redactor and the project's scope, for cleanMemory. */
      context?: (projectId: string) => Omit<MemoryContext, "keepOut">;
    } = {},
  ) {
    // Until Neo4j answers, reads see what is still queued here.
    for (const r of this.db.prepare("SELECT project_id, op FROM memory_outbox WHERE failed IS NULL ORDER BY id").all() as { project_id: string; op: string }[])
      this.apply(JSON.parse(r.op), r.project_id);
  }

  // ---------------------------------------------------------------- MemoryStore

  addLedger(e: Omit<LedgerEntry, "id" | "at" | "supersededBy">): LedgerEntry {
    let out!: LedgerEntry;
    tx(this.db, () => (out = this.add(e)));
    this.kick();
    return out;
  }

  reviseLedger(projectId: string, id: number, text: string, by: string): LedgerEntry {
    const old = this.entries.get(id);
    if (!old || old.projectId !== projectId) throw new Error(this.loaded ? `No ledger entry ${id}.` : `No ledger entry ${id} here yet: memory is offline, try again when it's back.`);
    if (old.supersededBy !== null) throw new Error(`Entry ${id} was already revised (see ${old.supersededBy}).`);
    let next!: LedgerEntry;
    tx(this.db, () => {
      next = this.add({ projectId, taskId: old.taskId, ledger: old.ledger, kind: old.kind, text, by });
      this.queue(projectId, { op: "supersede", id, by: next.id });
    });
    this.kick();
    return next;
  }

  ledger(projectId: string, opts: { taskId?: string | null; ledger?: LedgerName } = {}): LedgerEntry[] {
    return [...this.entries.values()]
      .filter((e) => e.projectId === projectId && e.supersededBy === null)
      .filter((e) => !opts.ledger || e.ledger === opts.ledger)
      .filter((e) => opts.taskId === undefined || e.taskId === opts.taskId)
      .sort((a, b) => a.id - b.id);
  }

  forgetProject(projectId: string) {
    tx(this.db, () => {
      // Writes still queued for the project would only be deleted again: drop them.
      this.db.prepare("DELETE FROM memory_outbox WHERE project_id = ?").run(projectId);
      this.queue(projectId, { op: "forget" });
    });
    this.kick();
  }

  remember(input: RememberInput): Memory {
    const types: string[] = [...CORE_MEMORY_TYPES, ...(this.project.templateTypes?.(input.projectId) ?? [])];
    if (!types.includes(input.type)) throw new Error(`"${input.type}" isn't a memory type in this project. Types: ${types.join(", ")}.`);
    if (!String(input.text ?? "").trim()) throw new Error("A memory needs text.");
    const clean = this.cleaner(input.projectId);
    const text = clean(String(input.text).trim()).slice(0, MAX_TEXT);
    if (!saysSomething(text)) throw new Error("Nothing is left to remember once secrets and personal data are taken out.");
    const about = [...new Set((input.about ?? []).map((a) => clean(String(a).trim()).slice(0, 300)).filter((a) => a && !/\[(secret|email|phone|ip|name)\]/.test(a)))].slice(0, MAX_ABOUT);
    let out!: Memory;
    tx(this.db, () => {
      const { id } = this.db.prepare("INSERT INTO memory_ids DEFAULT VALUES RETURNING id").get() as { id: number };
      const m = { id: `M-${id}`, projectId: input.projectId, type: input.type, text, taskId: input.taskId ?? null, about, source: input.source ?? "remember", by: input.by, createdAt: new Date().toISOString() };
      this.db.prepare("INSERT INTO memory_outbox (project_id, op, at) VALUES (?, ?, ?)").run(input.projectId, JSON.stringify({ op: "remember", m, edge: TASK_EDGE[input.type] ?? "NOTED" } satisfies Op), Date.now());
      out = { ...m, certified: false, certifiedBy: null, lastUsedAt: m.createdAt };
    });
    this.kick();
    return out;
  }

  async recall(projectId: string, query: string, opts: { limit?: number; types?: string[] } = {}): Promise<Memory[]> {
    // Words only: Lucene's query syntax (quotes, wildcards, field:) never reaches the index from an agent.
    const words = [...new Set(String(query).toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [])].slice(0, 20);
    if (!words.length) return [];
    const driver = await this.connected();
    const { records } = await driver.executeQuery(
      `CALL db.index.fulltext.queryNodes('memory_text', $q) YIELD node AS m, score
       WHERE m.projectId = $p AND m.supersededBy IS NULL AND ($types IS NULL OR any(l IN labels(m) WHERE l IN $types))
       RETURN ${MEMORY_RETURN} ${ORDER} LIMIT $limit`,
      { q: words.join(" OR "), p: projectId, types: opts.types?.length ? opts.types : null, limit: neo4j.int(Math.min(Math.max(1, Math.trunc(opts.limit ?? 10)), 50)) },
    );
    return this.used(projectId, records.map((r) => toMemory(r.get("m"))));
  }

  async related(projectId: string, ref: { taskId?: string; path?: string; memoryId?: string }, opts: { depth?: 1 | 2; limit?: number } = {}): Promise<Memory[]> {
    if (!ref.taskId && !ref.path && !ref.memoryId) return [];
    const depth = opts.depth === 1 ? 1 : 2; // not a parameter in Cypher: only these two ever reach the query
    const driver = await this.connected();
    const { records } = await driver.executeQuery(
      `MATCH (a) WHERE a.projectId = $p AND (
         (a:Task AND a.taskId = $taskId) OR (a:Component AND a.name = $path) OR (a:Memory AND a.id = $memoryId))
       MATCH (a)-[*1..${depth}]-(m:Memory) WHERE m.projectId = $p AND m <> a AND m.supersededBy IS NULL
       WITH DISTINCT m, 0 AS score
       RETURN ${MEMORY_RETURN} ${ORDER} LIMIT $limit`,
      { p: projectId, taskId: ref.taskId ?? null, path: ref.path ?? null, memoryId: ref.memoryId ?? null, limit: neo4j.int(Math.min(Math.max(1, Math.trunc(opts.limit ?? 10)), 50)) },
    );
    return this.used(projectId, records.map((r) => toMemory(r.get("m"))));
  }

  summarise(t: TaskSummary) {
    const clean = this.cleaner(t.projectId);
    const opt = (v: string | null) => (v === null ? null : clean(v));
    const s: TaskSummary = {
      ...t,
      title: clean(t.title),
      description: opt(t.description),
      doneWhen: opt(t.doneWhen),
      note: opt(t.note),
      deliverablePath: opt(t.deliverablePath),
      ledger: t.ledger.map((e) => ({ kind: e.kind, text: clean(e.text) })),
      needs: [...new Set(t.needs)],
      files: [...new Set(t.files.map((f) => clean(f.trim())).filter(Boolean))].slice(0, MAX_ABOUT * 5),
    };
    tx(this.db, () => {
      this.db
        .prepare("INSERT INTO task_summaries (project_id, task_id, body, finished_at) VALUES (?, ?, ?, ?) ON CONFLICT (project_id, task_id) DO UPDATE SET body = excluded.body, finished_at = excluded.finished_at, extracted_at = NULL, extract_attempts = 0, extract_error = NULL")
        .run(s.projectId, s.taskId, JSON.stringify(s), Date.parse(s.finishedAt));
      const op: Op = { op: "task", t: { taskId: s.taskId, title: s.title, stageId: s.stageId, ownerId: s.ownerId, needs: s.needs, files: s.files, finishedAt: s.finishedAt } };
      this.db.prepare("INSERT INTO memory_outbox (project_id, op, at) VALUES (?, ?, ?)").run(s.projectId, JSON.stringify(op), Date.now());
    });
    this.kick();
  }

  summary(projectId: string, taskId: string): TaskSummary | null {
    const row = this.db.prepare("SELECT body FROM task_summaries WHERE project_id = ? AND task_id = ?").get(projectId, taskId) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as TaskSummary) : null;
  }

  /** Summaries extraction hasn't read yet (at most 3 tries each), oldest first. */
  unextracted(limit = 20): TaskSummary[] {
    return (this.db.prepare("SELECT body FROM task_summaries WHERE extracted_at IS NULL AND extract_attempts < 3 ORDER BY finished_at LIMIT ?").all(limit) as { body: string }[]).map((r) => JSON.parse(r.body));
  }

  /** Records an extraction: done, or one more failed try and why. */
  extracted(projectId: string, taskId: string, error: string | null = null) {
    if (error) this.db.prepare("UPDATE task_summaries SET extract_attempts = extract_attempts + 1, extract_error = ? WHERE project_id = ? AND task_id = ?").run(error.slice(0, 500), projectId, taskId);
    else this.db.prepare("UPDATE task_summaries SET extracted_at = ?, extract_error = NULL WHERE project_id = ? AND task_id = ?").run(Date.now(), projectId, taskId);
  }

  /** The project's current memories (not merged away), for consolidation. Needs Neo4j. */
  async memories(projectId: string): Promise<Memory[]> {
    const { records } = await (await this.connected()).executeQuery(
      `MATCH (m:Memory {projectId: $p}) WHERE m.supersededBy IS NULL RETURN ${MEMORY_RETURN} ORDER BY m.createdAt, m.id`,
      { p: projectId },
    );
    return records.map((r) => toMemory(r.get("m")));
  }

  /** Folds `drop` into `keep` (consolidation). `text`, if given, replaces keep's text; a certified memory is never dropped. */
  merge(projectId: string, keep: string, drop: string, text: string | null) {
    const t = text === null ? null : this.cleaner(projectId)(text.trim()).slice(0, MAX_TEXT);
    if (t !== null && !saysSomething(t)) throw new Error("The merged text says nothing once secrets and personal data are taken out.");
    tx(this.db, () => this.queue(projectId, { op: "merge", keep, drop, text: t }));
    this.kick();
  }

  /** Deletes uncertified memories nobody recalled or used since `before`. Needs Neo4j. Returns how many went. */
  async fade(before: Date): Promise<number> {
    const { records } = await (await this.connected()).executeQuery(
      "MATCH (m:Memory) WHERE m.certified = false AND m.lastUsedAt < $before DETACH DELETE m RETURN count(m) AS n",
      { before: before.toISOString() },
    );
    return records[0].get("n") as number;
  }

  /** Every project with memories in the graph. Needs Neo4j. */
  async memoryProjects(): Promise<string[]> {
    const { records } = await (await this.connected()).executeQuery("MATCH (m:Memory) RETURN DISTINCT m.projectId AS p");
    return records.map((r) => r.get("p") as string);
  }

  /** Names (people, handles) never to keep, in this project. Adding one also scrubs what is already stored. */
  keepOut(projectId: string, term: string, by: string) {
    const t = String(term ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
    if (t.length < 2) throw new Error("Give a name of at least 2 characters.");
    tx(this.db, () => {
      this.db.prepare("INSERT INTO memory_keep_out (project_id, term, by, at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING").run(projectId, t, by, Date.now());
      const clean = this.cleaner(projectId);
      // Summaries live here, not in the graph: scrub them in place.
      for (const r of this.db.prepare("SELECT task_id, body FROM task_summaries WHERE project_id = ?").all(projectId) as { task_id: string; body: string }[]) {
        const b = JSON.parse(r.body) as TaskSummary;
        const next = { ...b, title: clean(b.title), description: b.description && clean(b.description), doneWhen: b.doneWhen && clean(b.doneWhen), note: b.note && clean(b.note), ledger: b.ledger.map((e) => ({ ...e, text: clean(e.text) })) };
        if (JSON.stringify(next) !== r.body) this.db.prepare("UPDATE task_summaries SET body = ? WHERE project_id = ? AND task_id = ?").run(JSON.stringify(next), projectId, r.task_id);
      }
      this.queue(projectId, { op: "scrub", term: t });
    });
    this.kick();
  }

  keptOut(projectId: string): string[] {
    return (this.db.prepare("SELECT term FROM memory_keep_out WHERE project_id = ? ORDER BY term").all(projectId) as { term: string }[]).map((r) => r.term);
  }

  private cleaner(projectId: string): (text: string) => string {
    const ctx: MemoryContext = { redact: (x) => x, ...this.project.context?.(projectId), keepOut: this.keptOut(projectId) };
    return (text) => cleanMemory(text, ctx);
  }

  /** Memories handed to an agent count as used: unused, uncertified ones fade after 30 days. */
  private used(projectId: string, list: Memory[]): Memory[] {
    if (list.length) {
      this.db.prepare("INSERT INTO memory_outbox (project_id, op, at) VALUES (?, ?, ?)").run(projectId, JSON.stringify({ op: "touch", ids: list.map((m) => m.id), at: new Date().toISOString() } satisfies Op), Date.now());
      this.kick();
    }
    return list;
  }

  // ---------------------------------------------------------------- connection and outbox

  status(): MemoryStatus {
    if (!this.config()) return { state: "unconfigured" };
    if (!this.loaded) return { state: "offline", error: this.lastError || "connecting" };
    const { n } = this.db.prepare("SELECT count(*) AS n FROM memory_outbox WHERE failed IS NULL").get() as { n: number };
    return { state: "online", queued: n };
  }

  /** Sends queued writes to Neo4j, in order. Resolves when the outbox is empty or Neo4j is unreachable. */
  flush(): Promise<void> {
    return (this.flushing ??= this.drain().finally(() => {
      this.flushing = null;
      this.onChange?.();
    }));
  }

  /** The live connection, for whole-graph jobs (backups), after sending what's queued. Throws while Neo4j is unreachable. */
  async connected(): Promise<Driver> {
    await this.flush();
    if (!this.loaded || !this.driver) throw new Error(`Memory is offline${this.lastError ? `: ${this.lastError}` : ""}.`);
    return this.driver;
  }

  /** Re-reads the ledgers from Neo4j (after a restore). */
  async reload() {
    this.loaded = false;
    await this.flush();
  }

  /** Stops retrying and closes the connection (tests, shutdown). */
  async close() {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    await this.flushing;
    await this.driver?.close();
    this.driver = null;
  }

  private add(e: Omit<LedgerEntry, "id" | "at" | "supersededBy">): LedgerEntry {
    if (!(LEDGER_KINDS as readonly string[]).includes(e.kind)) throw new Error(`Ledger kinds are ${LEDGER_KINDS.join(", ")}.`);
    if (!e.text.trim()) throw new Error("A ledger entry needs text.");
    const text = this.cleaner(e.projectId)(e.text.trim()).slice(0, MAX_TEXT);
    const { id } = this.db.prepare("INSERT INTO memory_ids DEFAULT VALUES RETURNING id").get() as { id: number };
    const entry = { id, projectId: e.projectId, taskId: e.taskId, ledger: e.ledger, kind: e.kind, text, by: e.by, at: new Date().toISOString() };
    this.queue(e.projectId, { op: "ledger", e: entry });
    return this.entries.get(id)!;
  }

  private queue(projectId: string, op: Op) {
    this.db.prepare("INSERT INTO memory_outbox (project_id, op, at) VALUES (?, ?, ?)").run(projectId, JSON.stringify(op), Date.now());
    this.apply(op, projectId);
  }

  /** The same write, on the in-process copy. */
  private apply(op: Op, projectId: string) {
    if (op.op === "ledger") this.entries.set(op.e.id, { ...op.e, supersededBy: this.entries.get(op.e.id)?.supersededBy ?? null });
    else if (op.op === "supersede") {
      const old = this.entries.get(op.id);
      if (old) old.supersededBy = op.by;
    } else if (op.op === "scrub") {
      for (const e of this.entries.values()) if (e.projectId === projectId) e.text = cleanMemory(e.text, { redact: (x) => x, keepOut: [op.term] });
    } else if (op.op === "forget") for (const [id, e] of this.entries) if (e.projectId === projectId) this.entries.delete(id);
  }

  private kick() {
    void this.flush();
  }

  private connect(): Driver | null {
    const cfg = this.config();
    const key = cfg ? `${cfg.url}\n${cfg.user}\n${cfg.password}` : "";
    if (key !== this.driverFor) {
      void this.driver?.close();
      this.driver = cfg
        ? neo4j.driver(cfg.url, neo4j.auth.basic(cfg.user, cfg.password), {
            disableLosslessIntegers: true,
            connectionTimeout: 5_000,
            connectionAcquisitionTimeout: 5_000,
            maxTransactionRetryTime: 2_000,
          })
        : null;
      this.driverFor = key;
      this.loaded = this.schemaDone = false;
    }
    return this.driver;
  }

  private async drain() {
    const driver = this.connect();
    if (!driver || this.closed) return;
    try {
      if (!this.schemaDone) {
        for (const q of SCHEMA) await driver.executeQuery(q);
        this.schemaDone = true;
      }
      const next = this.db.prepare("SELECT id, project_id, op FROM memory_outbox WHERE failed IS NULL ORDER BY id LIMIT 1");
      for (let row = next.get() as { id: number; project_id: string; op: string } | undefined; row; row = next.get() as typeof row) {
        const op = JSON.parse(row.op) as Op;
        try {
          if (op.op === "scrub") await this.scrub(driver, row.project_id, op.term);
          else await driver.executeQuery(CYPHER[op.op], { ...op, projectId: row.project_id });
          this.db.prepare("DELETE FROM memory_outbox WHERE id = ?").run(row.id);
        } catch (err) {
          if (!isOpError(err)) throw err;
          // A write Neo4j rejects would block every write behind it: set it aside, visibly.
          log.warn(`memory: write ${row.id} (${op.op}) rejected by Neo4j: ${err instanceof Error ? err.message : err}`);
          this.db.prepare("UPDATE memory_outbox SET failed = ? WHERE id = ?").run(String(err instanceof Error ? err.message : err).slice(0, 500), row.id);
        }
      }
      if (!this.loaded) await this.load(driver);
      if (this.lastError) log.info("memory: Neo4j is back; queued writes sent.");
      this.lastError = "";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== this.lastError) log.warn(`memory: Neo4j unreachable, writes stay queued: ${msg}`);
      this.lastError = msg;
      this.loaded = false;
      if (!this.closed && !this.retry) (this.retry = setTimeout(() => ((this.retry = null), this.kick()), RETRY_MS)).unref();
    }
  }

  /** Masks a newly kept-out name in everything the project already stored. Cypher has no regex replace, so it's read, cleaned here and written back. */
  private async scrub(driver: Driver, projectId: string, term: string) {
    const ctx: MemoryContext = { redact: (x) => x, keepOut: [term] };
    const { records } = await driver.executeQuery(
      "MATCH (n) WHERE n.projectId = $p AND any(k IN ['text', 'title', 'name'] WHERE toLower(toString(n[k])) CONTAINS toLower($t)) RETURN elementId(n) AS id, n { .text, .title, .name } AS v",
      { p: projectId, t: term },
    );
    for (const r of records) {
      const v = r.get("v") as Record<string, string | null>;
      const next = Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string").map(([k, x]) => [k, cleanMemory(x as string, ctx)]));
      await driver.executeQuery("MATCH (n) WHERE elementId(n) = $id SET n += $next", { id: r.get("id"), next });
    }
  }

  /** Everything Neo4j holds, then what is still queued on top (newer than the graph). */
  private async load(driver: Driver) {
    const { records } = await driver.executeQuery("MATCH (e:LedgerEntry) RETURN e { .* } AS e");
    const queued = this.db.prepare("SELECT project_id, op FROM memory_outbox WHERE failed IS NULL ORDER BY id").all() as { project_id: string; op: string }[];
    this.entries.clear();
    for (const r of records) {
      const e = r.get("e") as LedgerEntry;
      this.entries.set(e.id, { ...e, taskId: e.taskId ?? null, supersededBy: e.supersededBy ?? null });
    }
    for (const q of queued) this.apply(JSON.parse(q.op), q.project_id);
    this.loaded = true;
  }
}

// ---------------------------------------------------------------- the machine's store

const VAULT_REF = "memory:neo4j";

/** Where Neo4j is: the compose environment first, else Settings → Memory (address in memory.json, password in the vault). */
export function neo4jConfig(env = process.env): Neo4jConfig | null {
  if (env.ARIMA_NEO4J_URL && env.ARIMA_NEO4J_PASSWORD) return { url: env.ARIMA_NEO4J_URL, user: env.ARIMA_NEO4J_USER || "neo4j", password: env.ARIMA_NEO4J_PASSWORD };
  const saved = readDoc<{ url?: string; user?: string }>(join(homeRoot(), "memory.json"));
  if (!saved?.url || !existsSync(join(homedir(), BRAND.homeDir, "vault.json"))) return null;
  const password = credentialsVault().get(VAULT_REF);
  return password ? { url: saved.url, user: saved.user || "neo4j", password } : null;
}

let shared: Neo4jMemory | null = null;
const scopes = new Map<string, () => Scope | undefined>();

/** Each loaded project tells memory where its scope is (in-scope IPs may be remembered). */
export const setMemoryScope = (projectId: string, scope: () => Scope | undefined) => void scopes.set(projectId, scope);

/** One store for every project on this machine, like the HQ database. */
export function memoryStore(): Neo4jMemory {
  if (!shared) {
    const db = hqDb();
    shared = new Neo4jMemory(db, () => neo4jConfig(), {
      templateTypes: (p) => projectTemplate(db, p)?.memoryTypes ?? [],
      context: (p) => ({ redact: (x) => redactor().redact(x), scope: scopes.get(p)?.() }),
    });
    void shared.flush();
  }
  return shared;
}

// ---------------------------------------------------------------- Settings → Memory

const settingsFile = () => join(homeRoot(), "memory.json");

/** What the browser sees: where Neo4j is and whether it answers. Never the password. */
export function memoryState(env = process.env): Omit<MemoryState, "backups"> {
  const fromEnv = !!(env.ARIMA_NEO4J_URL && env.ARIMA_NEO4J_PASSWORD);
  const saved = readDoc<{ url?: string; user?: string }>(settingsFile());
  const cfg = neo4jConfig(env);
  const st = shared?.status() ?? { state: cfg ? "offline" : "unconfigured", error: "connecting" };
  return {
    source: fromEnv ? "env" : saved?.url ? "settings" : null,
    url: cfg?.url ?? saved?.url ?? "",
    user: cfg?.user ?? saved?.user ?? "neo4j",
    passwordSet: !!cfg,
    extraction: extractionSettings(),
    status: st.state,
    ...(st.state === "offline" ? { error: st.error } : {}),
    queued: st.state === "online" ? st.queued : (hqDb().prepare("SELECT count(*) AS n FROM memory_outbox WHERE failed IS NULL").get() as { n: number }).n,
  };
}

type SavedSettings = { url?: string; user?: string; extract?: boolean; account?: string };

/** Whether Haiku reads finished tasks, and on which account. Off until the owner turns it on (it spends usage). */
export function extractionSettings(): ExtractionSettings {
  const saved = readDoc<SavedSettings>(settingsFile());
  return { enabled: saved?.extract === true, account: saved?.account || "default" };
}

export function saveExtractionSettings(input: Partial<ExtractionSettings>, isAnthropicAccount: (id: string) => boolean) {
  const account = String(input?.account ?? "default").trim() || "default";
  if (account !== "default" && !isAnthropicAccount(account)) throw new Error(`"${account}" isn't an Anthropic account. Use your Claude Code sign-in or add an Anthropic key in Settings → Accounts.`);
  writeDoc(settingsFile(), { ...readDoc<SavedSettings>(settingsFile()), extract: input?.enabled === true, account });
}

/** Saves the address (memory.json) and password (vault), then reconnects. Refused while compose sets them. */
export function saveMemorySettings(input: MemoryInput, env = process.env) {
  if (env.ARIMA_NEO4J_URL && env.ARIMA_NEO4J_PASSWORD) throw new Error("ARIMA_NEO4J_URL and ARIMA_NEO4J_PASSWORD are set (compose); change them in .env instead.");
  const url = String(input?.url ?? "").trim();
  if (!/^(bolt|neo4j)(\+s|\+ssc)?:\/\/[\w.-]+(:\d{1,5})?$/.test(url)) throw new Error("The address looks like bolt://127.0.0.1:7687.");
  const user = String(input?.user ?? "").trim() || "neo4j";
  if (!/^[\w.-]{1,64}$/.test(user)) throw new Error("That isn't a Neo4j user name.");
  const password = String(input?.password ?? "");
  if (password && password.length < 8) throw new Error("Neo4j passwords are at least 8 characters.");
  if (!password && !credentialsVault().get(VAULT_REF)) throw new Error("Enter the Neo4j password.");
  if (password) credentialsVault().set(VAULT_REF, password);
  writeDoc(settingsFile(), { ...readDoc<object>(settingsFile()), url, user });
  return memoryStore().flush();
}
