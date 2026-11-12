// SPDX-License-Identifier: AGPL-3.0-or-later
// The memory interface (docs/core-model.md sections 7 and 8). Phase 1 keeps the ledgers in SQLite;
// Phase 2 moves them into Neo4j with recall, related and remember, and callers don't change.
//
// Task ledger: the lead's facts, guesses and plan. Progress ledger: HQ's stall checks and replans.
// Entries are never edited: a revision is a new entry, and the old one points at it.

import type { DatabaseSync } from "node:sqlite";
import { LEDGER_KINDS, type LedgerEntry, type LedgerKind, type LedgerName } from "../src/data/model";
import { tx } from "./lib/docs";

export interface MemoryStore {
  addLedger(e: Omit<LedgerEntry, "id" | "at" | "supersededBy">): LedgerEntry;
  /** Replaces an entry's text with a new entry; the old one stays, marked superseded. */
  reviseLedger(projectId: string, id: number, text: string, by: string): LedgerEntry;
  /** Current entries (superseded ones left out), oldest first. */
  ledger(projectId: string, opts?: { taskId?: string | null; ledger?: LedgerName }): LedgerEntry[];
  /** Removes everything the project remembered. */
  forgetProject(projectId: string): void;
}

/** What the lead may write to its task ledger; stall and replan entries are HQ's. */
export const LEAD_KINDS = ["fact", "guess", "plan", "note"] as const satisfies readonly LedgerKind[];

interface Row {
  id: number; project_id: string; task_id: string | null; ledger: LedgerName; kind: LedgerKind;
  text: string; by: string; at: number; superseded_by: number | null;
}
const entry = (r: Row): LedgerEntry => ({
  id: r.id, projectId: r.project_id, taskId: r.task_id, ledger: r.ledger, kind: r.kind,
  text: r.text, by: r.by, at: new Date(r.at).toISOString(), supersededBy: r.superseded_by,
});
const MAX_TEXT = 2000;

export class SqliteMemory implements MemoryStore {
  constructor(private db: DatabaseSync) {}

  addLedger(e: Omit<LedgerEntry, "id" | "at" | "supersededBy">): LedgerEntry {
    if (!(LEDGER_KINDS as readonly string[]).includes(e.kind)) throw new Error(`Ledger kinds are ${LEDGER_KINDS.join(", ")}.`);
    const text = e.text.trim().slice(0, MAX_TEXT);
    if (!text) throw new Error("A ledger entry needs text.");
    const r = this.db
      .prepare("INSERT INTO ledger (project_id, task_id, ledger, kind, text, by, at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *")
      .get(e.projectId, e.taskId, e.ledger, e.kind, text, e.by, Date.now()) as unknown as Row;
    return entry(r);
  }

  reviseLedger(projectId: string, id: number, text: string, by: string): LedgerEntry {
    const old = this.db.prepare("SELECT * FROM ledger WHERE project_id = ? AND id = ?").get(projectId, id) as unknown as Row | undefined;
    if (!old) throw new Error(`No ledger entry ${id}.`);
    if (old.superseded_by !== null) throw new Error(`Entry ${id} was already revised (see ${old.superseded_by}).`);
    let next!: LedgerEntry;
    tx(this.db, () => {
      next = this.addLedger({ projectId, taskId: old.task_id, ledger: old.ledger, kind: old.kind, text, by });
      this.db.prepare("UPDATE ledger SET superseded_by = ? WHERE id = ?").run(next.id, id);
    });
    return next;
  }

  ledger(projectId: string, opts: { taskId?: string | null; ledger?: LedgerName } = {}): LedgerEntry[] {
    const where = ["project_id = ?", "superseded_by IS NULL"];
    const args: (string | null)[] = [projectId];
    if (opts.ledger) (where.push("ledger = ?"), args.push(opts.ledger));
    if (opts.taskId !== undefined) where.push(opts.taskId === null ? "task_id IS NULL" : (args.push(opts.taskId), "task_id = ?"));
    return (this.db.prepare(`SELECT * FROM ledger WHERE ${where.join(" AND ")} ORDER BY id`).all(...args) as unknown as Row[]).map(entry);
  }

  forgetProject(projectId: string) {
    // Revisions point at newer rows: clear the links first so the delete never trips the foreign key.
    tx(this.db, () => {
      this.db.prepare("UPDATE ledger SET superseded_by = NULL WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM ledger WHERE project_id = ?").run(projectId);
    });
  }
}
