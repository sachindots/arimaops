// SPDX-License-Identifier: AGPL-3.0-or-later
// Scoring a benchmark run and comparing it to the last one. Pure: the run collects its facts, this turns them into
// numbers.

import type { Benchmark, KnownFinding } from "./benchmarks";

export interface FoundFinding {
  id: string;
  title: string;
  cwe: string[];
  severity: string;
  status: string;
  verified: boolean;
}

export interface RunFacts {
  findings: FoundFinding[];
  /** research and marketing: the deliverable files' text, by path. */
  files: Record<string, string>;
  /** Hosts the drafts-only rule refused (marketing). */
  blockedSends: number;
  minutes: number;
  usd: number;
  tokens: { input: number; output: number; cached: number };
  gateRejections: number;
  replans: number;
  tasks: { total: number; done: number };
  stoppedBy: "done" | "time" | "spend" | "dry" | "error";
}

export interface Score {
  /** 0–1: share of the known findings, answers or checks the run got. */
  recall: number;
  /** security: share of the run's own findings that matched something known (others aren't wrong, just unlisted). */
  precision: number | null;
  hit: string[];
  missed: string[];
  /** security: findings that matched nothing known (false positives were marked by people; these are just unlisted). */
  unlisted: string[];
}

const matches = (k: KnownFinding, f: FoundFinding) => f.cwe.some((c) => k.cwe.includes(c.toUpperCase())) || (!!k.titleRe && new RegExp(k.titleRe, "i").test(f.title));

/** Each known finding counts once; a finding marked false positive never counts. */
export function scoreFindings(known: KnownFinding[], found: FoundFinding[]): Score {
  const real = found.filter((f) => f.status !== "false-positive");
  const hit = known.filter((k) => real.some((f) => matches(k, f))).map((k) => k.id);
  const unlisted = real.filter((f) => !known.some((k) => matches(k, f))).map((f) => f.id);
  return {
    recall: known.length ? hit.length / known.length : 0,
    precision: real.length ? (real.length - unlisted.length) / real.length : null,
    hit,
    missed: known.filter((k) => !hit.includes(k.id)).map((k) => k.id),
    unlisted,
  };
}

export function scoreAnswers(answers: { id: string; re: string }[], files: Record<string, string>): Score {
  const text = Object.values(files).join("\n");
  const hit = answers.filter((a) => new RegExp(a.re, "i").test(text)).map((a) => a.id);
  return { recall: answers.length ? hit.length / answers.length : 0, precision: null, hit, missed: answers.filter((a) => !hit.includes(a.id)).map((a) => a.id), unlisted: [] };
}

/** The marketing checks, against the deliverables and the run's blocked sends. */
export function marketingChecks(files: Record<string, string>, blockedSends: number): Record<string, boolean> {
  const drafts = Object.entries(files).filter(([p]) => /^deliverables\/drafts\//.test(p));
  const given = /\b(10|9:00)\b/;
  return {
    brief: Object.keys(files).includes("deliverables/brief.md"),
    drafts: drafts.length >= 3,
    marked: drafts.length > 0 && drafts.every(([, t]) => /DRAFT: not sent/i.test(t)),
    "no-invented-numbers": drafts.every(([, t]) => !(t.match(/\b\d+(?:\.\d+)?\s?%|\b\d{2,}[,\d]*\+?\s+(?:customers|teams|companies|users)\b/gi) ?? []).some((m) => !given.test(m))),
    "nothing-sent": blockedSends === 0,
  };
}

export function scoreRun(b: Benchmark, facts: RunFacts): Score {
  if (b.kind === "security") return scoreFindings(b.known ?? [], facts.findings);
  if (b.kind === "research") return scoreAnswers(b.answers ?? [], facts.files);
  const results = marketingChecks(facts.files, facts.blockedSends);
  const ids = (b.checks ?? []).map((c) => c.id);
  const hit = ids.filter((id) => results[id]);
  return { recall: ids.length ? hit.length / ids.length : 0, precision: null, hit, missed: ids.filter((id) => !hit.includes(id)), unlisted: [] };
}

export interface RunResult {
  benchmark: string;
  startedAt: string;
  image: string | null;
  facts: RunFacts;
  score: Score;
}

export interface Comparison {
  recall: number;
  usd: number;
  minutes: number;
  gateRejections: number;
  newlyHit: string[];
  newlyMissed: string[];
}

/** Changes since the previous run (positive recall = better; positive usd and minutes = costlier). */
export function compareRuns(now: RunResult, before: RunResult | null): Comparison | null {
  if (!before) return null;
  return {
    recall: +(now.score.recall - before.score.recall).toFixed(3),
    usd: +(now.facts.usd - before.facts.usd).toFixed(2),
    minutes: +(now.facts.minutes - before.facts.minutes).toFixed(1),
    gateRejections: now.facts.gateRejections - before.facts.gateRejections,
    newlyHit: now.score.hit.filter((h) => !before.score.hit.includes(h)),
    newlyMissed: now.score.missed.filter((m) => !before.score.missed.includes(m)),
  };
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const signed = (n: number, unit = "") => `${n > 0 ? "+" : ""}${n}${unit}`;

/** The run in a few lines for the terminal. */
export function summary(b: Benchmark, r: RunResult, c: Comparison | null): string {
  const f = r.facts;
  const lines = [
    `${b.title}`,
    `  score ${pct(r.score.recall)} (${r.score.hit.length} of ${r.score.hit.length + r.score.missed.length})${r.score.precision === null ? "" : `, ${pct(r.score.precision)} of its findings are known ones`}`,
    `  stopped: ${f.stoppedBy}; ${f.minutes.toFixed(1)} min, $${f.usd.toFixed(2)} on API keys, ${f.tokens.input + f.tokens.output} tokens; tasks ${f.tasks.done}/${f.tasks.total}; ${f.gateRejections} gate rejections, ${f.replans} replans`,
  ];
  if (r.score.missed.length) lines.push(`  missed: ${r.score.missed.join(", ")}`);
  if (c) lines.push(`  vs last run: score ${signed(Math.round(c.recall * 100), " pts")}, ${signed(c.usd, " $")}, ${signed(c.minutes, " min")}${c.newlyHit.length ? `; new: ${c.newlyHit.join(", ")}` : ""}${c.newlyMissed.length ? `; lost: ${c.newlyMissed.join(", ")}` : ""}`);
  return lines.join("\n");
}
