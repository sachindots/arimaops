// The benchmark harness (docs/templates.md section 9): definitions, pinning, the isolated network, the paid-run guard,
// scoring and comparison, and a free dry run end to end (when Docker and the self-test image are here).
// Run: npx tsx scripts/bench-test.ts
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "arima-bench-test-")); // ~/.arima-bench lands here, not in your home
const { BENCHMARKS, benchmarkErrors, imageRef } = await import("./bench/benchmarks");
const { compareRuns, marketingChecks, scoreAnswers, scoreFindings, scoreRun } = await import("./bench/score");
const { plan, runBenchmark, targetCommands, teardownCommands } = await import("./bench/run");
import type { RunFacts, RunResult } from "./bench/score";

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};
const byId = (id: string) => BENCHMARKS.find((b) => b.id === id)!;

check("every benchmark is valid", BENCHMARKS.every((b) => benchmarkErrors(b).length === 0), JSON.stringify(BENCHMARKS.map((b) => [b.id, benchmarkErrors(b)])));
check("security, research and marketing are covered", ["security", "research", "marketing"].every((k) => BENCHMARKS.some((b) => b.kind === k && !b.selftest)));
check("a bad definition is refused with why", benchmarkErrors({ ...byId("juice-shop"), id: "Bad Id", brief: "no target here", known: [] }).length === 3);
const js = imageRef(byId("juice-shop"));
check("targets run by digest", "ref" in js && /^bkimminich\/juice-shop@sha256:[0-9a-f]{64}$/.test(js.ref));
const dv = imageRef(byId("dvwa"));
check("an unpinned target is refused, saying how to pin it", "error" in dv && /isn't pinned yet/.test(dv.error) && /RepoDigests/.test(dv.error));
const cmds = targetCommands(byId("juice-shop"), "img@sha256:x", "s1");
check("the target's network is internal (no route out) and the container is limited", cmds[0].includes("--internal") && cmds[1].includes("--network") && cmds[1].includes("arima-bench-juice-shop") && cmds[1].includes("--memory") && cmds[1].at(-1) === "img@sha256:x");
check("teardown removes the container and the network", JSON.stringify(teardownCommands(byId("juice-shop"), "s1")) === JSON.stringify([["rm", "-f", "arima-bench-juice-shop-target"], ["network", "rm", "arima-bench-juice-shop"]]));
const real = plan(byId("juice-shop"), "run").join("\n");
check("a real run's plan says it costs money, its limits, and what it links", /REAL RUN/.test(real) && /90 min/.test(real) && /\$15/.test(real) && /own HOME/.test(real) && /only scope entry/.test(real));
check("a dry run's plan says nothing is spent", /nothing is spent/.test(plan(byId("juice-shop"), "dry").join()));

// The paid-run guard: no terminal, no run. And the bare id only shows the plan.
const cli = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/bench/run.ts", ...args], { encoding: "utf8", input: "juice-shop\n", env: process.env });
const piped = cli("juice-shop", "--run");
check("--run with no terminal refuses, even when the id is piped in", /needs you at a terminal/.test(piped.stderr) && /Not started/.test(piped.stdout), piped.stdout + piped.stderr);
const shown = cli("research-rag-origins");
check("naming a benchmark only shows its plan", /Nothing started/.test(shown.stdout) && !/HQ on/.test(shown.stdout));
check("the self-test can't be a paid run", /never starts agents/.test(cli("selftest", "--run").stderr));

// Scoring.
const f = (id: string, title: string, cwe: string[], status = "open") => ({ id, title, cwe, severity: "high", status, verified: false });
const known = byId("juice-shop").known!;
const s = scoreFindings(known, [f("F-1", "Login bypass", ["CWE-89"]), f("F-2", "Reflected XSS in search", []), f("F-3", "Missing security headers", ["CWE-693"]), f("F-4", "SQLi again", ["CWE-89"]), f("F-5", "Open redirect", ["CWE-601"], "false-positive")]);
check("findings match by CWE or title; each known one counts once", s.hit.join() === "sqli-login,xss" && s.recall === 2 / known.length);
check("a finding marked false positive never counts; unlisted ones lower precision", !s.hit.includes("redirect") && s.unlisted.join() === "F-3" && s.precision === 3 / 4);
const a = scoreAnswers(byId("research-rag-origins").answers!, { "deliverables/report.md": "RAG (arXiv:2005.11401), DPR arXiv 2004.04906, REALM https://arxiv.org/abs/2002.08909v1" });
check("research answers are matched in the deliverables", a.hit.join() === "rag,dpr,realm" && a.missed.join() === "fid,retro");
const draft = "Subject: Meet Tidepool\nFree for teams up to 10. Digests arrive Monday 9:00.\nDRAFT: not sent";
const good = marketingChecks({ "deliverables/brief.md": "x", "deliverables/drafts/a.md": draft, "deliverables/drafts/b.md": draft, "deliverables/drafts/c.md": draft }, 0);
check("marketing checks pass on good drafts", Object.values(good).every(Boolean), JSON.stringify(good));
const bad = marketingChecks({ "deliverables/drafts/a.md": "Join 5,000 teams who save 40% of meeting time!" }, 2);
check("…and catch a missing brief, unmarked drafts, invented numbers and a send attempt", !bad.brief && !bad.drafts && !bad.marked && !bad["no-invented-numbers"] && !bad["nothing-sent"]);

const facts = (over: Partial<RunFacts>): RunFacts => ({ findings: [], files: {}, blockedSends: 0, minutes: 10, usd: 2, tokens: { input: 0, output: 0, cached: 0 }, gateRejections: 1, replans: 0, tasks: { total: 3, done: 3 }, stoppedBy: "done", ...over });
const run = (fs: RunFacts): RunResult => ({ benchmark: "juice-shop", startedAt: "", image: null, facts: fs, score: scoreRun(byId("juice-shop"), fs) });
const before = run(facts({ findings: [f("F-1", "x", ["CWE-89"])] }));
const now = run(facts({ findings: [f("F-1", "x", ["CWE-79"])], usd: 3.5, minutes: 12, gateRejections: 3 }));
const c = compareRuns(now, before)!;
check("a run is compared with the last one", c.recall === 0 && c.usd === 1.5 && c.minutes === 2 && c.gateRejections === 2 && c.newlyHit.join() === "xss" && c.newlyMissed.join() === "sqli-login");
check("the first run has nothing to compare with", compareRuns(now, null) === null);

// The free dry run, end to end: target on its own network, a throwaway HQ, the team, lab mode and scope, teardown.
let haveImage = false;
try {
  execFileSync("docker", ["image", "inspect", `nginx@${byId("selftest").target!.digest}`], { stdio: "ignore" });
  haveImage = true;
} catch {
  /* no Docker or no image: skipped */
}
if (!haveImage) console.log("- dry run skipped: Docker or the self-test image (nginx at its pinned digest) isn't here");
else {
  const r = await runBenchmark(byId("selftest"), { dry: true });
  check("the dry run sets up and tears down without agents or spend", r.facts.stoppedBy === "dry" && r.facts.usd === 0 && r.facts.tokens.input === 0 && r.image === `nginx@${byId("selftest").target!.digest}`);
  const left = execFileSync("docker", ["ps", "-aq", "--filter", "name=arima-bench-selftest"], { encoding: "utf8" }).trim() + execFileSync("docker", ["network", "ls", "-q", "--filter", "name=arima-bench-selftest"], { encoding: "utf8" }).trim();
  check("…and leaves no container or network behind", left === "", left);
}

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
