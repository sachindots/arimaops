// SPDX-License-Identifier: AGPL-3.0-or-later
// Boards, tasks and gate evidence of template projects, in the HQ database (server/lib/db.ts).
// Projects made before templates keep their plan.json row (store.ts).

import type { DatabaseSync } from "node:sqlite";
import type { Actor, Gate, GateEvent, GateState, TeamTemplate } from "../src/data/model";
import type { AgentCli, Board, HqConfig, PullRequest, Task } from "../src/data/types";
import { statSync } from "node:fs";
import { join } from "node:path";
import { FINDINGS_REPORT } from "./findings";
import { hqDb } from "./lib/db";
import { taskUsage } from "./usageEvents";
import { scoresByTask } from "./scorers";
import { tx } from "./lib/docs";
import { assertGates, leadMayApprove, OBSERVED_GATES, PERSON_GATES, type GateContext } from "./gates";

export interface PlanFile {
  boards: Board[];
  tasks: Task[];
}

interface TaskRow {
  id: string; board_id: string; stage_id: string; title: string; owner_id: string | null; status: Task["status"];
  needs: string; files: string; description: string | null; done_when: string | null; note: string | null;
  pr_number: number | null; deliverable_path: string | null; cli: Task["cli"]; model: string | null;
  spec_items: string; high_stakes: number; template_id: string | null; template_version: number | null;
}

/** The project's plan, or null before its first save. */
export function loadPlanTables(db: DatabaseSync, projectId: string): PlanFile | null {
  const boards = (db.prepare("SELECT id, title, status, ord FROM boards WHERE project_id = ? ORDER BY ord, id").all(projectId) as { id: string; title: string; status: Board["status"]; ord: number }[])
    .map((b) => ({ id: b.id, title: b.title, status: b.status, order: b.ord }));
  if (!boards.length) return null;
  const used = taskUsage(db, projectId);
  const scored = scoresByTask(db, projectId);
  const moved = movedAt(db, projectId);
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
      usage: used.get(r.id) ?? null,
      specItems: JSON.parse(r.spec_items),
      highStakes: !!r.high_stakes,
      templateId: r.template_id ?? undefined,
      templateVersion: r.template_version ?? undefined,
      ...(scored.has(r.id) ? { scores: scored.get(r.id) } : {}),
      ...(moved.has(r.id) ? { movedAt: moved.get(r.id) } : {}),
    }),
  );
  return { boards, tasks };
}

/** Per task, when it entered its current status: the start of the last run of same-status events. */
export function movedAt(db: DatabaseSync, projectId: string): Map<string, string> {
  const rows = db.prepare("SELECT task_id, at, status FROM task_events WHERE project_id = ? ORDER BY task_id, at, rowid").all(projectId) as { task_id: string; at: number; status: string }[];
  const last = new Map<string, { status: string; at: number }>();
  for (const r of rows) {
    const prev = last.get(r.task_id);
    if (!prev || prev.status !== r.status) last.set(r.task_id, { status: r.status, at: r.at });
  }
  return new Map([...last].map(([id, v]) => [id, new Date(v.at).toISOString()]));
}

