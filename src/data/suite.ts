// SPDX-License-Identifier: AGPL-3.0-or-later
// Own-task benchmarks (docs/factory.md section 6): a finished task saved with everything needed to replay it on other
// models: its brief, the repo commit it started from, its template and scorers, and what the original run cost.
// HQ writes them to ~/.arima-bench/suite/<id>.json; `pnpm bench task:<id>` replays one.

import type { TeamTemplate } from "./model";
import { scorersFor, type ScorerId, type TaskScore } from "./scorers";

export const SUITE_FORMAT = "arimaops-task-benchmark/1";

export interface TaskBenchmark {
  format: typeof SUITE_FORMAT;
  id: string;
  title: string;
  kind: "dev" | "research";
  source: { projectId: string; taskId: string; templateId: string; templateVersion: number | null };
  /** The local clone the task ran in, and the commit on it when the task started. */
  repo: { path: string; commit: string };
  task: { title: string; description: string; doneWhen: string; files: string[] };
  template: TeamTemplate;
  scorers: ScorerId[];
  /** The flow's gates, as "id (kind)". */
  gates: string[];
  /** The original run: what it cost, how it scored, on which models. */
  original: { usd: number | null; tokens: number; scores: TaskScore[]; models: RoleModel[] };
  limits: { minutes: number; usd: number };
  addedAt: string;
}

export interface RoleModel {
  roleId: string;
  cli: string;
  model: string;
}

export const suiteId = (projectId: string, taskId: string) =>
  `task-${`${projectId}-${taskId}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`.slice(0, 60).replace(/-+$/, "");

/** Dev (a PR flow) and Research for now; other templates can't be replayed yet. */
export function benchmarkKind(t: TeamTemplate): TaskBenchmark["kind"] | null {
  if (t.flow.stages.some((s) => s.gates.some((g) => g.kind === "pr-merged"))) return "dev";
  if (t.memoryTypes.includes("Source")) return "research";
  return null;
}

export function taskBenchmarkErrors(b: TaskBenchmark): string[] {
  const errs: string[] = [];
  if (b.format !== SUITE_FORMAT) errs.push(`Not a task benchmark (format "${b.format}").`);
  if (!/^task-[a-z0-9-]{1,60}$/.test(b.id ?? "")) errs.push(`Bad id "${b.id}".`);
  if (!b.task?.title?.trim()) errs.push("No task title.");
  if (!/^[0-9a-f]{40}$/.test(b.repo?.commit ?? "")) errs.push("No base commit.");
  if (!b.repo?.path) errs.push("No repo path.");
  if (!b.template?.roles?.length) errs.push("No template.");
  if (!(b.limits?.minutes > 0)) errs.push("The time limit must be above 0.");
  return errs;
}

/** What a task benchmark is scored by: the template's rule checks (model checks need Haiku and are left out of replays). */
export const replayScorers = (t: TeamTemplate): ScorerId[] => scorersFor(t);
