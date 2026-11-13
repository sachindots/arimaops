// SPDX-License-Identifier: AGPL-3.0-or-later
// The benchmark runner (docs/templates.md section 9).
//
//   pnpm bench                     list the benchmarks
//   pnpm bench <id>                show what a run would do (nothing starts)
//   pnpm bench <id> --dry          set everything up and tear it down without starting an agent (free)
//   pnpm bench <id> --run          a real run: real models, real money. Asks you to type the id first, at a terminal.
//   pnpm bench task:<id> …         replay a task from your suite on other models (replay.ts)
//
// A run gets its own HQ: a throwaway HOME under ~/.arima-bench/runs/ (your ~/.arima is never touched), your CLI
// sign-in folders linked into it so agents can sign in, a fresh repo, and for security benchmarks the target container
// on its own internal Docker network (no internet), lab mode, and the target as the only scope entry. Agents run in
// container mode, so HQ's proxy keeps them to that scope. Results go to ~/.arima-bench/results/<id>/.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import { BENCHMARKS, benchmarkErrors, imageRef, type Benchmark } from "./benchmarks";
import { compareRuns, scoreRun, summary, type RunFacts, type RunResult } from "./score";

export const ROOT = join(homedir(), ".arima-bench");
export const SIGN_INS = [".claude", ".claude.json", ".codex", ".gemini"];
export const REPO = new URL("../..", import.meta.url).pathname;

export const names = (b: Benchmark, stamp: string) => ({ network: `arima-bench-${b.id}`, target: `arima-bench-${b.id}-target`, run: join(ROOT, "runs", `${b.id}-${stamp}`) });

/** The docker commands for a target: an internal network (no route out) and the pinned image on it. */
export function targetCommands(b: Benchmark, ref: string, stamp: string): string[][] {
  const n = names(b, stamp);
  return [
    ["network", "create", "--internal", "--label", "arima-bench=1", n.network],
    ["run", "-d", "--rm", "--name", n.target, "--network", n.network, "--label", "arima-bench=1", "--memory", "2g", "--pids-limit", "512", ref, ...(b.target?.args ?? [])],
  ];
}

export const teardownCommands = (b: Benchmark, stamp: string): string[][] => {
  const n = names(b, stamp);
  return [["rm", "-f", n.target], ["network", "rm", n.network]];
};

/** What a run will do, in words, before anything starts. */
export function plan(b: Benchmark, mode: "dry" | "run"): string[] {
  const ref = imageRef(b);
  return [
    `${b.title} (${b.id}), template ${b.templateId}`,
    mode === "run" ? `REAL RUN: real models on your accounts, up to ${b.limits.minutes} min and $${b.limits.usd} on API-key accounts (subscription use is counted in tokens).` : "Dry run: no agent starts, nothing is spent.",
    `A throwaway HQ under ${join(ROOT, "runs")}/ with its own HOME; ${SIGN_INS.filter((f) => existsSync(join(homedir(), f))).join(", ")} linked from your home so agents can sign in.`,
    ...(b.kind === "security"
      ? ["error" in ref ? `Target: ${ref.error}` : `Target: ${ref.ref} on an internal Docker network (no internet), lab mode, the target as the only scope entry; agents in container mode behind HQ's proxy.`]
      : [`An empty repo in deliverables mode${b.templateId === "research" ? "; the paper APIs are the only extra hosts" : b.templateId === "marketing" ? "; drafts only (mail, social and CRM hosts blocked)" : ""}.`]),
    `The brief goes to the lead: "${b.brief.replace("{target}", "<target>").slice(0, 140)}…"`,
    `It stops when every task is done, at ${b.limits.minutes} min, or at $${b.limits.usd}; then the agents stop, HQ stops and the target is removed.`,
  ];
}

