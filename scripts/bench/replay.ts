// SPDX-License-Identifier: AGPL-3.0-or-later
// Own-task replays (docs/factory.md section 6): a task from the suite (~/.arima-bench/suite/<id>.json) run again in a
// throwaway HQ, on a clone of its repo at the commit it started from, with the role models you pick. Scored by the
// template's rule checks and by whether the task got to review; compared per model choice, with a chart.
//
//   pnpm bench task:<id>                                   the plan (nothing starts)
//   pnpm bench task:<id> --dry --models developer=codex/gpt-5.1    set up and tear down, no agent (free)
//   pnpm bench task:<id> --run --models developer=codex/gpt-5.1    a paid run: asks you to type the id at a terminal
//   pnpm bench task:<id> --results                         the comparison so far, and where the chart is

import { execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TeamTemplate } from "../../src/data/model";
import { type ScorerId, type TaskScore } from "../../src/data/scorers";
import { taskBenchmarkErrors, type RoleModel, type TaskBenchmark } from "../../src/data/suite";
import { BUILTIN_TEMPLATES } from "../../src/data/templates";
import { isAgentCli } from "../../src/data/types";
import { deliverableTexts, runRules } from "../../server/scorers";
import { collect, Hq, ROOT, SIGN_INS, startHq } from "./run";

export const suiteFile = (id: string) => join(ROOT, "suite", `${id}.json`);
const resultsDir = (id: string) => join(ROOT, "results", id);

export function loadTaskBenchmark(id: string): TaskBenchmark {
  if (!existsSync(suiteFile(id))) throw new Error(`No task "${id}" in the suite. Add it from the task's card in HQ (Add to benchmark suite).`);
  const b = JSON.parse(readFileSync(suiteFile(id), "utf8")) as TaskBenchmark;
  const errs = taskBenchmarkErrors(b);
  if (errs.length) throw new Error(errs.join(" "));
  return b;
}

export function listTaskBenchmarks(): TaskBenchmark[] {
  const dir = join(ROOT, "suite");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).flatMap((f) => {
    try {
      return [JSON.parse(readFileSync(join(dir, f), "utf8")) as TaskBenchmark];
    } catch {
      return [];
    }
  });
}

/** "developer=codex/gpt-5.1,lead=claude" → overrides (no model: the CLI's default). Errors name what's wrong. */
export function parseModels(spec: string | undefined, t: TeamTemplate): { overrides: RoleModel[] } | { error: string } {
  if (!spec?.trim()) return { overrides: [] };
  const overrides: RoleModel[] = [];
  for (const part of spec.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^([a-z0-9-]+)=([a-z]+)(?:\/(.+))?$/.exec(part);
    if (!m) return { error: `"${part}" isn't role=cli/model.` };
    const [, roleId, cli, model = ""] = m;
    if (!t.roles.some((r) => r.id === roleId)) return { error: `No role "${roleId}". Roles: ${t.roles.map((r) => r.id).join(", ")}.` };
    if (!isAgentCli(cli)) return { error: `"${cli}" isn't a CLI HQ runs (claude, codex, agy…).` };
    if (overrides.some((o) => o.roleId === roleId)) return { error: `${roleId} is given twice.` };
    overrides.push({ roleId, cli, model: model.trim() });
  }
  return { overrides };
}

export const modelLabel = (overrides: RoleModel[]) => (overrides.length ? overrides.map((o) => `${o.roleId}=${o.cli}${o.model ? `/${o.model}` : ""}`).join(", ") : "as recorded");

