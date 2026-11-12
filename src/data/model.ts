// SPDX-License-Identifier: AGPL-3.0-or-later
// The core model shared by server and UI (docs/core-model.md): team templates, roles, flows and
// gates, findings, ledgers, usage events and briefs. Storage is in server/lib/db.ts.

import type { Provider } from "./providers";
import type { AgentCli, AgentMode, Board, FindingStatus, SandboxSettings, Severity, Task, Tokens } from "./types";
import { AGENT_CLIS, isAgentCli } from "./types";

// ── Team template (1.1) ──

export interface TeamTemplate {
  id: string; // "dev", "blank", or a slug for saved ones
  version: number; // bumped on every save
  name: string;
  description: string;
  roles: Role[];
  flow: Flow;
  starter: { boards: Board[]; tasks: StarterTask[] };
  rules: ToolRules;
  /** Memory node types beyond the core ontology: "Asset", "Finding", "Source"… */
  memoryTypes: string[];
}

export interface Role {
  id: string; // "lead", "developer", "reviewer", "red"…
  title: string;
  isLead: boolean;
  /** The role text every seat of this role is given. */
  roleMd: string;
  cli: AgentCli;
  model: string; // "" = the CLI's default
  /** Overflow when the role's account hits its limit; HQ always asks the owner first. */
  fallback: { cli: AgentCli; model: string } | null;
  skills: string[];
  /** Started per task and stopped after it. The lead never is. */
  onDemand: boolean;
  /** Agents of this role a new project starts with. */
  seats: number;
  color: string; // hex
}

export const OUTBOUND = ["none", "drafts-only"] as const;
export type Outbound = (typeof OUTBOUND)[number];

export interface ToolRules {
  /** Security work: agents get the findings tools and HQ writes the findings report. */
  findings: boolean;
  /** Agents submit a plan (commands, hosts, rollback) and wait for the owner before changing a system. */
  plans: boolean;
  /** No agent starts before the project has a scope (red and purple teams), unless lab mode is on. */
  scopeRequired: boolean;
  /** CTFs and practice ranges: lifts the scope requirement. */
  labMode: boolean;
  /** "drafts-only": agents write messages, the owner sends them by hand. */
  outbound: Outbound;
  /** Extra hosts container-mode agents may reach. */
  egress: string[];
}

/** A task a new project's board starts with. */
export interface StarterTask {
  id: string;
  boardId: string;
  stageId: string;
  title: string;
  description: string;
  doneWhen: string;
  needs: string[];
}

/** One agent: a seat of a role. CLI, model, skills and role text come from the role. */
export interface Seat {
  id: string;
  name: string;
  roleId: string;
  color: string;
  mode: AgentMode;
  account: string; // "" = the default account for the role's CLI
  workspacePath: string | null; // null = HQ-managed clone
  sandbox: SandboxSettings;
  mcp: string[];
}

// ── Flow and gates (1.2) ──

export interface Flow {
  stages: Stage[]; // in order
}

export interface Stage {
  id: string;
  name: string;
  /** Roles that work tasks in this stage. */
  roleIds: string[];
  /** All must pass before a task leaves the stage. */
  gates: Gate[];
}

export const GATE_KINDS = [
  "pr-merged",
  "tests-ci",
  "spec-approved",
  "analyze",
  "reviewer",
  "second-opinion",
  "owner-approval",
  "file-delivered",
  "findings-report",
  "scope-set",
] as const;
export type GateKind = (typeof GATE_KINDS)[number];

export const APPROVAL_REASONS = ["spec", "merge", "containment", "outbound"] as const;
export type ApprovalReason = (typeof APPROVAL_REASONS)[number];

