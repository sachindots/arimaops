// SPDX-License-Identifier: AGPL-3.0-or-later
// Boards, tasks and gate evidence of template projects, in the HQ database (server/lib/db.ts).
// Projects made before templates keep their plan.json row (store.ts).

import type { DatabaseSync } from "node:sqlite";
import type { Actor, GateEvent, GateState, TeamTemplate } from "../src/data/model";
import type { Board, HqConfig, PullRequest, Task, Tokens } from "../src/data/types";
import { hqDb } from "./lib/db";
import { tx } from "./lib/docs";
import { assertGates, OBSERVED_GATES, PERSON_GATES, type GateContext } from "./gates";

export interface PlanFile {
  boards: Board[];
  tasks: Task[];
}

interface TaskRow {
  id: string; board_id: string; stage_id: string; title: string; owner_id: string | null; status: Task["status"];
  needs: string; files: string; description: string | null; done_when: string | null; note: string | null;
  pr_number: number | null; deliverable_path: string | null; cli: Task["cli"]; model: string | null;
  usage: string | null; usage_start: string | null;
}

const json = <T>(v: string | null): T | null => (v ? (JSON.parse(v) as T) : null);

/** The project's plan, or null before its first save. */
export function loadPlanTables(db: DatabaseSync, projectId: string): PlanFile | null {
  const boards = (db.prepare("SELECT id, title, status, ord FROM boards WHERE project_id = ? ORDER BY ord, id").all(projectId) as { id: string; title: string; status: Board["status"]; ord: number }[])
    .map((b) => ({ id: b.id, title: b.title, status: b.status, order: b.ord }));
  if (!boards.length) return null;
  const tasks = (db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY rowid").all(projectId) as unknown as TaskRow[]).map(
    (r): Task => ({
      id: r.id,
      boardId: r.board_id,
      stageId: r.stage_id,
      title: r.title,
      ownerId: r.owner_id,
      status: r.status,
      needs: JSON.parse(r.needs),
      files: JSON.parse(r.files),
      description: r.description ?? undefined,
      doneWhen: r.done_when ?? undefined,
      note: r.note,
      prNumber: r.pr_number,
      deliverablePath: r.deliverable_path,
      cli: r.cli,
      model: r.model,
      usage: json<Tokens>(r.usage),
      usageStart: json<Tokens>(r.usage_start),
    }),
  );
  return { boards, tasks };
}

/** Saves the whole plan in one transaction. Rows of removed tasks go, with their gate events. */
export function savePlanTables(db: DatabaseSync, projectId: string, plan: PlanFile, firstStage: string) {
  const now = Date.now();
  const board = db.prepare(
    `INSERT INTO boards (project_id, id, title, status, ord) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (project_id, id) DO UPDATE SET title = excluded.title, status = excluded.status, ord = excluded.ord`,
  );
  const task = db.prepare(
    `INSERT INTO tasks (project_id, id, board_id, stage_id, title, owner_id, status, needs, files, description, done_when, note, pr_number, deliverable_path, cli, model, usage, usage_start, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, id) DO UPDATE SET board_id = excluded.board_id, stage_id = excluded.stage_id, title = excluded.title, owner_id = excluded.owner_id,
       status = excluded.status, needs = excluded.needs, files = excluded.files, description = excluded.description, done_when = excluded.done_when, note = excluded.note,
       pr_number = excluded.pr_number, deliverable_path = excluded.deliverable_path, cli = excluded.cli, model = excluded.model, usage = excluded.usage,
       usage_start = excluded.usage_start, updated_at = excluded.updated_at`,
  );
  const keep = (ids: string[]) => JSON.stringify(ids);
  tx(db, () => {
    for (const b of plan.boards) board.run(projectId, b.id, b.title, b.status, b.order);
    for (const t of plan.tasks)
      task.run(
        projectId, t.id, t.boardId, t.stageId ?? firstStage, t.title, t.ownerId, t.status, JSON.stringify(t.needs ?? []), JSON.stringify(t.files ?? []),
        t.description ?? null, t.doneWhen ?? null, t.note ?? null, t.prNumber ?? null, t.deliverablePath ?? null, t.cli ?? null, t.model ?? null,
        t.usage ? JSON.stringify(t.usage) : null, t.usageStart ? JSON.stringify(t.usageStart) : null, now,
      );
    db.prepare("DELETE FROM tasks WHERE project_id = ? AND id NOT IN (SELECT value FROM json_each(?))").run(projectId, keep(plan.tasks.map((t) => t.id)));
    db.prepare("DELETE FROM boards WHERE project_id = ? AND id NOT IN (SELECT value FROM json_each(?))").run(projectId, keep(plan.boards.map((b) => b.id)));
  });
}