export function replayPlan(b: TaskBenchmark, overrides: RoleModel[], mode: "dry" | "run"): string[] {
  return [
    `${b.title} (task:${b.id}), ${b.kind} task from ${b.source.projectId}, template ${b.template.id} v${b.template.version}`,
    mode === "run" ? `REAL RUN: real models on your accounts, up to ${b.limits.minutes} min and $${b.limits.usd} on API-key accounts.` : "Dry run: no agent starts, nothing is spent.",
    `A throwaway HQ under ${join(ROOT, "runs")}/ with its own HOME; a clone of ${b.repo.path} at ${b.repo.commit.slice(0, 12)}, with no remote (nothing can be pushed back).`,
    `Models: ${modelLabel(overrides)}${overrides.length ? "; other roles as recorded" : ""}. Original: ${b.original.models.map((m) => `${m.roleId}=${m.cli}${m.model ? `/${m.model}` : ""}`).join(", ")}.`,
    `The task goes on the board and the lead is told to see it through: "${b.task.title.slice(0, 100)}"`,
    `It stops when the task reaches review or done, at ${b.limits.minutes} min, or at $${b.limits.usd}. Scored by ${b.scorers.filter((s) => !["summary-matches-work", "redundant-tests"].includes(s)).join(", ") || "no rule checks"} and whether it got to review.`,
  ];
}

export interface ReplayFacts {
  usd: number;
  tokens: { input: number; output: number; cached: number };
  minutes: number;
  /** The task's status when the run stopped. */
  status: string;
  gateRejections: number;
  replans: number;
  changed: string[];
  stoppedBy: "done" | "time" | "spend" | "dry" | "error";
}

export interface ReplayResult {
  benchmark: string;
  startedAt: string;
  overrides: RoleModel[];
  /** Every role's model in the run. */
  models: RoleModel[];
  label: string;
  facts: ReplayFacts;
  checks: TaskScore[];
  /** 0–1: getting to review counts as one check, each rule check as another. */
  score: number;
}

export function replayScore(status: string, checks: Pick<TaskScore, "pass">[]): number {
  const marks = [status === "in-review" || status === "done", ...checks.map((c) => c.pass)];
  return +(marks.filter(Boolean).length / marks.length).toFixed(3);
}

/** Files the run changed against the base: every local branch, and what's uncommitted in each worktree. */
export function changedSince(repo: string, base: string): string[] {
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const out = new Set<string>();
  for (const ref of git("for-each-ref", "--format=%(refname)", "refs/heads").split("\n").filter(Boolean))
    for (const f of git("diff", "--name-only", base, ref).split("\n").filter(Boolean)) out.add(f);
  for (const line of git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "))) {
    const dir = line.slice("worktree ".length);
    try {
      for (const l of execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean)) out.add(l.slice(3).replace(/^"|"$/g, ""));
    } catch {
      /* gone */
    }
  }
  return [...out].sort();
}

export interface ModelRow {
  label: string;
  runs: number;
  /** Mean dollars where priced, else null. */
  usd: number | null;
  tokens: number;
  score: number;
  minutes: number;
}

/** Each model choice's runs, averaged: the comparable cost and score pairs. */
export function compareModels(results: ReplayResult[]): ModelRow[] {
  const by = new Map<string, ReplayResult[]>();
  for (const r of results) if (r.facts.stoppedBy !== "dry") by.set(r.label, [...(by.get(r.label) ?? []), r]);
  const mean = (xs: number[]) => xs.reduce((t, x) => t + x, 0) / xs.length;
  return [...by].map(([label, rs]) => {
    const priced = rs.filter((r) => r.facts.usd > 0);
    return {
      label,
      runs: rs.length,
      usd: priced.length ? +mean(priced.map((r) => r.facts.usd)).toFixed(2) : null,
      tokens: Math.round(mean(rs.map((r) => r.facts.tokens.input + r.facts.tokens.output))),
      score: +mean(rs.map((r) => r.score)).toFixed(3),
      minutes: +mean(rs.map((r) => r.facts.minutes)).toFixed(1),
    };
  });
}

export function replayResults(id: string): ReplayResult[] {
  const dir = resultsDir(id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as ReplayResult);
}

