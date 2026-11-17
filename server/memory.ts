// SPDX-License-Identifier: AGPL-3.0-or-later
// The memory interface (docs/core-model.md sections 7 and 8, docs/memory-core.md), in the HQ database.
//
// Task ledger: the lead's facts, guesses and plan. Progress ledger: HQ's stall checks and replans.
// Entries are never edited: a revision is a new entry, and the old one points at it.
//
// Memories (decisions, lessons, dead ends, a template's own types) are rows with an FTS5 index for recall.
// "Related" walks a small graph that the tables already hold: a memory links to its task and the files it
// is about; a task links to the files it touched and the tasks it built on (its summary). Two hops at most.

import type { DatabaseSync } from "node:sqlite";
import { CORE_MEMORY_TYPES, LEDGER_KINDS, type LedgerEntry, type LedgerName, type LedgerKind, type Memory, type TaskSummary } from "../src/data/model";
import type { MemoryState, Scope } from "../src/data/types";
import { redactor } from "./credentials/registry";
import { cleanMemory, saysSomething, type MemoryContext } from "./memoryClean";
import type { ExtractionSettings } from "./memoryExtract";
import { hqDb } from "./lib/db";
import { readDoc, tx, writeDoc } from "./lib/docs";
import { homeRoot } from "./paths";
import { join } from "node:path";
import { projectTemplate } from "./templates";
import { importLegacyMemory } from "./memoryImport";
import { listBackups } from "./backups";

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
  /** Memories matching the words of `query`, certified first. */
  recall(projectId: string, query: string, opts?: { limit?: number; types?: string[] }): Promise<Memory[]>;
  /** Memories linked to a task, a file or component, or another memory, within `depth` hops. */
  related(projectId: string, ref: { taskId?: string; path?: string; memoryId?: string }, opts?: { depth?: 1 | 2; limit?: number }): Promise<Memory[]>;
  /** Keeps a finished task's summary: what it built on and the files it touched link it to memories. */
  summarise(s: TaskSummary): void;
  summary(projectId: string, taskId: string): TaskSummary | null;
  /** Keeps a name (a person, a handle) out of the project's memory, and scrubs it from what is stored. */
  keepOut(projectId: string, term: string, by: string): void;
  /** The user's check: certified memories rank first and never fade; rejected ones are deleted. */
  certify(projectId: string, ids: string[], by: string): void;
  reject(projectId: string, ids: string[]): void;
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
export const STOPWORDS = new Set(
  "the and for with that this from into was were are has have had not but its when then than also only after before about there their they them what which who how why can could should would will does did our your you all any each more most some such too very just over under again once here where while".split(" "),
);

const MAX_ABOUT = 20;
const LIMIT = (n: number | undefined) => Math.min(Math.max(1, Math.trunc(n ?? 10)), 50);

type MemoryRow = {
  id: string; project_id: string; type: string; text: string; task_id: string | null; source: string; by: string;
  created_at: string; last_used_at: string; certified: number; certified_by: string | null; about: string | null;
};
const SELECT_MEMORY = `SELECT m.id, m.project_id, m.type, m.text, m.task_id, m.source, m.by, m.created_at, m.last_used_at, m.certified, m.certified_by,
  (SELECT json_group_array(path) FROM (SELECT path FROM memory_about a WHERE a.memory_id = m.id ORDER BY path)) AS about FROM memories m`;
const toMemory = (r: MemoryRow): Memory => ({
  id: r.id,
  projectId: r.project_id,
  type: r.type,
  text: r.text,
  taskId: r.task_id,
  about: r.about ? (JSON.parse(r.about) as string[]) : [],
  certified: r.certified === 1,
  certifiedBy: r.certified_by,
  source: r.source as Memory["source"],
  by: r.by,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
});
type LedgerRow = { id: number; project_id: string; task_id: string | null; ledger: string; kind: string; text: string; by: string; at: string; superseded_by: number | null };
const toEntry = (r: LedgerRow): LedgerEntry => ({
  id: r.id, projectId: r.project_id, taskId: r.task_id, ledger: r.ledger as LedgerName, kind: r.kind as LedgerKind, text: r.text, by: r.by, at: r.at, supersededBy: r.superseded_by,
});
/** A "task" or "path" node of the related-graph, or a memory id. */
type Node = `t:${string}` | `c:${string}` | `m:${string}`;

