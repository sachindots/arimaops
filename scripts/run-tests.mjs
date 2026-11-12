// Runs every scripts/*-test.ts in its own process and fails if any fails.
//   pnpm test              all tests
//   pnpm test auth users   only the named ones
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const only = process.argv.slice(2);
const tests = readdirSync("scripts")
  .filter((f) => f.endsWith("-test.ts"))
  .filter((f) => only.length === 0 || only.includes(f.replace(/-test\.ts$/, "")))
  .sort();
if (tests.length === 0) {
  console.error(`no tests match: ${only.join(" ")}`);
  process.exit(1);
}

const failed = [];
for (const f of tests) {
  console.log(`\n▶ ${f}`);
  const r = spawnSync(process.execPath, ["--import", "tsx", `scripts/${f}`], { stdio: "inherit" });
  if (r.status !== 0) failed.push(f);
}
console.log(`\n${tests.length - failed.length}/${tests.length} passed`);
if (failed.length) {
  console.error(`failed: ${failed.join(", ")}`);
  process.exit(1);
}