// Dark-mode categorical slots (dataviz reference palette), in fixed order; the original run is a neutral ring.
const SLOTS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9"];
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A self-contained page: cost against score per model choice, the original run for reference, and the table. */
export function chartHtml(b: TaskBenchmark, rows: ModelRow[]): string {
  const usd = rows.every((r) => r.usd !== null) && b.original.usd !== null;
  const cost = (r: { usd: number | null; tokens: number }) => (usd ? r.usd! : r.tokens);
  const orig = { label: "original run", usd: b.original.usd, tokens: b.original.tokens, score: b.original.scores.length ? b.original.scores.filter((s) => s.pass).length / b.original.scores.length : null };
  const W = 640, H = 360, L = 64, R = 140, T = 24, B = 48; // R leaves room for the point labels
  const maxX = Math.max(1e-9, ...rows.map(cost), cost(orig)) * 1.15;
  const x = (v: number) => L + (v / maxX) * (W - L - R);
  const y = (v: number) => T + (1 - v) * (H - T - B);
  const fmt = (v: number) => (usd ? `$${v.toFixed(2)}` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}k` : String(Math.round(v)));
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const xt = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxX);
  const points = rows.map((r, i) => {
    const c = SLOTS[i % SLOTS.length]; // shortcut: an 8th model choice reuses a hue; fold into "Other" if suites get that wide
    // Direct labels for up to 4 choices (the legend table always carries them too): the model part, beside the point.
    const tag = rows.length <= 4 ? `<text x="${(x(cost(r)) + 10).toFixed(1)}" y="${(y(r.score) + 4).toFixed(1)}" style="fill:var(--ink)">${esc(r.label.split("/").pop()!.slice(0, 28))}</text>` : "";
    return `<g class="pt"><circle cx="${x(cost(r)).toFixed(1)}" cy="${y(r.score).toFixed(1)}" r="12" fill="transparent"/><circle cx="${x(cost(r)).toFixed(1)}" cy="${y(r.score).toFixed(1)}" r="6" fill="${c}" stroke="var(--surface)" stroke-width="2"/>${tag}<title>${esc(r.label)}: ${fmt(cost(r))}, score ${Math.round(r.score * 100)}%, ${r.runs} run${r.runs === 1 ? "" : "s"}</title></g>`;
  });
  const origPt = orig.score === null ? "" : `<g class="pt"><circle cx="${x(cost(orig)).toFixed(1)}" cy="${y(orig.score).toFixed(1)}" r="6" fill="none" stroke="var(--muted)" stroke-width="2"/><title>Original run: ${fmt(cost(orig))}, checks ${Math.round(orig.score * 100)}%</title></g>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(b.id)}: cost and score</title>