const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** HQ's command channel: the WebSocket the browser uses. */
export class Hq {
  private ws!: WebSocket;
  snap: Record<string, unknown> | null = null;
  activity: string[] = [];
  constructor(
    private port: number,
    private token: string,
    private project: string,
  ) {}
  async open() {
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws?project=${encodeURIComponent(this.project)}&token=${this.token}`, { headers: { Origin: `http://127.0.0.1:${this.port}` } });
    this.ws.on("message", (raw) => {
      const e = JSON.parse(String(raw)) as { type: string; snapshot?: Record<string, unknown>; event?: { text: string } };
      if (e.type === "snapshot") this.snap = e.snapshot!;
      if (e.type === "activity" && e.event) this.activity.push(e.event.text);
    });
    await this.until(() => !!this.snap, 20_000, "no snapshot from HQ");
  }
  send(cmd: string, ...args: unknown[]) {
    this.ws.send(JSON.stringify({ cmd, args }));
  }
  /** A fresh snapshot (reconnecting is the simplest way to get the whole state). */
  async refresh() {
    this.ws.close();
    this.snap = null;
    await this.open();
    return this.snap!;
  }
  /** Refreshes until `ok` holds on the snapshot: HQ applies commands asynchronously. */
  async waitFor(ok: (snap: Record<string, unknown>) => boolean, ms: number, what: string): Promise<Record<string, unknown>> {
    const end = Date.now() + ms;
    for (;;) {
      const snap = await this.refresh();
      if (ok(snap)) return snap;
      if (Date.now() > end) throw new Error(`Timed out: ${what}.`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  async until(ok: () => boolean, ms: number, what: string) {
    const end = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > end) throw new Error(`Timed out: ${what}.`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  close() {
    this.ws?.close();
  }
}

export function startHq(home: string, repo: string, port: number): Promise<{ proc: ChildProcess; token: string }> {
  const proc = spawn(process.execPath, [join(REPO, "dist-server/main.mjs"), "--repo", repo, "--port", String(port), "--no-open"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: home, ARIMA_MASTER_KEY: randomBytes(32).toString("hex") },
  });
  let log = "";
  return new Promise((done, fail) => {
    const onData = (d: Buffer) => {
      log += d;
      const m = log.match(/token=([a-f0-9]+)/);
      if (m) done({ proc, token: m[1] });
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    proc.on("exit", (code) => fail(new Error(`HQ exited (code ${code}):\n${log.slice(-2000)}`)));
    setTimeout(() => fail(new Error(`HQ didn't start in 60 s:\n${log.slice(-2000)}`)), 60_000);
  });
}

/** Every file under deliverables/, by repo-relative path. */
function deliverables(repo: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (statSync(p).size < 512 * 1024) out[relative(repo, p)] = readFileSync(p, "utf8");
    }
  };
  walk(join(repo, "deliverables"));
  return out;
}

/** What the run's HQ recorded, read from its database once it has stopped. */
export function collect(home: string, projectId: string): Pick<RunFacts, "findings" | "usd" | "tokens" | "gateRejections" | "replans"> {
  const db = new DatabaseSync(join(home, ".arima", "arima.db"), { readOnly: true });
  try {
    const findings = (db.prepare("SELECT id, title, cwe, severity, status, verified FROM findings WHERE project_id = ?").all(projectId) as { id: string; title: string; cwe: string; severity: string; status: string; verified: number }[]).map((f) => ({
      id: f.id,
      title: f.title,
      cwe: JSON.parse(f.cwe) as string[],
      severity: f.severity,
      status: f.status,
      verified: f.verified === 1,
    }));
    const u = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) usd, COALESCE(SUM(input), 0) input, COALESCE(SUM(output), 0) output, COALESCE(SUM(cached), 0) cached FROM usage_events WHERE project_id = ?").get(projectId) as { usd: number; input: number; output: number; cached: number };
    const gateRejections = (db.prepare("SELECT COUNT(*) n FROM gate_events WHERE project_id = ? AND state = 'failed'").get(projectId) as { n: number }).n;
    // Replans live in the memory ledger: the local copy (and what's still queued for Neo4j).
    const replans =
      (db.prepare("SELECT COUNT(*) n FROM ledger WHERE project_id = ? AND kind = 'replan'").get(projectId) as { n: number }).n +
      (db.prepare(`SELECT COUNT(*) n FROM memory_outbox WHERE project_id = ? AND op LIKE '%"kind":"replan"%'`).get(projectId) as { n: number }).n;
    return { findings, usd: u.usd, tokens: { input: u.input, output: u.output, cached: u.cached }, gateRejections, replans };
  } finally {
    db.close();
  }
}

export function lastResult(id: string): RunResult | null {
  const dir = join(ROOT, "results", id);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  return files.length ? (JSON.parse(readFileSync(join(dir, files.at(-1)!), "utf8")) as RunResult) : null;
}

export async function confirmPaid(b: { id: string }): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error("A real run needs you at a terminal to confirm it: run it yourself, not from a script.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nThis spends real money. Type "${b.id}" to start, anything else to stop: `);
  rl.close();
  return answer.trim() === b.id;
}

/** One run. `dry`: everything but the agents. Returns the stored result. */
export async function runBenchmark(b: Benchmark, opts: { dry: boolean; port?: number }): Promise<RunResult> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const n = names(b, stamp);
  const home = join(n.run, "home");
  const repo = join(n.run, b.id);
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  for (const f of SIGN_INS) if (existsSync(join(homedir(), f))) symlinkSync(join(homedir(), f), join(home, f));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), `# ${b.title}\n\nBenchmark run ${stamp}.\n`);
  execFileSync("git", ["-c", "user.name=bench", "-c", "user.email=bench@localhost", "add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=bench", "-c", "user.email=bench@localhost", "commit", "-qm", "init"], { cwd: repo });

  let target: string | null = null;
  let image: string | null = null;
  let hq: { proc: ChildProcess; token: string } | null = null;
  let chan: Hq | null = null;
  const started = Date.now();
  let stoppedBy: RunFacts["stoppedBy"] = opts.dry ? "dry" : "error";
  try {
    if (b.kind === "security") {
      const ref = imageRef(b);
      if ("error" in ref) throw new Error(ref.error);
      image = ref.ref;
      for (const args of targetCommands(b, ref.ref, stamp)) docker(args);
      const ip = docker(["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", n.target]);
      target = `${ip}:${b.target!.port}`;
      console.log(`• target ${image} at ${target} (internal network ${n.network})`);
    }
    const port = opts.port ?? 7600 + Math.floor(Math.random() * 300);
    hq = await startHq(home, repo, port);
    chan = new Hq(port, hq.token, b.id);
    await chan.open();
    console.log(`• HQ on :${port}, home ${home}`);
    chan.send("completeWelcome", { projectName: b.title, templateId: b.templateId, reviewTool: "human", reviewEnabled: false });
    let snap = await chan.waitFor((x) => !!(x.config as { template?: unknown }).template && !(x as { welcome?: boolean }).welcome && (x.config as { team: unknown[] }).team.length > 0, 20_000, "the team wasn't created");
    const cfg = snap.config as { template: { id: string }; team: { id: string; isLead: boolean }[]; rules: { labMode: boolean } };
    if (b.kind === "security") {
      chan.send("setLabMode", true);
      chan.send("updateProject", { scope: { inScope: [target], outOfScope: [], rules: "Benchmark target only. Nothing else, ever." } });
      chan.send("setTeamMode", "container");
    }
    const lead = cfg.team.find((a) => a.isLead)!;
    chan.send("sendMessage", lead.id, b.brief.replace("{target}", target ?? ""));
    type After = { project: { scope?: { inScope: string[] } }; rules: { labMode: boolean }; template: { id: string } };
    snap = await chan.waitFor((x) => {
      const c = x.config as After;
      return b.kind !== "security" || (c.rules.labMode && c.project.scope?.inScope.join() === target);
    }, 20_000, "HQ didn't take lab mode and the scope");
    const after = snap.config as After;
    console.log(`• team from ${after.template.id}${b.kind === "security" ? `, lab mode, scope ${target}` : ""}; brief sent to the lead`);

    if (!opts.dry) {
      chan.send("startAgent", lead.id);
      const end = started + b.limits.minutes * 60_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 30_000));
        snap = await chan.refresh();
        const tasks = (snap.tasks as { status: string }[]) ?? [];
        const spent = collect(home, b.id).usd;
        if (tasks.length && tasks.every((t) => t.status === "done")) { stoppedBy = "done"; break; }
        if (Date.now() > end) { stoppedBy = "time"; break; }
        if (b.limits.usd > 0 && spent >= b.limits.usd) { stoppedBy = "spend"; break; }
        console.log(`  ${((Date.now() - started) / 60_000).toFixed(1)} min, ${tasks.filter((t) => t.status === "done").length}/${tasks.length} tasks done, $${spent.toFixed(2)}`);
      }
      for (const a of cfg.team) chan.send("stopAgent", a.id);
      await new Promise((r) => setTimeout(r, 5_000));
    }
    snap = await chan.refresh();
    const tasks = (snap.tasks as { status: string }[]) ?? [];
    chan.close();
    hq.proc.kill("SIGTERM");
    await new Promise((r) => hq!.proc.once("exit", r));
    const facts: RunFacts = {
      ...collect(home, b.id),
      files: deliverables(repo),
      blockedSends: chan.activity.filter((t) => /blocked, this project is drafts only/.test(t)).length,
      minutes: (Date.now() - started) / 60_000,
      tasks: { total: tasks.length, done: tasks.filter((t) => t.status === "done").length },
      stoppedBy,
    };
    const result: RunResult = { benchmark: b.id, startedAt: new Date(started).toISOString(), image, facts, score: scoreRun(b, facts) };
    if (!opts.dry) {
      const before = lastResult(b.id);
      mkdirSync(join(ROOT, "results", b.id), { recursive: true });
      writeFileSync(join(ROOT, "results", b.id, `${stamp}.json`), JSON.stringify(result, null, 2));
      console.log(`\n${summary(b, result, compareRuns(result, before))}`);
    }
    return result;
  } finally {
    chan?.close();
    if (hq && hq.proc.exitCode === null) hq.proc.kill("SIGTERM");
    if (b.kind === "security")
      for (const args of teardownCommands(b, stamp))
        try {
          docker(args);
        } catch {
          /* already gone */
        }
  }
}