export class SqliteMemory implements MemoryStore {
  /** Told about every new memory (the project files it for the user's check). */
  private rememberListeners = new Set<(m: Memory) => void>();
  onRemember(fn: (m: Memory) => void): () => void {
    this.rememberListeners.add(fn);
    return () => this.rememberListeners.delete(fn);
  }

  constructor(
    private db: DatabaseSync,
    private project: {
      /** The project template's own memory types (beyond the core ones). */
      templateTypes?: (projectId: string) => string[];
      /** The vault's redactor and the project's scope, for cleanMemory. */
      context?: (projectId: string) => Omit<MemoryContext, "keepOut">;
    } = {},
  ) {}

  // ---------------------------------------------------------------- ledgers

  addLedger(e: Omit<LedgerEntry, "id" | "at" | "supersededBy">): LedgerEntry {
    let out!: LedgerEntry;
    tx(this.db, () => (out = this.add(e)));
    return out;
  }

  reviseLedger(projectId: string, id: number, text: string, by: string): LedgerEntry {
    const old = this.db.prepare("SELECT * FROM ledger_entries WHERE id = ? AND project_id = ?").get(id, projectId) as LedgerRow | undefined;
    if (!old) throw new Error(`No ledger entry ${id}.`);
    if (old.superseded_by !== null) throw new Error(`Entry ${id} was already revised (see ${old.superseded_by}).`);
    let next!: LedgerEntry;
    tx(this.db, () => {
      next = this.add({ projectId, taskId: old.task_id, ledger: old.ledger as LedgerName, kind: old.kind as LedgerKind, text, by });
      this.db.prepare("UPDATE ledger_entries SET superseded_by = ? WHERE id = ?").run(next.id, id);
    });
    return next;
  }

