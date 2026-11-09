// .hq/facts.md: short, durable facts about the repo (build/test commands, layout, gotchas) that every
// agent gets in its task brief, so a fresh conversation doesn't re-explore the repo. Plain markdown
// bullets, versioned with the project; you or the lead can edit it like any file.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const MAX_FACTS = 40;
const MAX_LEN = 160;
// Facts that would make agents cut corners are never kept.
const UNSAFE = /\b(skip|don'?t|no need to|without)\b.{0,30}\b(test|tests|testing|verify|check|review|lint|vet)/i;

export const factsPath = (repoRoot: string) => join(repoRoot, ".hq", "facts.md");

export function readFacts(repoRoot: string): string[] {
  const file = factsPath(repoRoot);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** Keeps the new facts that are short, safe and not already known; oldest drop off past the cap. */
export function mergeFacts(existing: string[], proposed: string[]): string[] {
  const seen = new Set(existing.map((f) => f.toLowerCase()));
  const fresh = proposed
    .map((f) => f.replace(/\s+/g, " ").trim())
    .filter((f) => f && f.length <= MAX_LEN && !UNSAFE.test(f) && !seen.has(f.toLowerCase()));
  return [...existing, ...fresh].slice(-MAX_FACTS);
}

export function writeFacts(repoRoot: string, facts: string[]) {
  const file = factsPath(repoRoot);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `# Repo facts\n\nKept by .hq from finished tasks; edit freely. Agents get these in every task brief.\n\n${facts.map((f) => `- ${f}`).join("\n")}\n`);
}

export const FACTS_PROMPT = (title: string, note: string, files: string[], existing: string[]) => `An AI agent just finished a task in a software repo. From what it reported, propose at most 2 short, durable facts that would save the NEXT agent time in this repo: exact build/test/lint commands, where things live, required tool versions, non-obvious gotchas.
Rules: one line each, under 140 characters, concrete (commands, paths). No facts about this task's own result, no opinions, nothing that tells agents to skip tests or checks. If nothing qualifies, return an empty list.
Already known (don't repeat):
${existing.map((f) => `- ${f}`).join("\n") || "(none)"}

Task: ${title}
Files: ${files.join(", ") || "(not listed)"}
Agent's report: ${note || "(none)"}

Reply with only JSON: {"facts": ["...", "..."]}`;