<style>:root{--surface:#1a1a19;--ink:#f0efec;--muted:#c3c2b7;--grid:#3a3a37}body{margin:0;padding:24px 16px;background:var(--surface);color:var(--ink);font:14px/1.45 system-ui,sans-serif}main{max-width:720px;margin:auto}h1{font-size:18px;margin:0 0 4px}p{color:var(--muted);margin:0 0 16px}svg{width:100%;height:auto}text{fill:var(--muted);font-size:11px}.pt:hover circle:last-of-type{stroke:var(--ink)}table{border-collapse:collapse;width:100%;margin-top:16px}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--grid)}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}.key{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}</style></head>
<body><main><h1>${esc(b.title)}</h1><p>Replays of one task on different models: ${usd ? "dollars" : "tokens"} per run against score (getting to review, plus each rule check). Up and to the left is better. Hover a point for its numbers.</p>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cost against score per model">
${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)" stroke-width="1"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${v * 100}%</text>`).join("")}
${xt.map((v) => `<text x="${x(v)}" y="${H - B + 18}" text-anchor="middle">${fmt(v)}</text>`).join("")}
<text x="${(L + W - R) / 2}" y="${H - 8}" text-anchor="middle">${usd ? "Dollars per run" : "Tokens per run"}</text>
${origPt}${points.join("")}
</svg>
<div style="overflow-x:auto"><table><thead><tr><th>Models</th><th class="n">Runs</th><th class="n">${usd ? "Dollars" : "Tokens"}</th><th class="n">Score</th><th class="n">Minutes</th></tr></thead><tbody>
${rows.map((r, i) => `<tr><td><span class="key" style="background:${SLOTS[i % SLOTS.length]}"></span>${esc(r.label)}</td><td class="n">${r.runs}</td><td class="n">${fmt(cost(r))}</td><td class="n">${Math.round(r.score * 100)}%</td><td class="n">${r.minutes}</td></tr>`).join("")}
${orig.score === null ? "" : `<tr><td><span class="key" style="border:2px solid var(--muted);box-sizing:border-box"></span>original run</td><td class="n">1</td><td class="n">${fmt(cost(orig))}</td><td class="n">${Math.round(orig.score * 100)}% of checks</td><td class="n">—</td></tr>`}
</tbody></table></div></main></body></html>`;
}

/** One replay. `dry`: everything but the agents. Returns the result (stored for real runs, with the chart redrawn). */
export async function runReplay(b: TaskBenchmark, opts: { dry: boolean; overrides: RoleModel[]; port?: number }): Promise<ReplayResult & { runDir: string }> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(ROOT, "runs", `${b.id}-${stamp}`);
  const home = join(runDir, "home");
  const repo = join(runDir, b.id);
  mkdirSync(home, { recursive: true });
  for (const f of SIGN_INS) if (existsSync(join(homedir(), f))) symlinkSync(join(homedir(), f), join(home, f));
  execFileSync("git", ["clone", "-q", "--no-hardlinks", b.repo.path, repo], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "checkout", "-q", "-B", "main", b.repo.commit], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "remote", "remove", "origin"], { stdio: "ignore" }); // nothing goes back to the original

  let hq: { proc: ChildProcess; token: string } | null = null;
  let chan: Hq | null = null;
  const started = Date.now();
  let stoppedBy: ReplayFacts["stoppedBy"] = opts.dry ? "dry" : "error";
  try {
    const port = opts.port ?? 7600 + Math.floor(Math.random() * 300);
    hq = await startHq(home, repo, port);
    chan = new Hq(port, hq.token, b.id);
    await chan.open();
    console.log(`• HQ on :${port}, home ${home}; repo at ${b.repo.commit.slice(0, 12)}`);
    const base = BUILTIN_TEMPLATES.some((t) => t.id === b.template.id) ? b.template.id : b.kind === "research" ? "research" : "dev";
    chan.send("completeWelcome", { projectName: b.title.slice(0, 60), templateId: base, reviewTool: "human", reviewEnabled: false });
    await chan.waitFor((x) => !!(x.config as { template?: unknown }).template && !(x as { welcome?: boolean }).welcome && (x.config as { team: unknown[] }).team.length > 0, 20_000, "the team wasn't created");
    // shortcut: the seats come from the built-in the template started from; a copy with other role ids keeps those seats.
    chan.send("updateProjectTemplate", b.template);
    for (const o of opts.overrides) chan.send("updateRole", o.roleId, { cli: o.cli, model: o.model });
    type Cfg = { template: TeamTemplate; team: { id: string; isLead: boolean; roleId?: string }[] };
    let snap = await chan.waitFor((x) => {
      const roles = (x.config as Cfg).template.roles;
      return opts.overrides.every((o) => roles.some((r) => r.id === o.roleId && r.cli === o.cli && r.model === o.model));
    }, 20_000, "the role models weren't set");
    const cfg = snap.config as Cfg;
    const models = cfg.template.roles.map((r) => ({ roleId: r.id, cli: r.cli, model: r.model }));
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(b.id)}/tasks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${hq.token}`, Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: b.task.title, description: b.task.description, doneWhen: b.task.doneWhen, files: b.task.files }),
    });
    if (!res.ok) throw new Error(`Couldn't put the task on the board: ${res.status} ${await res.text()}`);
    const taskId = ((await res.json()) as { task: { id: string } }).task.id;
    const lead = cfg.team.find((a) => a.isLead)!;
    chan.send("sendMessage", lead.id, `This is a replay of one finished task. ${taskId} is on the board: assign it to the right seat and see it through to review. Don't plan or add other work.`);
    console.log(`• ${taskId} on the board; models ${modelLabel(opts.overrides)}`);

    const status = (s: Record<string, unknown>) => ((s.tasks as { id: string; status: string }[]) ?? []).find((t) => t.id === taskId)?.status ?? "missing";
    if (!opts.dry) {
      chan.send("startAgent", lead.id);
      const end = started + b.limits.minutes * 60_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 30_000));
        snap = await chan.refresh();
        const st = status(snap);
        const spent = collect(home, b.id).usd;
        if (st === "in-review" || st === "done") { stoppedBy = "done"; break; }
        if (Date.now() > end) { stoppedBy = "time"; break; }
        if (b.limits.usd > 0 && spent >= b.limits.usd) { stoppedBy = "spend"; break; }
        console.log(`  ${((Date.now() - started) / 60_000).toFixed(1)} min, ${taskId} ${st}, $${spent.toFixed(2)}`);
      }
      for (const a of cfg.team) chan.send("stopAgent", a.id);
      await new Promise((r) => setTimeout(r, 5_000));
    }
    snap = await chan.refresh();
    const task = ((snap.tasks as { id: string; status: string; note?: string; deliverablePath?: string; files?: string[] }[]) ?? []).find((t) => t.id === taskId);
    chan.close();
    hq.proc.kill("SIGTERM");
    await new Promise((r) => hq!.proc.once("exit", r));
    const used = collect(home, b.id);
    const changed = changedSince(repo, b.repo.commit);
    const checks = runRules(b.scorers as ScorerId[], {
      task: { id: taskId, title: b.task.title, description: b.task.description, doneWhen: b.task.doneWhen, note: task?.note ?? null, files: b.task.files },
      changed: changed.length ? changed : null,
      pr: b.kind === "dev",
      files: deliverableTexts(repo, { deliverablePath: task?.deliverablePath ?? null, files: b.kind === "research" ? ["deliverables"] : [] }),
      findings: [],
      diff: null,
    });
    const facts: ReplayFacts = { usd: used.usd, tokens: used.tokens, minutes: (Date.now() - started) / 60_000, status: task?.status ?? "missing", gateRejections: used.gateRejections, replans: used.replans, changed, stoppedBy };
    const result: ReplayResult = { benchmark: b.id, startedAt: new Date(started).toISOString(), overrides: opts.overrides, models, label: modelLabel(opts.overrides), facts, checks, score: replayScore(facts.status, checks) };
    if (!opts.dry) {
      mkdirSync(resultsDir(b.id), { recursive: true });
      writeFileSync(join(resultsDir(b.id), `${stamp}.json`), JSON.stringify(result, null, 2));
      writeFileSync(join(resultsDir(b.id), "chart.html"), chartHtml(b, compareModels(replayResults(b.id))));
    }
    return { ...result, runDir };
  } finally {
    chan?.close();
    if (hq && hq.proc.exitCode === null) hq.proc.kill("SIGTERM");
  }
}

export function resultsSummary(b: TaskBenchmark): string {
  const rows = compareModels(replayResults(b.id));
  if (!rows.length) return `No replays of task:${b.id} yet.`;
  const lines = rows.map((r) => `  ${r.label.padEnd(40)} ${String(r.runs).padStart(2)} run${r.runs === 1 ? " " : "s"}  ${r.usd === null ? `${r.tokens} tok`.padStart(10) : `$${r.usd.toFixed(2)}`.padStart(10)}  score ${Math.round(r.score * 100)}%  ${r.minutes} min`);
  return [`${b.title}`, `  original: ${b.original.usd === null ? `${b.original.tokens} tok` : `$${b.original.usd.toFixed(2)}`}`, ...lines, `  chart: ${join(resultsDir(b.id), "chart.html")}`].join("\n");
}