/** `pnpm bench task:<id> [--dry|--run|--results] [--models role=cli/model,…]`: a task from the suite (replay.ts). */
async function mainTask(id: string, args: string[]) {
  const { loadTaskBenchmark, parseModels, replayPlan, resultsSummary, runReplay } = await import("./replay");
  const b = loadTaskBenchmark(id);
  if (args.includes("--results")) return console.log(resultsSummary(b));
  const at = args.indexOf("--models");
  const parsed = parseModels(at >= 0 ? args[at + 1] : undefined, b.template);
  if ("error" in parsed) throw new Error(parsed.error);
  const mode = args.includes("--run") ? "run" : args.includes("--dry") ? "dry" : null;
  console.log(replayPlan(b, parsed.overrides, mode === "run" ? "run" : "dry").map((l) => `  ${l}`).join("\n"));
  if (!mode) return console.log("\nNothing started. Add --dry to set up and tear down without agents (free), or --run for a real run.");
  if (mode === "run" && !(await confirmPaid({ id: `task:${b.id}` }))) return console.log("Not started.");
  if (!existsSync(join(REPO, "dist-server/main.mjs"))) throw new Error("Build HQ first: pnpm build.");
  const r = await runReplay(b, { dry: mode === "dry", overrides: parsed.overrides });
  if (mode === "dry") console.log(`\n✓ dry run: clone at ${b.repo.commit.slice(0, 12)}, HQ, team (${r.label}) and the task set up and torn down; nothing spent.`);
  else console.log(`\n${resultsSummary(b)}`);
}

