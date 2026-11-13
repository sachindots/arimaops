// SPDX-License-Identifier: AGPL-3.0-or-later
// Flow gates (docs/core-model.md section 4). A task leaves a stage, or finishes, only when every
// gate of the stages it leaves is met. HQ sees some gates itself (a merged PR, a delivered file,
// a set scope); the rest need evidence in gate_events, where the latest row per gate wins.
// Pure: no I/O. server/gateStore.ts keeps the events.

import type { Actor, Flow, Gate, GateEvent, Stage } from "../src/data/model";
import type { PullRequest, Task } from "../src/data/types";

export interface GateContext {
  task: Task;
  /** Who is finishing or moving the task: an agent id, "you" (a person), or "github" / "hq". */
  actor: Actor;
  /** An agent's role id (null for people and HQ). */
  roleOf: (agentId: string) => string | null;
  prs: PullRequest[];
  scopeSet: boolean;
  /** This task's gate events, oldest first. */
  events: GateEvent[];
}

export interface UnmetGate {
  stageId: string;
  gate: Gate;
  why: string;
}

/** Gates HQ checks from what it can see; nobody records evidence for them (the owner can still waive one). */
export const OBSERVED_GATES: ReadonlySet<Gate["kind"]> = new Set(["pr-merged", "file-delivered", "scope-set"]);

/** Gates only a person may pass: they approve, or decide what the team works on. */
export const PERSON_GATES: ReadonlySet<Gate["kind"]> = new Set(["owner-approval", "spec-approved"]);

const latest = (events: GateEvent[], gateId: string) => events.filter((e) => e.gateId === gateId).at(-1);

/** Person gates the lead may pass for the owner while the owner is away: they can be undone. Merges, containment and outbound sends never. */
export const leadMayApprove = (gate: Gate) => gate.kind === "spec-approved" || (gate.kind === "owner-approval" && gate.reason === "spec");

/** A person's pass, or the lead's on the owner's behalf for a gate it may approve. */
const approved = (gate: Gate, last: GateEvent | undefined) =>
  last?.state === "passed" && (last.by.kind === "user" || (!!last.proof.onBehalf && leadMayApprove(gate)));

/** Why a gate is not met yet, or null when it is. */
export function gateProblem(gate: Gate, ctx: GateContext): string | null {
  const { task } = ctx;
  const last = latest(ctx.events, gate.id);
  if (last?.state === "waived" && last.by.kind === "user") return null;
  const passed = last?.state === "passed";
  switch (gate.kind) {
    case "pr-merged":
      return ctx.prs.some((p) => p.number === task.prNumber && p.taskId === task.id && p.merged)
        ? null
        : "Code tasks finish only after their linked PR is merged. Submit in-review first.";
    case "file-delivered":
      if (!task.doneWhen?.trim()) return "Add acceptance criteria (doneWhen) before completing this task.";
      if (!task.note?.trim() || !task.deliverablePath?.trim())
        return "Completion needs a verification summary in note and a deliverablePath. Submit in-review first.";
      return null;
    case "scope-set":
      return ctx.scopeSet ? null : "Set the engagement scope (Settings → Project) first.";
    case "reviewer": {
      // A pass recorded by someone else counts, and so does finishing the task as someone other than its owner.
      const reviewers = [passed ? last.by : null, ctx.actor].filter((a): a is Actor => !!a && a.id !== task.ownerId);
      if (!reviewers.length) return "A different reviewer must accept this task. Submit in-review for the lead or the user.";
      const fits = (a: Actor) => !gate.roleId || a.kind === "user" || (a.kind === "agent" && ctx.roleOf(a.id) === gate.roleId);
      return reviewers.some(fits) ? null : `A ${gate.roleId} must accept this task.`;
    }
    case "owner-approval":
      return approved(gate, last) ? null : `Waiting for the owner's approval (${gate.reason}).`;
    case "spec-approved":
      return approved(gate, last) ? null : "Waiting for the owner to approve the spec.";
    case "tests-ci":
      return passed ? null : "Needs evidence that the PR adds or changes tests and CI is green.";
    case "analyze":
      return passed ? null : "Needs the analyze check: every spec item maps to a task.";
    case "second-opinion":
      return passed ? null : "Needs a second opinion.";
    case "findings-report":
      return passed ? null : "Needs the findings report.";
  }
}

/** The stages a task leaves when it moves from `fromId` to `toId` (to the end of the flow when toId is null). */
export function stagesLeft(flow: Flow, fromId: string | undefined, toId: string | null): Stage[] {
  const from = Math.max(0, flow.stages.findIndex((s) => s.id === fromId));
  const to = toId === null ? flow.stages.length : flow.stages.findIndex((s) => s.id === toId);
  if (to < 0) throw new Error(`No stage "${toId}" in this flow (${flow.stages.map((s) => s.id).join(", ")}).`);
  return flow.stages.slice(from, Math.max(from, to));
}

export function unmetGates(stages: Stage[], ctx: GateContext): UnmetGate[] {
  return stages.flatMap((s) =>
    s.gates.flatMap((gate) => {
      const why = gateProblem(gate, ctx);
      return why ? [{ stageId: s.id, gate, why }] : [];
    }),
  );
}

/** Throws with every unmet gate when the task can't move to `toId` (null: finish it). */
export function assertGates(flow: Flow, toId: string | null, ctx: GateContext) {
  const unmet = unmetGates(stagesLeft(flow, ctx.task.stageId, toId), ctx);
  if (unmet.length) throw new Error(unmet.map((u) => u.why).join(" "));
}
