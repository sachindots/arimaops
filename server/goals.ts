// SPDX-License-Identifier: AGPL-3.0-or-later
// Goals that tasks roll up to: a few outcomes per project ("Launch the beta", metric "signups", target "200"),
// each with its tasks done, its total and the estimated spend on them. The owner sets goals; the lead links
// tasks to them (create_task / update_task goalId) and records where the number is now (update_goal).

import type { DatabaseSync } from "node:sqlite";
import type { Goal, GoalPatch, Task } from "../src/data/types";

export const GOAL_STATUSES = ["active", "done", "dropped"] as const;
const MAX_GOALS = 20;

interface GoalRow {
  id: string;
  title: string;
  metric: string | null;
  target: string | null;
  current: string | null;
  status: Goal["status"];
}

/** Every goal of the project, oldest first, with progress from `tasks` and spend from usage events. */
export function goalsOf(db: DatabaseSync, projectId: string, tasks: Pick<Task, "id" | "status" | "goalId">[]): Goal[] {
  const rows = db.prepare("SELECT id, title, metric, target, current, status FROM goals WHERE project_id = ? ORDER BY created_at, id").all(projectId) as unknown as GoalRow[];
  if (!rows.length) return [];
  const spend = new Map(
    (db.prepare("SELECT task_id AS id, SUM(cost_usd) AS usd FROM usage_events WHERE project_id = ? AND task_id IS NOT NULL GROUP BY task_id").all(projectId) as { id: string; usd: number | null }[]).map((r) => [r.id, r.usd ?? 0]),
  );
  return rows.map((r) => {
    const mine = tasks.filter((t) => t.goalId === r.id);
    return {
      id: r.id,
      title: r.title,
      ...(r.metric ? { metric: r.metric } : {}),
      ...(r.target ? { target: r.target } : {}),
      ...(r.current ? { current: r.current } : {}),
      status: r.status,
      done: mine.filter((t) => t.status === "done").length,
      total: mine.length,
      usd: mine.reduce((sum, t) => sum + (spend.get(t.id) ?? 0), 0),
    };
  });
}

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);

export function addGoal(db: DatabaseSync, projectId: string, input: { title: string; metric?: string; target?: string }): string {
  const title = clean(input.title, 200);
  if (!title) throw new Error("A goal needs a title.");
  const ids = (db.prepare("SELECT id FROM goals WHERE project_id = ?").all(projectId) as { id: string }[]).map((r) => r.id);
  if (ids.length >= MAX_GOALS) throw new Error(`A project keeps at most ${MAX_GOALS} goals. Mark old ones done or dropped first.`);
  let n = ids.length + 1;
  while (ids.includes(`G${n}`)) n++;
  db.prepare("INSERT INTO goals (project_id, id, title, metric, target, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    projectId, `G${n}`, title, clean(input.metric, 100) || null, clean(input.target, 100) || null, Date.now(),
  );
  return `G${n}`;
}

export function updateGoal(db: DatabaseSync, projectId: string, id: string, patch: GoalPatch) {
  if (!db.prepare("SELECT 1 FROM goals WHERE project_id = ? AND id = ?").get(projectId, id)) throw new Error(`No goal ${id}.`);
  const title = clean(patch.title, 200);
  const sets: [string, string | null][] = [];
  if (title) sets.push(["title", title]);
  for (const k of ["metric", "target", "current"] as const) if (patch[k] !== undefined) sets.push([k, clean(patch[k], 100) || null]);
  if (patch.status !== undefined) {
    if (!GOAL_STATUSES.includes(patch.status)) throw new Error(`Status is one of ${GOAL_STATUSES.join(", ")}.`);
    sets.push(["status", patch.status]);
  }
  if (!sets.length) return;
  db.prepare(`UPDATE goals SET ${sets.map(([k]) => `${k} = ?`).join(", ")} WHERE project_id = ? AND id = ?`).run(...sets.map(([, v]) => v), projectId, id);
}

/** Throws unless `id` is an active goal of the project (for linking tasks). */
export function assertGoal(db: DatabaseSync, projectId: string, id: string) {
  const r = db.prepare("SELECT status FROM goals WHERE project_id = ? AND id = ?").get(projectId, id) as { status: string } | undefined;
  if (!r) {
    const ids = (db.prepare("SELECT id FROM goals WHERE project_id = ? AND status = 'active'").all(projectId) as { id: string }[]).map((g) => g.id);
    throw new Error(`No goal ${id}. Goals: ${ids.join(", ") || "none yet (the owner sets them)"}.`);
  }
  if (r.status !== "active") throw new Error(`Goal ${id} is ${r.status}; link work to an active goal.`);
}

/** One line per active goal, for the lead's role file and list_goals. */
export function goalLines(goals: Goal[]): string[] {
  return goals
    .filter((g) => g.status === "active")
    .map((g) => `- ${g.id} ${g.title}${g.metric ? ` (${g.metric}${g.target ? `: target ${g.target}` : ""}${g.current ? `, now ${g.current}` : ""})` : ""}: ${g.done} of ${g.total} tasks done`);
}

/** Recomputes the project's goals and sends them to the UI when they changed. */
export function publishGoals(db: DatabaseSync, hub: { snap: { config: { project: { id: string } }; tasks: Task[]; goals?: Goal[] }; emit(e: { type: "goals.updated"; goals: Goal[] }): void }) {
  const goals = goalsOf(db, hub.snap.config.project.id, hub.snap.tasks);
  if (JSON.stringify(goals) === JSON.stringify(hub.snap.goals ?? [])) return;
  hub.snap.goals = goals;
  hub.emit({ type: "goals.updated", goals });
}