  ledger(projectId: string, opts: { taskId?: string | null; ledger?: LedgerName } = {}): LedgerEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM ledger_entries WHERE project_id = ? AND superseded_by IS NULL AND (? IS NULL OR ledger = ?)
         AND (? = 0 OR task_id IS ?) ORDER BY id`,
      )
      .all(projectId, opts.ledger ?? null, opts.ledger ?? null, opts.taskId === undefined ? 0 : 1, opts.taskId ?? null) as LedgerRow[];
    return rows.map(toEntry);
  }

  private add(e: Omit<LedgerEntry, "id" | "at" | "supersededBy">): LedgerEntry {
    if (!(LEDGER_KINDS as readonly string[]).includes(e.kind)) throw new Error(`Ledger kinds are ${LEDGER_KINDS.join(", ")}.`);
    if (!e.text.trim()) throw new Error("A ledger entry needs text.");
    const text = this.cleaner(e.projectId)(e.text.trim()).slice(0, MAX_TEXT);
    const { id } = this.db.prepare("INSERT INTO memory_ids DEFAULT VALUES RETURNING id").get() as { id: number };
    const entry: LedgerEntry = { id, projectId: e.projectId, taskId: e.taskId, ledger: e.ledger, kind: e.kind, text, by: e.by, at: new Date().toISOString(), supersededBy: null };
    this.db
      .prepare("INSERT INTO ledger_entries (id, project_id, task_id, ledger, kind, text, by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, entry.projectId, entry.taskId, entry.ledger, entry.kind, text, entry.by, entry.at);
    return entry;
  }

  /** Removes everything the project remembered (ledgers, memories). Summaries and keep-out names go with the project's tables. */
  forgetProject(projectId: string) {
    tx(this.db, () => {
      for (const t of ["ledger_entries", "memory_about", "memories"]) this.db.prepare(`DELETE FROM ${t} WHERE project_id = ?`).run(projectId);
    });
  }

  // ---------------------------------------------------------------- memories

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
      const { id: n } = this.db.prepare("INSERT INTO memory_ids DEFAULT VALUES RETURNING id").get() as { id: number };
      const at = new Date().toISOString();
      out = { id: `M-${n}`, projectId: input.projectId, type: input.type, text, taskId: input.taskId ?? null, about: [...about].sort(), source: input.source ?? "remember", by: input.by,
        createdAt: at, lastUsedAt: at, certified: false, certifiedBy: null };
      this.db
        .prepare("INSERT INTO memories (id, project_id, type, text, task_id, source, by, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(out.id, out.projectId, out.type, text, out.taskId, out.source, out.by, at, at);
      const link = this.db.prepare("INSERT OR IGNORE INTO memory_about (project_id, memory_id, path) VALUES (?, ?, ?)");
      for (const p of about) link.run(out.projectId, out.id, p);
    });
    for (const fn of this.rememberListeners) {
      try {
        fn(out);
      } catch {
        /* a listener's failure never undoes the memory */
      }
    }
    return out;
  }

  async recall(projectId: string, query: string, opts: { limit?: number; types?: string[] } = {}): Promise<Memory[]> {
    // Words only: FTS5's query syntax (quotes, NEAR, column:) never reaches the index from an agent.
    // Filler words ("the", "with") would match nearly every memory: only the words that carry meaning are searched.
    const words = [...new Set(String(query).toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? [])].filter((w) => !STOPWORDS.has(w)).slice(0, 20);
    if (!words.length) return [];
    const types = opts.types?.length ? JSON.stringify(opts.types) : null;
    const rows = this.db
      .prepare(
        `${SELECT_MEMORY} JOIN memory_text ON memory_text.rowid = m.n
         WHERE memory_text MATCH ? AND m.project_id = ? AND m.superseded_by IS NULL AND (? IS NULL OR m.type IN (SELECT value FROM json_each(?)))
         ORDER BY m.certified DESC, bm25(memory_text), m.created_at DESC, m.id LIMIT ?`,
      )
      .all(words.map((w) => `"${w}"`).join(" OR "), projectId, types, types, LIMIT(opts.limit)) as MemoryRow[];
    return this.used(rows.map(toMemory));
  }

  async related(projectId: string, ref: { taskId?: string; path?: string; memoryId?: string }, opts: { depth?: 1 | 2; limit?: number } = {}): Promise<Memory[]> {
    const start: Node | null = ref.taskId ? `t:${ref.taskId}` : ref.path ? `c:${ref.path}` : ref.memoryId ? `m:${ref.memoryId}` : null;
    if (!start) return [];
    const seen = new Set<Node>([start]);
    let frontier: Node[] = [start];
    for (let hop = 0; hop < (opts.depth === 1 ? 1 : 2); hop++) {
      const next: Node[] = [];
      for (const node of frontier) for (const n of this.neighbours(projectId, node)) if (!seen.has(n)) (seen.add(n), next.push(n));
      frontier = next;
    }
    const ids = [...seen].filter((n) => n !== start && n.startsWith("m:")).map((n) => n.slice(2));
    if (!ids.length) return [];
    const rows = this.db
      .prepare(`${SELECT_MEMORY} WHERE m.project_id = ? AND m.superseded_by IS NULL AND m.id IN (SELECT value FROM json_each(?)) ORDER BY m.certified DESC, m.created_at DESC, m.id LIMIT ?`)
      .all(projectId, JSON.stringify(ids), LIMIT(opts.limit)) as MemoryRow[];
    return this.used(rows.map(toMemory));
  }

  /** One hop: memory ↔ its task and files; task ↔ its files (summary) and the tasks it built on, either way. */
  private neighbours(p: string, node: Node): Node[] {
    const key = node.slice(2);
    const col = (sql: string, ...args: (string | null)[]) => (this.db.prepare(sql).all(...args) as { v: string }[]).map((r) => r.v);
    if (node.startsWith("m:")) {
      const m = this.db.prepare("SELECT task_id FROM memories WHERE project_id = ? AND id = ?").get(p, key) as { task_id: string | null } | undefined;
      return [...(m?.task_id ? [`t:${m.task_id}` as Node] : []), ...col("SELECT path AS v FROM memory_about WHERE memory_id = ?", key).map((v) => `c:${v}` as Node)];
    }
    if (node.startsWith("c:"))
      return [
        ...col("SELECT memory_id AS v FROM memory_about WHERE project_id = ? AND path = ?", p, key).map((v) => `m:${v}` as Node),
        ...col("SELECT s.task_id AS v FROM task_summaries s, json_each(s.body, '$.files') f WHERE s.project_id = ? AND f.value = ?", p, key).map((v) => `t:${v}` as Node),
      ];
    return [
      ...col("SELECT id AS v FROM memories WHERE project_id = ? AND task_id = ?", p, key).map((v) => `m:${v}` as Node),
      ...col("SELECT f.value AS v FROM task_summaries s, json_each(s.body, '$.files') f WHERE s.project_id = ? AND s.task_id = ?", p, key).map((v) => `c:${v}` as Node),
      ...col("SELECT n.value AS v FROM task_summaries s, json_each(s.body, '$.needs') n WHERE s.project_id = ? AND s.task_id = ?", p, key).map((v) => `t:${v}` as Node),
      ...col("SELECT s.task_id AS v FROM task_summaries s, json_each(s.body, '$.needs') n WHERE s.project_id = ? AND n.value = ?", p, key).map((v) => `t:${v}` as Node),
    ];
  }

  /** Memories handed to an agent count as used: unused, uncertified ones fade after 30 days. */
  private used(list: Memory[]): Memory[] {
    if (list.length) this.db.prepare("UPDATE memories SET last_used_at = ? WHERE id IN (SELECT value FROM json_each(?))").run(new Date().toISOString(), JSON.stringify(list.map((m) => m.id)));
    return list;
  }

  // ---------------------------------------------------------------- task summaries

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
    this.db
      .prepare("INSERT INTO task_summaries (project_id, task_id, body, finished_at) VALUES (?, ?, ?, ?) ON CONFLICT (project_id, task_id) DO UPDATE SET body = excluded.body, finished_at = excluded.finished_at, extracted_at = NULL, extract_attempts = 0, extract_error = NULL")
      .run(s.projectId, s.taskId, JSON.stringify(s), Date.parse(s.finishedAt));
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

  // ---------------------------------------------------------------- the user's check, tidying

  certify(projectId: string, ids: string[], by: string) {
    this.db.prepare("UPDATE memories SET certified = 1, certified_by = ? WHERE project_id = ? AND id IN (SELECT value FROM json_each(?))").run(by, projectId, JSON.stringify([...new Set(ids)]));
  }

  /** Only an uncertified memory can be rejected (deleted); a certified one stays until forget project. */
  reject(projectId: string, ids: string[]) {
    tx(this.db, () => {
      const gone = (this.db.prepare("DELETE FROM memories WHERE project_id = ? AND certified = 0 AND id IN (SELECT value FROM json_each(?)) RETURNING id").all(projectId, JSON.stringify(ids)) as { id: string }[]).map((r) => r.id);
      this.db.prepare("DELETE FROM memory_about WHERE memory_id IN (SELECT value FROM json_each(?))").run(JSON.stringify(gone));
    });
  }

  /** Certified memories of `type` about any of `about` (a new one may contradict them). */
  async certifiedAbout(projectId: string, type: string, about: string[]): Promise<Memory[]> {
    if (!about.length) return [];
    const rows = this.db
      .prepare(`${SELECT_MEMORY} WHERE m.project_id = ? AND m.type = ? AND m.certified = 1 AND m.superseded_by IS NULL
        AND m.id IN (SELECT memory_id FROM memory_about WHERE path IN (SELECT value FROM json_each(?))) ORDER BY m.created_at`)
      .all(projectId, type, JSON.stringify(about)) as MemoryRow[];
    return rows.map(toMemory);
  }

  /** The project's current memories (not merged away), for consolidation and the user's check. */
  async memories(projectId: string): Promise<Memory[]> {
    return (this.db.prepare(`${SELECT_MEMORY} WHERE m.project_id = ? AND m.superseded_by IS NULL ORDER BY m.created_at, m.id`).all(projectId) as MemoryRow[]).map(toMemory);
  }

  /** Folds `drop` into `keep` (consolidation). `text`, if given, replaces keep's text; a certified memory is never dropped. */
  merge(projectId: string, keep: string, drop: string, text: string | null) {
    const t = text === null ? null : this.cleaner(projectId)(text.trim()).slice(0, MAX_TEXT);
    if (t !== null && !saysSomething(t)) throw new Error("The merged text says nothing once secrets and personal data are taken out.");
    tx(this.db, () => {
      const one = (id: string) => this.db.prepare("SELECT task_id, last_used_at, certified, superseded_by FROM memories WHERE project_id = ? AND id = ?").get(projectId, id) as
        { task_id: string | null; last_used_at: string; certified: number; superseded_by: string | null } | undefined;
      const k = one(keep);
      const l = one(drop);
      if (!k || !l || k.superseded_by || l.superseded_by || l.certified) return;
      this.db.prepare("UPDATE memories SET superseded_by = ? WHERE id = ?").run(keep, drop);
      // The kept one takes over the dropped one's files, and its task when it has none of its own.
      // shortcut: one task per memory, so a dropped memory's task is lost when both have one; add a link table if related() misses them.
      this.db
        .prepare("UPDATE memories SET text = coalesce(?, text), task_id = coalesce(task_id, ?), last_used_at = max(last_used_at, ?) WHERE id = ?")
        .run(t, l.task_id, l.last_used_at, keep);
      this.db.prepare("INSERT OR IGNORE INTO memory_about (project_id, memory_id, path) SELECT project_id, ?, path FROM memory_about WHERE memory_id = ?").run(keep, drop);
    });
  }

  /** Deletes uncertified memories nobody recalled or used since `before`. Returns how many went. */
  async fade(before: Date): Promise<number> {
    let n = 0;
    tx(this.db, () => {
      const gone = (this.db.prepare("DELETE FROM memories WHERE certified = 0 AND last_used_at < ? RETURNING id").all(before.toISOString()) as { id: string }[]).map((r) => r.id);
      this.db.prepare("DELETE FROM memory_about WHERE memory_id IN (SELECT value FROM json_each(?))").run(JSON.stringify(gone));
      n = gone.length;
    });
    return n;
  }

  /** Every project with memories. */
  async memoryProjects(): Promise<string[]> {
    return (this.db.prepare("SELECT DISTINCT project_id AS p FROM memories").all() as { p: string }[]).map((r) => r.p);
  }

  // ---------------------------------------------------------------- keep-out names

  /** Names (people, handles) never to keep, in this project. Adding one also scrubs what is already stored. */
  keepOut(projectId: string, term: string, by: string) {
    const t = String(term ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
    if (t.length < 2) throw new Error("Give a name of at least 2 characters.");
    tx(this.db, () => {
      this.db.prepare("INSERT INTO memory_keep_out (project_id, term, by, at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING").run(projectId, t, by, Date.now());
      scrub(this.db, projectId, t);
      const clean = this.cleaner(projectId);
      for (const r of this.db.prepare("SELECT task_id, body FROM task_summaries WHERE project_id = ?").all(projectId) as { task_id: string; body: string }[]) {
        const b = JSON.parse(r.body) as TaskSummary;
        const next = { ...b, title: clean(b.title), description: b.description && clean(b.description), doneWhen: b.doneWhen && clean(b.doneWhen), note: b.note && clean(b.note), ledger: b.ledger.map((e) => ({ ...e, text: clean(e.text) })) };
        if (JSON.stringify(next) !== r.body) this.db.prepare("UPDATE task_summaries SET body = ? WHERE project_id = ? AND task_id = ?").run(JSON.stringify(next), projectId, r.task_id);
      }
    });
  }

  keptOut(projectId: string): string[] {
    return (this.db.prepare("SELECT term FROM memory_keep_out WHERE project_id = ? ORDER BY term").all(projectId) as { term: string }[]).map((r) => r.term);
  }

  private cleaner(projectId: string): (text: string) => string {
    const ctx: MemoryContext = { redact: (x) => x, ...this.project.context?.(projectId), keepOut: this.keptOut(projectId) };
    return (text) => cleanMemory(text, ctx);
  }
}

/** Masks a kept-out name in the project's memories, their files and its ledgers. */
export function scrub(db: DatabaseSync, projectId: string, term: string) {
  const clean = (x: string) => cleanMemory(x, { redact: (v) => v, keepOut: [term] });
  const like = `%${term.toLowerCase()}%`;
  for (const r of db.prepare("SELECT id, text FROM memories WHERE project_id = ? AND lower(text) LIKE ?").all(projectId, like) as { id: string; text: string }[])
    db.prepare("UPDATE memories SET text = ? WHERE id = ?").run(clean(r.text), r.id);
  for (const r of db.prepare("SELECT id, text FROM ledger_entries WHERE project_id = ? AND lower(text) LIKE ?").all(projectId, like) as { id: number; text: string }[])
    db.prepare("UPDATE ledger_entries SET text = ? WHERE id = ?").run(clean(r.text), r.id);
  for (const r of db.prepare("SELECT memory_id, path FROM memory_about WHERE project_id = ? AND lower(path) LIKE ?").all(projectId, like) as { memory_id: string; path: string }[])
    db.prepare("DELETE FROM memory_about WHERE memory_id = ? AND path = ?").run(r.memory_id, r.path);
}

// ---------------------------------------------------------------- the machine's store

let shared: SqliteMemory | null = null;
const scopes = new Map<string, () => Scope | undefined>();

/** Each loaded project tells memory where its scope is (in-scope IPs may be remembered). */
export const setMemoryScope = (projectId: string, scope: () => Scope | undefined) => void scopes.set(projectId, scope);

/** One store for every project on this machine, in the HQ database. */
export function memoryStore(): SqliteMemory {
  if (!shared) {
    const db = hqDb();
    importLegacyMemory(db);
    shared = new SqliteMemory(db, {
      templateTypes: (p) => projectTemplate(db, p)?.memoryTypes ?? [],
      context: (p) => ({ redact: (x) => redactor().redact(x), scope: scopes.get(p)?.() }),
    });
  }
  return shared;
}

// ---------------------------------------------------------------- Settings → Memory

const settingsFile = () => join(homeRoot(), "memory.json");

/** What the browser sees: extraction, and HQ's nightly backups. */
export function memoryState(): Omit<MemoryState, "keepOut"> {
  return { extraction: extractionSettings(), backups: listBackups() };
}

/** Whether Haiku reads finished tasks, and on which account. Off until the owner turns it on (it spends usage). */
export function extractionSettings(): ExtractionSettings {
  const saved = readDoc<{ extract?: boolean; account?: string }>(settingsFile());
  return { enabled: saved?.extract === true, account: saved?.account || "default" };
}

export function saveExtractionSettings(input: Partial<ExtractionSettings>, isAnthropicAccount: (id: string) => boolean) {
  const account = String(input?.account ?? "default").trim() || "default";
  if (account !== "default" && !isAnthropicAccount(account)) throw new Error(`"${account}" isn't an Anthropic account. Use your Claude Code sign-in or add an Anthropic key in Settings → Accounts.`);
  writeDoc(settingsFile(), { extract: input?.enabled === true, account });
}