/** Saves the whole plan in one transaction. Rows of removed tasks go, with their gate events. */
export function savePlanTables(db: DatabaseSync, projectId: string, plan: PlanFile, firstStage: string) {
  const now = Date.now();
  const board = db.prepare(
    `INSERT INTO boards (project_id, id, title, status, ord) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (project_id, id) DO UPDATE SET title = excluded.title, status = excluded.status, ord = excluded.ord`,
  );
  const task = db.prepare(
    `INSERT INTO tasks (project_id, id, board_id, stage_id, title, owner_id, status, needs, files, description, done_when, note, pr_number, deliverable_path, cli, model, updated_at, spec_items, high_stakes, template_id, template_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, id) DO UPDATE SET board_id = excluded.board_id, stage_id = excluded.stage_id, title = excluded.title, owner_id = excluded.owner_id,
       status = excluded.status, needs = excluded.needs, files = excluded.files, description = excluded.description, done_when = excluded.done_when, note = excluded.note,
       pr_number = excluded.pr_number, deliverable_path = excluded.deliverable_path, cli = excluded.cli, model = excluded.model, updated_at = excluded.updated_at,
       spec_items = excluded.spec_items, high_stakes = excluded.high_stakes`,
  );
  // The template columns are set once, when the task is first saved: a re-sync changes later tasks only.
  const was = new Map((db.prepare("SELECT id, status, stage_id FROM tasks WHERE project_id = ?").all(projectId) as { id: string; status: string; stage_id: string }[]).map((r) => [r.id, r]));
  const event = db.prepare("INSERT INTO task_events (project_id, task_id, at, status, stage_id, owner_id) VALUES (?, ?, ?, ?, ?, ?)");
  const keep = (ids: string[]) => JSON.stringify(ids);
  tx(db, () => {
    for (const b of plan.boards) board.run(projectId, b.id, b.title, b.status, b.order);
    for (const t of plan.tasks)
      task.run(
        projectId, t.id, t.boardId, t.stageId ?? firstStage, t.title, t.ownerId, t.status, JSON.stringify(t.needs ?? []), JSON.stringify(t.files ?? []),
        t.description ?? null, t.doneWhen ?? null, t.note ?? null, t.prNumber ?? null, t.deliverablePath ?? null, t.cli ?? null, t.model ?? null, now,
        JSON.stringify(t.specItems ?? []), t.highStakes ? 1 : 0, t.templateId ?? null, t.templateVersion ?? null,
      );
    for (const t of plan.tasks) {
      const stage = t.stageId ?? firstStage;
      const old = was.get(t.id);
      if (!old || old.status !== t.status || old.stage_id !== stage) event.run(projectId, t.id, now, t.status, stage, t.ownerId ?? null);
      if (!old || old.status !== t.status) t.movedAt = new Date(now).toISOString(); // the live task too, for the next snapshot
    }
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
/**
 * Records a gate event. `onBehalf`: the lead may pass a person gate that can be undone (leadMayApprove) while the
 * owner is away; the event is marked so the check accepts it and the owner can undo it. Returns that gate.
 */
export function recordGate(db: DatabaseSync, t: TeamTemplate, task: Task, ev: Omit<GateEvent, "at" | "taskId">, away?: { leadId: string | null; ownerAway: boolean }): Gate {
  const gate = t.flow.stages.flatMap((s) => s.gates).find((g) => g.id === ev.gateId);
  if (!gate) throw new Error(`No gate "${ev.gateId}" in this flow. Gates: ${t.flow.stages.flatMap((s) => s.gates.map((g) => g.id)).join(", ") || "none"}.`);
  const person = ev.by.kind === "user";
  if (ev.state === "waived" && !person) throw new Error("Only a person can waive a gate.");
  if (PERSON_GATES.has(gate.kind) && !person && ev.state !== "reset") {
    const lead = ev.by.kind === "agent" && !!away?.leadId && ev.by.id === away.leadId;
    if (!lead || ev.state !== "passed" || !leadMayApprove(gate)) throw new Error(`Only a person can pass ${gate.id} (${gate.kind}).${lead && !leadMayApprove(gate) ? " Merges, containment and outbound sends always wait for the owner." : ""}`);
    if (!away?.ownerAway) throw new Error(`Only the owner passes ${gate.id} (${gate.kind}) while they are around. You may approve it for them after 2 h without a word from them.`);
    ev = { ...ev, proof: { ...ev.proof, onBehalf: true } };
  }
  if (OBSERVED_GATES.has(gate.kind) && !person) throw new Error(`HQ checks ${gate.id} (${gate.kind}) itself; nothing to record.`);
  if (gate.kind === "reviewer" && ev.state === "passed" && ev.by.id === task.ownerId) throw new Error("You can't review your own task.");
  db.prepare("INSERT INTO gate_events (project_id, task_id, gate_id, state, by_kind, by_id, proof, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    ev.projectId, task.id, gate.id, ev.state, ev.by.kind, ev.by.id, JSON.stringify(ev.proof ?? {}), Date.now(),
  );
  return gate;
}

const actorOf = (id: string, team: HqConfig["team"]): Actor =>
  id === "you" ? { kind: "user", id } : team.some((a) => a.id === id) ? { kind: "agent", id } : { kind: "hq", id };

/**
 * Throws with every unmet gate when `task` can't move to stage `toStageId` (null: finish it).
 * Projects made before templates have no flow: they are read-only, so nothing moves.
 */
export function assertTaskMove(cfg: HqConfig, task: Task, toStageId: string | null, byId: string, prs: PullRequest[], more: ContextMore = {}) {
  if (!cfg.template) throw new Error("This project was made before templates and is read-only.");
  assertGates(cfg.template.flow, toStageId, gateContext(cfg, task, byId, prs, more));
}

/** What the gate check reads beyond the task: the board's other tasks (analyze) and the repo (findings report). */
export interface ContextMore {
  tasks?: Task[];
  repoRoot?: string;
}

/** Who makes each CLI's models: a second opinion must come from another one. */
const VENDOR: Record<AgentCli, string> = { claude: "anthropic", codex: "openai", agy: "google", gemini: "google", copilot: "github", opencode: "opencode" };

/** Who makes the model a seat runs: the model's name when it says (agy and OpenCode run several makers' models), else the CLI's maker. */
export function vendorOf(cli: AgentCli, model: string | null | undefined): string {
  const m = (model ?? "").toLowerCase();
  if (/claude|opus|sonnet|haiku/.test(m)) return "anthropic";
  if (/gpt|^o\d|codex/.test(m)) return "openai";
  if (/gemini/.test(m)) return "google";
  return VENDOR[cli];
}

export function gateContext(cfg: HqConfig, task: Task, byId: string, prs: PullRequest[], more: ContextMore = {}): GateContext {
  const db = hqDb();
  const spec = task.boardId ? loadSpec(db, cfg.project.id, task.boardId) : null;
  const covered = [...new Set((more.tasks ?? [task]).filter((t) => t.boardId === task.boardId).flatMap((t) => t.specItems ?? []))];
  const findingsAt = (db.prepare("SELECT MAX(updated_at) AS at FROM findings WHERE project_id = ? AND task_id = ?").get(cfg.project.id, task.id) as { at: number | null }).at;
  let reportAt: number | null = null;
  try {
    if (more.repoRoot) reportAt = statSync(join(more.repoRoot, FINDINGS_REPORT)).mtimeMs;
  } catch {
    /* not written yet */
  }
  return {
    task,
    actor: actorOf(byId, cfg.team),
    roleOf: (id) => cfg.team.find((a) => a.id === id)?.roleId ?? null,
    prs,
    scopeSet: !!cfg.project.scope?.inScope.length,
    events: gateEvents(db, cfg.project.id, task.id),
    spec: spec ? { items: spec.items, covered, approved: !!spec.approvedBy } : null,
    vendorOf: (id) => {
      const a = cfg.team.find((x) => x.id === id);
      return a ? vendorOf(a.cli, a.model) : null;
    },
    reportAt,
    findingsAt,
    evidence: (id) => (id === task.id ? (task.evidence ?? null) : null),
    severe: (db.prepare("SELECT id, reporter_id, verified, verified_by FROM findings WHERE project_id = ? AND severity IN ('critical', 'high') AND status NOT IN ('false-positive', 'accepted')").all(cfg.project.id) as { id: string; reporter_id: string; verified: number; verified_by: string | null }[]).map((f) => ({
      id: f.id,
      reporterId: f.reporter_id,
      verifiedBy: f.verified ? f.verified_by : null,
    })),
  };
}

// ---------------------------------------------------------------- specs (docs/agent-engine.md section 5)

export interface Spec {
  boardId: string;
  version: number;
  text: string;
  /** "S1", "S2"…: the lines that start with S<n>. */
  items: string[];
  by: string;
  at: string;
  /** Who approved this version (a person, or the lead while the owner was away); null until then. */
  approvedBy: string | null;
}

export const specItemsOf = (text: string) => [...new Set([...text.matchAll(/^\s*(?:[-*]\s*)?(S\d+)[.:)]/gm)].map((m) => m[1].toUpperCase()))];

export function loadSpec(db: DatabaseSync, projectId: string, boardId: string): Spec | null {
  const r = db.prepare("SELECT version, text, by, at, approved_version, approved_by FROM specs WHERE project_id = ? AND board_id = ?").get(projectId, boardId) as
    | { version: number; text: string; by: string; at: number; approved_version: number | null; approved_by: string | null }
    | undefined;
  return r
    ? { boardId, version: r.version, text: r.text, items: specItemsOf(r.text), by: r.by, at: new Date(r.at).toISOString(), approvedBy: r.approved_version === r.version ? r.approved_by : null }
    : null;
}

/** Approves this exact version of a board's spec; a later version needs its own approval. */
export function approveSpec(db: DatabaseSync, projectId: string, boardId: string, version: number, by: string): boolean {
  return Number(db.prepare("UPDATE specs SET approved_version = ?, approved_by = ? WHERE project_id = ? AND board_id = ? AND version = ?").run(version, by, projectId, boardId, version).changes) > 0;
}

/** Saves a new version of a board's spec. */
export function saveSpec(db: DatabaseSync, projectId: string, boardId: string, text: string, by: string): Spec {
  const version = (loadSpec(db, projectId, boardId)?.version ?? 0) + 1;
  db.prepare(
    `INSERT INTO specs (project_id, board_id, version, text, by, at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, board_id) DO UPDATE SET version = excluded.version, text = excluded.text, by = excluded.by, at = excluded.at`,
  ).run(projectId, boardId, version, text, by, Date.now());
  return loadSpec(db, projectId, boardId)!;
}
