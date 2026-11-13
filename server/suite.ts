// SPDX-License-Identifier: AGPL-3.0-or-later
// "Add to benchmark suite" on a finished task (docs/factory.md section 6): free, local. Writes the task's brief, base
// commit, template and scorers to ~/.arima-bench/suite/<id>.json for `pnpm bench task:<id>` to replay.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { TeamTemplate } from "../src/data/model";
import { scorersFor, type TaskScore } from "../src/data/scorers";
import { benchmarkKind, SUITE_FORMAT, suiteId, type RoleModel, type TaskBenchmark } from "../src/data/suite";
import type { AgentConfig, Task } from "../src/data/types";

export const suiteDir = () => join(homedir(), ".arima-bench", "suite");
export const suitePath = (id: string) => join(suiteDir(), `${id}.json`);
export const inSuite = (projectId: string, taskId: string) => existsSync(suitePath(suiteId(projectId, taskId)));

/** When the task started: its first move to in-progress, else its first history row. */
export function startedAt(db: DatabaseSync, projectId: string, taskId: string): number | null {
  const r = db
    .prepare("SELECT MIN(CASE WHEN status = 'in-progress' THEN at END) AS started, MIN(at) AS first FROM task_events WHERE project_id = ? AND task_id = ?")
    .get(projectId, taskId) as { started: number | null; first: number | null };
  return r.started ?? r.first;
}

/** The commit HEAD's first-parent line was at when the task started (HEAD when unknown). */
export function baseCommit(root: string, at: number | null): string {
  const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  const before = at ? git("rev-list", "-1", "--first-parent", `--before=@${Math.floor(at / 1000)}`, "HEAD") : "";
  return before || git("rev-parse", "HEAD");
}

export function buildTaskBenchmark(
  db: DatabaseSync,
  p: { projectId: string; root: string; template: TeamTemplate; team: AgentConfig[] },
  task: Task,
  now = new Date(),
): TaskBenchmark {
  if (task.status !== "done") throw new Error(`${task.id} isn't done yet: only finished tasks can join the suite.`);
  const kind = benchmarkKind(p.template);
  if (!kind) throw new Error(`Only Dev and Research tasks can join the suite for now (this project's template is ${p.template.name}).`);
  const used = db.prepare("SELECT COALESCE(SUM(input + output), 0) AS tokens, SUM(cost_usd) AS usd FROM usage_events WHERE project_id = ? AND task_id = ?").get(p.projectId, task.id) as { tokens: number; usd: number | null };
  const seen = new Set<string>();
  const models: RoleModel[] = p.template.roles.flatMap((r) => {
    const seat = (task.ownerId && p.team.find((a) => a.id === task.ownerId && a.roleId === r.id)) || p.team.find((a) => a.roleId === r.id);
    if (seen.has(r.id)) return [];
    seen.add(r.id);
    return [{ roleId: r.id, cli: seat?.cli ?? r.cli, model: seat?.model || r.model }];
  });
  return {
    format: SUITE_FORMAT,
    id: suiteId(p.projectId, task.id),
    title: `${task.id} ${task.title}`.slice(0, 120),
    kind,
    source: { projectId: p.projectId, taskId: task.id, templateId: p.template.id, templateVersion: task.templateVersion ?? null },
    repo: { path: p.root, commit: baseCommit(p.root, startedAt(db, p.projectId, task.id)) },
    task: { title: task.title, description: task.description ?? "", doneWhen: task.doneWhen ?? "", files: task.files ?? [] },
    template: p.template,
    scorers: scorersFor(p.template),
    gates: p.template.flow.stages.flatMap((s) => s.gates.map((g) => `${g.id} (${g.kind})`)),
    original: { usd: used.usd, tokens: used.tokens, scores: (task.scores ?? []) as TaskScore[], models },
    limits: { minutes: kind === "dev" ? 60 : 45, usd: 10 },
    addedAt: now.toISOString(),
  };
}

/** Saves the task to the suite (again: replaced). Returns its id. */
export function addToSuite(b: TaskBenchmark): string {
  mkdirSync(suiteDir(), { recursive: true });
  writeFileSync(suitePath(b.id), JSON.stringify(b, null, 2));
  return b.id;
}
