// SPDX-License-Identifier: AGPL-3.0-or-later
// Factory metrics (docs/factory.md section 3): read-only sums over tables HQ already keeps. A task counts as finished
// in a window when its history (task_events) says it became done then; tasks made before that history have none and
// aren't counted. Cycle time needs the task's creation row, so only tasks that recorded a template version have one.

import type { DatabaseSync } from "node:sqlite";
import type { Cost, FactoryMetrics, MetricsReport, VersionMetrics } from "../src/data/metrics";

export interface Window {
  since: number;
  until: number;
}

/** One finished task with what the metrics need. */
interface Done {
  id: string;
  doneAt: number;
  pr: boolean;
  templateId: string | null;
  templateVersion: number | null;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const per = (n: number, d: number) => (d ? n / d : null);

/** Tasks whose last move to done falls in the window. */
export function finishedTasks(db: DatabaseSync, projectId: string, w: Window): Done[] {
  return (
    db
      .prepare(
        `SELECT t.id, d.done_at, t.pr_number, t.template_id, t.template_version FROM tasks t
         JOIN (SELECT task_id, MAX(at) AS done_at FROM task_events WHERE project_id = ? AND status = 'done' GROUP BY task_id) d ON d.task_id = t.id
         WHERE t.project_id = ? AND t.status = 'done' AND d.done_at >= ? AND d.done_at < ?`,
      )
      .all(projectId, projectId, w.since, w.until) as { id: string; done_at: number; pr_number: number | null; template_id: string | null; template_version: number | null }[]
  ).map((r) => ({ id: r.id, doneAt: r.done_at, pr: r.pr_number !== null, templateId: r.template_id, templateVersion: r.template_version }));
}

/** Everything spent on these tasks (all of it, not only inside the window), divided by how many there are. */
export function costPer(db: DatabaseSync, projectId: string, ids: string[]): Cost | null {
  if (!ids.length) return null;
  const r = db
    .prepare(
      `SELECT SUM(input + output) AS tokens, SUM(cost_usd) AS usd FROM usage_events
       WHERE project_id = ? AND task_id IN (SELECT value FROM json_each(?))`,
    )
    .get(projectId, JSON.stringify(ids)) as { tokens: number | null; usd: number | null };
  return { usd: r.usd === null ? null : r.usd / ids.length, tokens: (r.tokens ?? 0) / ids.length };
}

/** Median created → done and first in-progress → done. Tasks without a version predate the history: unknown. */
export function cycleTime(db: DatabaseSync, projectId: string, done: Done[]): FactoryMetrics["cycle"] {
  const first = db.prepare("SELECT MIN(at) AS at FROM task_events WHERE project_id = ? AND task_id = ?");
  const started = db.prepare("SELECT MIN(at) AS at FROM task_events WHERE project_id = ? AND task_id = ? AND status = 'in-progress'");
  const created: number[] = [];
  const worked: number[] = [];
  let unknown = 0;
  for (const t of done) {
    if (t.templateVersion === null) {
      unknown++;
      continue;
    }
    created.push(t.doneAt - (first.get(projectId, t.id) as { at: number }).at);
    const s = (started.get(projectId, t.id) as { at: number | null }).at;
    if (s !== null) worked.push(t.doneAt - s);
  }
  return { created: median(created), started: median(worked), unknown };
}

export function rework(db: DatabaseSync, projectId: string, ids: string[]): FactoryMetrics["rework"] {
  const r = db
    .prepare("SELECT COUNT(*) AS n FROM gate_events WHERE project_id = ? AND state = 'failed' AND task_id IN (SELECT value FROM json_each(?))")
    .get(projectId, JSON.stringify(ids)) as { n: number };
  return { failed: r.n, perTask: per(r.n, ids.length) };
}

export function ledgerCount(db: DatabaseSync, projectId: string, kind: "stall" | "replan", w: Window): number {
  const r = db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE project_id = ? AND kind = ? AND at >= ? AND at < ?").get(projectId, kind, w.since, w.until) as { n: number };
  return r.n;
}

/**
 * Times the owner stepped in: gate events they recorded, Action items they answered, and messages they sent agents
 * (`ownerMessages`: their times, from the project's message history, which keeps the last 100).
 */
export function interventions(db: DatabaseSync, projectId: string, w: Window, ownerMessages: number[]): FactoryMetrics["interventions"] {
  const n = (sql: string) => (db.prepare(sql).get(projectId, w.since, w.until) as { n: number }).n;
  const gates = n("SELECT COUNT(*) AS n FROM gate_events WHERE project_id = ? AND by_kind = 'user' AND at >= ? AND at < ?");
  const answers = n("SELECT COUNT(*) AS n FROM action_answers WHERE project_id = ? AND at >= ? AND at < ?");
  const messages = ownerMessages.filter((at) => at >= w.since && at < w.until).length;
  return { gates, answers, messages, total: gates + answers + messages };
}

export function factoryMetrics(db: DatabaseSync, projectId: string, w: Window, ownerMessages: number[] = []): FactoryMetrics {
  const done = finishedTasks(db, projectId, w);
  const ids = done.map((t) => t.id);
  const prs = done.filter((t) => t.pr).map((t) => t.id);
  return {
    finished: done.length,
    merged: prs.length,
    costPerTask: costPer(db, projectId, ids),
    costPerPr: costPer(db, projectId, prs),
    cycle: cycleTime(db, projectId, done),
    rework: rework(db, projectId, ids),
    stalls: ledgerCount(db, projectId, "stall", w),
    replans: ledgerCount(db, projectId, "replan", w),
    interventions: interventions(db, projectId, w, ownerMessages),
  };
}

/** The same task numbers per template version, to compare a change with what came before it. */
export function byVersion(db: DatabaseSync, projectId: string, w: Window): VersionMetrics[] {
  const groups = new Map<string, Done[]>();
  for (const t of finishedTasks(db, projectId, w)) {
    if (t.templateId === null || t.templateVersion === null) continue;
    const k = `${t.templateId}\u0000${t.templateVersion}`;
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  return [...groups.values()]
    .map((g) => {
      const ids = g.map((t) => t.id);
      return {
        templateId: g[0].templateId!,
        version: g[0].templateVersion!,
        finished: g.length,
        costPerTask: costPer(db, projectId, ids),
        cycleCreated: cycleTime(db, projectId, g).created,
        reworkPerTask: rework(db, projectId, ids).perTask,
      };
    })
    .sort((a, b) => a.templateId.localeCompare(b.templateId) || a.version - b.version);
}

/** The last `days` against the `days` before them, and versions over both. What the API returns. */
export function metricsReport(db: DatabaseSync, projectId: string, days: number, ownerMessages: number[] = [], at = Date.now()): MetricsReport {
  const span = days * 86_400_000;
  const cur = { since: at - span, until: at + 1 };
  const prev = { since: at - 2 * span, until: at - span };
  return {
    days,
    now: factoryMetrics(db, projectId, cur, ownerMessages),
    before: factoryMetrics(db, projectId, prev, ownerMessages),
    versions: byVersion(db, projectId, { since: prev.since, until: cur.until }),
    at,
  };
}
