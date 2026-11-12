// SPDX-License-Identifier: AGPL-3.0-or-later
// Usage events (docs/core-model.md section 6): every model run, with its account, model, tokens and
// estimated cost. Agents' CLIs are metered from their logs: each read records only what is new since
// the last mark, per model. One-shot runs (ModelRunner, step 8) record theirs directly.
// Spend caps and per-account totals (Phase 3) sum this table; nothing else keeps a token count.

import type { DatabaseSync } from "node:sqlite";
import type { UsageEvent } from "../src/data/model";
import type { Tokens } from "../src/data/types";
import { tx } from "./lib/docs";
import { estimateCost } from "./prices";
import { diff, type ByModel } from "./usage";

const busy = (t: Tokens) => t.input + t.cached + t.output > 0;

export function recordEvent(db: DatabaseSync, e: Omit<UsageEvent, "costUsd" | "at"> & { at?: string }): UsageEvent {
  const event: UsageEvent = { ...e, at: e.at ?? new Date().toISOString(), costUsd: estimateCost(e.model, e.tokens) };
  db.prepare(
    `INSERT INTO usage_events (at, project_id, task_id, agent_id, source, account, provider, cli, model, input, cached, output, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    Date.parse(event.at), event.projectId, event.taskId, event.agentId, event.source, event.account, event.provider, event.cli, event.model,
    event.tokens.input, event.tokens.cached, event.tokens.output, event.costUsd,
  );
  return event;
}

/**
 * Turns an agent's meter totals into events: for each model, what grew since the last mark.
 * The mark always moves to the new totals, so logs that shrink (rotated, pruned) restart the count
 * instead of hiding new work. Returns the events written.
 */
export function recordMeter(
  db: DatabaseSync,
  who: Pick<UsageEvent, "projectId" | "agentId" | "taskId" | "account" | "provider" | "cli">,
  totals: ByModel,
): UsageEvent[] {
  const out: UsageEvent[] = [];
  const mark = db.prepare("SELECT input, cached, output FROM usage_marks WHERE project_id = ? AND agent_id = ? AND model = ?");
  const move = db.prepare(
    `INSERT INTO usage_marks (project_id, agent_id, model, input, cached, output) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, agent_id, model) DO UPDATE SET input = excluded.input, cached = excluded.cached, output = excluded.output`,
  );
  tx(db, () => {
    for (const [model, now] of Object.entries(totals)) {
      const before = mark.get(who.projectId, who.agentId, model) as Tokens | undefined;
      const delta = before ? diff(now, before) : now;
      if (busy(delta)) out.push(recordEvent(db, { ...who, source: "agent", model, tokens: delta }));
      move.run(who.projectId, who.agentId, model, now.input, now.cached, now.output);
    }
  });
  return out;
}

/** Tokens per task, from the events recorded while it was an agent's current task. */
export function taskUsage(db: DatabaseSync, projectId: string): Map<string, Tokens> {
  const rows = db
    .prepare("SELECT task_id, SUM(input) AS input, SUM(cached) AS cached, SUM(output) AS output FROM usage_events WHERE project_id = ? AND task_id IS NOT NULL GROUP BY task_id")
    .all(projectId) as { task_id: string; input: number; cached: number; output: number }[];
  return new Map(rows.map((r) => [r.task_id, { input: r.input, cached: r.cached, output: r.output }]));
}

/** Tokens and estimated cost since `sinceMs`, by project or by account. Costs of unpriced models are left out and counted. */
export function spend(db: DatabaseSync, by: { projectId: string } | { account: string }, sinceMs = 0) {
  const [col, val] = "projectId" in by ? ["project_id", by.projectId] : ["account", by.account];
  return db
    .prepare(
      `SELECT COALESCE(SUM(input), 0) AS input, COALESCE(SUM(cached), 0) AS cached, COALESCE(SUM(output), 0) AS output,
              COALESCE(SUM(cost_usd), 0) AS costUsd, COUNT(*) - COUNT(cost_usd) AS unpriced
       FROM usage_events WHERE ${col} = ? AND at >= ?`,
    )
    .get(val, sinceMs) as { input: number; cached: number; output: number; costUsd: number; unpriced: number };
}
