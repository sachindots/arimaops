// .arima/facts.md: short, durable facts about the repo (build/test commands, layout, gotchas) that every
// agent gets in its task brief, so a fresh conversation doesn't re-explore the repo. Plain markdown
// bullets, versioned with the project; you or the lead can edit it like any file.

import { existsSync, readFileSync } from "node:fs";
import { repoDirOf } from "./paths";
import { join } from "node:path";

const MAX_FACTS = 40;
const MAX_LEN = 160;
// Facts that would make agents cut corners are never kept.
const UNSAFE = /\b(skip|don'?t|no need to|without)\b.{0,30}\b(test|tests|testing|verify|check|review|lint|vet)/i;

export const factsPath = (repoRoot: string) => join(repoDirOf(repoRoot), "facts.md");

export function readFacts(repoRoot: string): string[] {
  const file = factsPath(repoRoot);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
    .filter((l) => l && !l.startsWith("#") && l.length <= MAX_LEN && !UNSAFE.test(l))
    .slice(-MAX_FACTS);
}