/** A task's gate events, oldest first. */
export function gateEvents(db: DatabaseSync, projectId: string, taskId: string): GateEvent[] {
  return (db.prepare("SELECT * FROM gate_events WHERE project_id = ? AND task_id = ? ORDER BY id").all(projectId, taskId) as {
    gate_id: string; state: GateState; by_kind: Actor["kind"]; by_id: string; proof: string; at: number;
  }[]).map((r) => ({
    projectId,
    taskId,
    gateId: r.gate_id,
    state: r.state,
    by: { kind: r.by_kind, id: r.by_id },
    proof: JSON.parse(r.proof),
    at: new Date(r.at).toISOString(),
  }));
}

/** Records gate evidence after checking who may record it. Throws with a reason the recorder can act on. */
export function recordGate(db: DatabaseSync, t: TeamTemplate, task: Task, ev: Omit<GateEvent, "at" | "taskId">) {
  const gate = t.flow.stages.flatMap((s) => s.gates).find((g) => g.id === ev.gateId);
  if (!gate) throw new Error(`No gate "${ev.gateId}" in this flow. Gates: ${t.flow.stages.flatMap((s) => s.gates.map((g) => g.id)).join(", ") || "none"}.`);
  const person = ev.by.kind === "user";
  if (ev.state === "waived" && !person) throw new Error("Only a person can waive a gate.");
  if (PERSON_GATES.has(gate.kind) && !person && ev.state !== "reset") throw new Error(`Only a person can pass ${gate.id} (${gate.kind}).`);
  if (OBSERVED_GATES.has(gate.kind) && !person) throw new Error(`HQ checks ${gate.id} (${gate.kind}) itself; nothing to record.`);
  if (gate.kind === "reviewer" && ev.state === "passed" && ev.by.id === task.ownerId) throw new Error("You can't review your own task.");
  db.prepare("INSERT INTO gate_events (project_id, task_id, gate_id, state, by_kind, by_id, proof, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    ev.projectId, task.id, gate.id, ev.state, ev.by.kind, ev.by.id, JSON.stringify(ev.proof ?? {}), Date.now(),
  );
}

const actorOf = (id: string, team: HqConfig["team"]): Actor =>
  id === "you" ? { kind: "user", id } : team.some((a) => a.id === id) ? { kind: "agent", id } : { kind: "hq", id };

/**
 * Throws with every unmet gate when `task` can't move to stage `toStageId` (null: finish it).
 * Projects made before templates have no flow: they are read-only, so nothing moves.
 */
export function assertTaskMove(cfg: HqConfig, task: Task, toStageId: string | null, byId: string, prs: PullRequest[]) {
  if (!cfg.template) throw new Error("This project was made before templates and is read-only.");
  assertGates(cfg.template.flow, toStageId, gateContext(cfg, task, byId, prs));
}

export function gateContext(cfg: HqConfig, task: Task, byId: string, prs: PullRequest[]): GateContext {
  return {
    task,
    actor: actorOf(byId, cfg.team),
    roleOf: (id) => cfg.team.find((a) => a.id === id)?.roleId ?? null,
    prs,
    scopeSet: !!cfg.project.scope?.inScope.length,
    events: gateEvents(hqDb(), cfg.project.id, task.id),
  };
}
