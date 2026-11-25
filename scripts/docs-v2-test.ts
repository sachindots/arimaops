import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const files = execFileSync(
  "git",
  ["ls-files", "README.md", "AGENTS.md", "CONTRIBUTING.md", "SECURITY.md", "docs", "site"],
  { cwd: root, encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter(Boolean);

const banned = /\b(npx\s+arimaops|pnpm\s+dev:hq|bin\/arimaops|dist-server)\b/;
const hits: string[] = [];

for (const rel of files) {
  if (!/\.(md|html|txt)$/i.test(rel)) continue;
  const lines = fs.readFileSync(path.join(root, rel), "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(banned);
    if (m) hits.push(`${rel}:${i + 1}: ${m[0]}`);
  }
}

if (hits.length > 0) {
  console.error("Stale v1 doc references found:\n" + hits.join("\n"));
  process.exit(1);
}

console.log(`✓ ${files.length} tracked doc files clean of v1 references`);