export type Gate = { id: string } & (
  | { kind: "pr-merged" }
  /** The PR adds or changes tests, and CI is green. */
  | { kind: "tests-ci" }
  | { kind: "spec-approved" }
  /** Every spec item maps to a task. */
  | { kind: "analyze" }
  /** Someone other than the task's owner; of this role when given. */
  | { kind: "reviewer"; roleId?: string }
  | { kind: "second-opinion"; when: "always" | "high-stakes" }
  | { kind: "owner-approval"; reason: ApprovalReason }
  | { kind: "file-delivered" }
  | { kind: "findings-report" }
  | { kind: "scope-set" }
);

export const GATE_STATES = ["passed", "failed", "waived", "reset"] as const;
export type GateState = (typeof GATE_STATES)[number];

export type Actor = { kind: "agent" | "user" | "hq"; id: string };

/** One row of gate_events. Append-only: the latest row per (task, gate) wins, and "reset" undoes. */
export interface GateEvent {
  projectId: string;
  taskId: string;
  gateId: string;
  state: GateState;
  by: Actor;
  proof: { url?: string; path?: string; sha?: string; note?: string };
  at: string;
}

// ── Finding (1.3) ──

export const ASSET_KINDS = ["url", "host", "ip", "repo", "cloud", "app"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const EVIDENCE_KINDS = ["request", "response", "command", "output", "file", "note"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface Ssvc {
  exploitation: "none" | "poc" | "active";
  automatable: boolean;
  technicalImpact: "partial" | "total";
  decision: "track" | "track*" | "attend" | "act";
}

export interface Finding {
  id: string; // "F-003", per project
  projectId: string;
  taskId: string | null;
  reporterId: string;
  title: string;
  asset: { kind: AssetKind; value: string };
  /** Code findings (SARIF). */
  location: { file: string; startLine?: number; endLine?: number } | null;
  /** CVSS 4.0 only. HQ computes the score from the vector; an agent's claimed score is ignored. */
  cvss: { vector: string; score: number } | null;
  /** From the CVSS score when there is one, else set by hand. */
  severity: Severity;
  ssvc: Ssvc | null;
  cwe: string[]; // "CWE-89"
  attack: string[]; // "T1190"
  d3fend: string[]; // "D3-IAA"
  wstg: string | null; // "WSTG-INPV-05"
  description: string;
  impact: string;
  remediation: string;
  evidence: { kind: EvidenceKind; content: string }[];
  verified: boolean;
  verifiedBy: string | null;
  status: FindingStatus;
  at: string;
  updatedAt: string;
}

// ── Usage events (1.6) ──

export const USAGE_SOURCES = ["agent", "helper", "review"] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

export interface UsageEvent {
  at: string;
  projectId: string;
  taskId: string | null;
  agentId: string | null;
  /** An agent's CLI session, an HQ one-shot, or a second opinion. */
  source: UsageSource;
  account: string;
  provider: Provider;
  cli: AgentCli | null;
  model: string;
  tokens: Tokens;
  /** Estimated from the price table; null when the model has no price row. */
  costUsd: number | null;
}

// ── Ledgers (1.5) ──

export const LEDGERS = ["task", "progress"] as const;
export type LedgerName = (typeof LEDGERS)[number];
export const LEDGER_KINDS = ["fact", "guess", "plan", "stall", "replan", "note"] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

// ── Memory (Phase 2, docs/memory-core.md section 3) ──

/** What the team learns, in every project. Templates add their own types through `memoryTypes`. */
export const CORE_MEMORY_TYPES = ["Decision", "Lesson", "DeadEnd"] as const;
/** The graph's own labels: the things memories are about. Never a memory type. */
export const STRUCTURE_LABELS = ["Task", "Component", "Agent", "Person", "LedgerEntry", "Memory"] as const;
export const RESERVED_LABELS = [...CORE_MEMORY_TYPES, ...STRUCTURE_LABELS] as const;

export interface Memory {
  id: string; // "M-41"
  projectId: string;
  /** A core type or one of the template's memoryTypes. */
  type: string;
  text: string;
  taskId: string | null;
  /** Components it is about: file paths or names. */
  about: string[];
  certified: boolean;
  certifiedBy: string | null;
  source: "extraction" | "remember" | "consolidation";
  by: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface LedgerEntry {
  id: number;
  projectId: string;
  taskId: string | null;
  /** "task": the lead's facts, guesses and plan. "progress": HQ's stall checks and replans. */
  ledger: LedgerName;
  kind: LedgerKind;
  text: string;
  by: string;
  at: string;
  supersededBy: number | null;
}

// ── Brief (1.4) ──

export const BRIEF_BUDGET = 4000; // tokens

export interface BriefInput {
  task: Pick<Task, "id" | "title" | "description" | "files" | "doneWhen">;
  /** The excerpt of the approved spec this task implements; empty until specs exist (Phase 3). */
  spec: string;
  /** Notes of the tasks this one builds on, and the agent's own last note. */
  handoffs: { taskId: string; by: string | null; note: string }[];
  /** The lead's task ledger: entries for this task and for the whole project. */
  ledger: Pick<LedgerEntry, "kind" | "text">[];
  memory: string; // empty until Phase 2
  /** Repo facts (.arima/facts.md): build and test commands, layout. */
  facts: string[];
  skills: string[];
  /** The gates still between this task and done, and what each needs. */
  gates: { id: string; kind: Gate["kind"]; needs: string }[];
}

// ── Validation ──

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HEX = /^#[0-9a-f]{6}$/i;

const dupes = (ids: string[]) => [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
const isIn = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

/** Everything wrong with a template, as sentences for the person editing it. Empty means valid. */
export function templateErrors(t: TeamTemplate): string[] {
  const errs: string[] = [];
  const say = (m: string) => errs.push(m);

  if (!SLUG.test(t.id ?? "")) say(`Template id "${t.id}" must be lowercase letters, digits and dashes.`);
  if (!Number.isInteger(t.version) || t.version < 1) say("Template version must be a whole number from 1.");
  if (!t.name?.trim()) say("The template needs a name.");

  const roles = Array.isArray(t.roles) ? t.roles : [];
  if (!roles.length) say("The template needs at least one role.");
  const roleIds = new Set(roles.map((r) => r.id));
  for (const id of dupes(roles.map((r) => r.id))) say(`Two roles share the id "${id}".`);
  const leads = roles.filter((r) => r.isLead);
  if (leads.length !== 1) say(`A template has exactly one lead role (found ${leads.length}).`);
  for (const r of roles) {
    const name = r.title || r.id;
    if (!SLUG.test(r.id ?? "")) say(`Role id "${r.id}" must be lowercase letters, digits and dashes.`);
    if (!r.title?.trim()) say(`Role "${r.id}" needs a title.`);
    if (!isAgentCli(r.cli)) say(`${name}: "${r.cli}" is not a CLI HQ runs (${AGENT_CLIS.join(", ")}).`);
    if (r.fallback && !isAgentCli(r.fallback.cli)) say(`${name}: fallback "${r.fallback.cli}" is not a CLI HQ runs.`);
    if (!Number.isInteger(r.seats) || r.seats < 0) say(`${name}: seats must be a whole number from 0.`);
    if (!HEX.test(r.color ?? "")) say(`${name}: colour must be a hex value like #4f8cff.`);
    if (r.isLead && r.onDemand) say(`${name}: the lead stays on, so it can't be on demand.`);
    if (r.isLead && r.seats !== 1) say(`${name}: the lead role has exactly one seat.`);
  }

  const stages = Array.isArray(t.flow?.stages) ? t.flow.stages : [];
  if (!stages.length) say("The flow needs at least one stage.");
  const stageIds = new Set(stages.map((s) => s.id));
  for (const id of dupes(stages.map((s) => s.id))) say(`Two stages share the id "${id}".`);
  const gates = stages.flatMap((s) => s.gates ?? []);
  for (const id of dupes(gates.map((g) => g.id))) say(`Two gates share the id "${id}"; gate ids are unique across the flow.`);
  for (const s of stages) {
    const name = s.name || s.id;
    if (!SLUG.test(s.id ?? "")) say(`Stage id "${s.id}" must be lowercase letters, digits and dashes.`);
    if (!s.roleIds?.length) say(`Stage ${name}: name the roles that work in it.`);
    for (const r of s.roleIds ?? []) if (!roleIds.has(r)) say(`Stage ${name}: no role "${r}".`);
    for (const g of s.gates ?? []) {
      if (!SLUG.test(g.id ?? "")) say(`Stage ${name}: gate id "${g.id}" must be lowercase letters, digits and dashes.`);
      if (!isIn(GATE_KINDS, g.kind)) say(`Stage ${name}: unknown gate kind "${(g as { kind: unknown }).kind}".`);
      else if (g.kind === "reviewer" && g.roleId !== undefined && !roleIds.has(g.roleId)) say(`Stage ${name}: reviewer gate names no role "${g.roleId}".`);
      else if (g.kind === "second-opinion" && g.when !== "always" && g.when !== "high-stakes") say(`Stage ${name}: second opinion "when" is "always" or "high-stakes".`);
      else if (g.kind === "owner-approval" && !isIn(APPROVAL_REASONS, g.reason)) say(`Stage ${name}: owner approval needs a reason (${APPROVAL_REASONS.join(", ")}).`);
    }
  }

  const rules = t.rules;
  if (!rules || !isIn(OUTBOUND, rules.outbound)) say(`Outbound must be one of ${OUTBOUND.join(", ")}.`);
  if (rules?.scopeRequired && !rules.labMode && !gates.some((g) => g.kind === "scope-set"))
    say("A template that requires a scope needs a scope-set gate in its flow.");

  const boards = t.starter?.boards ?? [];
  const tasks = t.starter?.tasks ?? [];
  const boardIds = new Set(boards.map((b) => b.id));
  for (const id of dupes(boards.map((b) => b.id))) say(`Two starter boards share the id "${id}".`);
  const taskIds = new Set(tasks.map((x) => x.id));
  for (const id of dupes(tasks.map((x) => x.id))) say(`Two starter tasks share the id "${id}".`);
  for (const x of tasks) {
    if (!boardIds.has(x.boardId)) say(`Starter task ${x.id}: no board "${x.boardId}".`);
    if (!stageIds.has(x.stageId)) say(`Starter task ${x.id}: no stage "${x.stageId}".`);
    for (const n of x.needs ?? []) if (!taskIds.has(n)) say(`Starter task ${x.id}: needs unknown task "${n}".`);
  }
  const cycle = needsCycle(tasks);
  if (cycle) say(`Starter tasks depend on each other in a loop: ${cycle.join(" → ")}.`);

  for (const id of dupes(t.memoryTypes ?? [])) say(`Memory type "${id}" is listed twice.`);
  for (const m of t.memoryTypes ?? []) if ((RESERVED_LABELS as readonly string[]).includes(m)) say(`"${m}" is a core memory type already; leave it out of memoryTypes.`);
  if ((t.memoryTypes ?? []).some((m) => !/^[A-Z][A-Za-z]{1,39}$/.test(m))) say("Memory types are names like Asset or Finding.");
  return errs;
}

/** The first dependency loop among tasks, as ids ending where it started; null when there is none. */
export function needsCycle(tasks: { id: string; needs: string[] }[]): string[] | null {
  const needs = new Map(tasks.map((x) => [x.id, x.needs ?? []]));
  const state = new Map<string, "open" | "done">();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === "done" || !needs.has(id)) return null;
    if (state.get(id) === "open") return [...path.slice(path.indexOf(id)), id];
    state.set(id, "open");
    path.push(id);
    for (const n of needs.get(id)!) {
      const found = visit(n);
      if (found) return found;
    }
    path.pop();
    state.set(id, "done");
    return null;
  };
  for (const x of tasks) {
    const found = visit(x.id);
    if (found) return found;
  }
  return null;
}
