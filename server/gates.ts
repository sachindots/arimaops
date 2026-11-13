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
  /** The spec items of the task's board (null: the board has no spec), and the items its tasks cover. */
  spec?: { items: string[]; covered: string[]; approved?: boolean } | null;
  /** Who makes an agent's model ("anthropic", "openai", "google"...), for the second opinion. */
  vendorOf?: (agentId: string) => string | null;
  /** When the findings report was last written, and when this task's findings last changed (ms; null: never). */
  reportAt?: number | null;
  findingsAt?: number | null;
  /** The project's critical and high findings, with who reported and who verified them (the findings report checks them). */
  severe?: { id: string; reporterId: string; verifiedBy: string | null }[];
  /** The verifier's latest evidence for a task: the commit it was taken at (null: none). */
  evidence?: (taskId: string) => { sha: string } | null;
}

/** Files that change what people see: a PR touching one needs evidence when the flow has an evidence gate. */
export const UI_FILE = /\.(tsx|jsx|vue|svelte|css|scss|sass|less|html)$/i;

/** The PR's UI files by the gate's own extensions (".tsx", "astro"…) or the default list. */
export function uiFilesOf(gate: { uiFiles?: string[] }, files: string[]): string[] {
  const exts = (gate.uiFiles ?? []).map((e) => e.replace(/^\./, "").toLowerCase()).filter(Boolean);
  return files.filter((f) => (exts.length ? exts.includes(f.split(".").pop()!.toLowerCase()) : UI_FILE.test(f)));
}

/** Files that make a task high-stakes on their own (docs/agent-engine.md section 5). */
export const SENSITIVE = /(^|[/._-])(auth|login|session|crypto|secret|token|password|payment|billing|migrations?)([/._-]|$)|(^|\/)\.github\/workflows\//i;

/** The lead marked it, or it touches sensitive files: a "high-stakes" second opinion applies. */
export const isHighStakes = (task: Pick<Task, "highStakes" | "files">) => !!task.highStakes || (task.files ?? []).some((f) => SENSITIVE.test(f));

/** Test files by name or folder. shortcut: one default for every project; make it a project setting when a repo needs another. */
export const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z0-9]+$|_test\.[a-z0-9]+$/i;

export interface UnmetGate {
  stageId: string;
  gate: Gate;
  why: string;
}

/** Gates HQ checks from what it can see; nobody records evidence for them (the owner can still waive one). */
export const OBSERVED_GATES: ReadonlySet<Gate["kind"]> = new Set(["pr-merged", "file-delivered", "scope-set", "tests-ci", "analyze", "findings-report", "evidence"]);

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
      // The board's spec approved as a whole (its current version), or this task's gate passed on its own.
      if (ctx.spec?.approved && last?.state !== "reset") return null;
      return approved(gate, last) ? null : ctx.spec ? "Waiting for the owner to approve the board's spec (Action items)." : "The board has no spec yet: the lead writes it with write_spec, then the owner approves it.";
    case "tests-ci": {
      const pr = ctx.prs.find((p) => p.number === task.prNumber && p.taskId === task.id);
      if (!pr) return "Open the task's PR first (set_my_status in-review with its number).";
      if (pr.testsChanged === undefined) return "Waiting for GitHub to report the PR's files and checks.";
      if (!pr.testsChanged) return `PR #${pr.number} changes no test file. Add or update a test for this change.`;
      return pr.ciGreen ? null : `CI on PR #${pr.number} isn't green yet (or no checks ran).`;
    }
    case "evidence": {
      const pr = ctx.prs.find((p) => p.number === task.prNumber && p.taskId === task.id);
      if (!pr) return "Open the task's PR first (set_my_status in-review with its number).";
      if (!pr.files) return "Waiting for GitHub to report the PR's files.";
      const ui = uiFilesOf(gate, pr.files);
      if (!ui.length) return null;
      if (!pr.headSha) return "Waiting for GitHub to report the PR's head commit.";
      const ev = ctx.evidence?.(task.id);
      const which = `${ui.slice(0, 3).join(", ")}${ui.length > 3 ? ` and ${ui.length - 3} more` : ""}`;
      if (!ev) return `PR #${pr.number} changes what people see (${which}): it needs screenshots of the running app from the verifier.`;
      return ev.sha === pr.headSha ? null : `The evidence is for ${ev.sha.slice(0, 7)}; PR #${pr.number} has new commits (${pr.headSha.slice(0, 7)}): the verifier takes it again.`;
    }
    case "analyze": {
      if (!ctx.spec?.items.length) return "The board has no spec with numbered items (S1., S2.…). The lead writes it with write_spec.";
      const missing = ctx.spec.items.filter((i) => !ctx.spec!.covered.includes(i));
      return missing.length ? `No task covers ${missing.join(", ")} of the spec. Give each one a task (specItems).` : null;
    }
    case "second-opinion": {
      if (gate.when === "high-stakes" && !isHighStakes(task)) return null;
      if (!passed) return "Needs a second opinion from an agent on another provider than the task owner's (the team's second-opinion seat).";
      if (last.by.kind === "user") return null;
      const vendor = (id: string | null) => (id ? (ctx.vendorOf?.(id) ?? null) : null);
      const mine = vendor(task.ownerId);
      const theirs = vendor(last.by.id);
      return last.by.kind === "agent" && last.by.id !== task.ownerId && theirs && theirs !== mine
        ? null
        : `The second opinion must come from another provider than ${task.ownerId ?? "the task's owner"}'s${mine ? ` (${mine})` : ""}.`;
    }
    case "findings-report": {
      if (!ctx.reportAt) return "The findings report hasn't been written yet: report a finding first.";
      if (ctx.findingsAt && ctx.findingsAt > ctx.reportAt) return "The findings report is older than this task's findings. It's rewritten on every change; check that the last write worked.";
      // Every critical and high finding needs a second look: a person, or a model from another maker than the reporter's.
      const vendor = (id: string) => ctx.vendorOf?.(id) ?? null;
      const checked = (f: NonNullable<GateContext["severe"]>[number]) =>
        !!f.verifiedBy && f.verifiedBy !== f.reporterId && (f.verifiedBy === "you" || ctx.roleOf(f.verifiedBy) === null || (vendor(f.verifiedBy) !== null && vendor(f.verifiedBy) !== vendor(f.reporterId)));
      const open = (ctx.severe ?? []).filter((f) => !checked(f));
      return open.length ? `Critical and high findings need verifying by a person or a model from another maker than the reporter's: ${open.map((f) => f.id).join(", ")}.` : null;
    }
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