async function main() {
  const [id, flag] = process.argv.slice(2);
  if (id?.startsWith("task:")) return mainTask(id.slice(5), process.argv.slice(3));
  if (!id) {
    for (const b of BENCHMARKS) {
      const errs = benchmarkErrors(b);
      const ref = b.kind === "security" ? imageRef(b) : null;
      console.log(`${b.id.padEnd(22)} ${b.title}${errs.length ? `  (invalid: ${errs.join(" ")})` : ref && "error" in ref ? "  (target not pinned yet)" : ""}`);
    }
    const { listTaskBenchmarks } = await import("./replay");
    for (const t of listTaskBenchmarks()) console.log(`${`task:${t.id}`.padEnd(22)} ${t.title}  (your own task, ${t.kind})`);
    return;
  }
  const b = BENCHMARKS.find((x) => x.id === id);
  if (!b) throw new Error(`No benchmark "${id}". Run pnpm bench to list them.`);
  const errs = benchmarkErrors(b);
  if (errs.length) throw new Error(errs.join(" "));
  const mode = flag === "--run" ? "run" : flag === "--dry" ? "dry" : null;
  console.log(plan(b, mode === "run" ? "run" : "dry").map((l) => `  ${l}`).join("\n"));
  if (!mode) return console.log("\nNothing started. Add --dry to set up and tear down without agents (free), or --run for a real run.");
  if (mode === "run" && b.selftest) throw new Error("The self-test never starts agents: use --dry.");
  if (mode === "run" && !(await confirmPaid(b))) return console.log("Not started.");
  if (!existsSync(join(REPO, "dist-server/main.mjs"))) throw new Error("Build HQ first: pnpm build.");
  const r = await runBenchmark(b, { dry: mode === "dry" });
  if (mode === "dry") console.log(`\n✓ dry run: HQ, team${b.kind === "security" ? ", lab mode, scope and target" : ""} set up and torn down; ${r.facts.findings.length} findings, $${r.facts.usd.toFixed(2)}.`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  main().catch((e) => {
    console.error(`✗ ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
