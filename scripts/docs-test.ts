// Saved state in SQLite: the one-time JSON import, its backup, and crashes mid-write.
// Run: npx tsx scripts/docs-test.ts
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLine, BACKUP_SUFFIX, closeDocs, DB_FILE, readDoc, readLines, writeDoc } from "../server/lib/docs";

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};
const fresh = () => mkdtempSync(join(tmpdir(), "arima-docs-"));

// Upgrade from JSON files.
{
  const dir = fresh();
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ team: ["lead"] }, null, 2) + "\n");
  writeFileSync(join(dir, "audit.log"), "line one\nline two\n");
  check("an existing JSON file is imported", JSON.stringify(readDoc(file)) === '{"team":["lead"]}');
  check("the JSON file is kept as a backup", !existsSync(file) && readFileSync(file + BACKUP_SUFFIX, "utf8").includes("lead"));
  check("the database is private to this user", (statSync(join(dir, DB_FILE)).mode & 0o777) === 0o600);
  writeDoc(file, { team: ["lead", "dev"] });
  check("later writes win over the backup", (readDoc<{ team: string[] }>(file)?.team.length ?? 0) === 2);
  appendLine(join(dir, "audit.log"), "line three\n");
  check("a log is imported line by line, then appended", readLines(join(dir, "audit.log")).join("|") === "line one|line two|line three");
  check("the log file is kept as a backup", existsSync(join(dir, "audit.log" + BACKUP_SUFFIX)));
}

// A crash after the import but before the rename leaves both: the database row wins.
{
  const dir = fresh();
  const file = join(dir, "plan.json");
  writeDoc(file, { tasks: ["new"] });
  writeFileSync(file, JSON.stringify({ tasks: ["stale"] }));
  check("a leftover JSON file never overwrites the saved row", readDoc<{ tasks: string[] }>(file)?.tasks[0] === "new");
  check("the leftover file is moved aside", !existsSync(file) && existsSync(file + BACKUP_SUFFIX));
}

// A corrupt file is not imported and stays put, like before.
{
  const dir = fresh();
  const file = join(dir, "users.json");
  writeFileSync(file, "{ not json");
  let threw = false;
  try { readDoc(file); } catch { threw = true; }
  check("a corrupt JSON file throws and stays where it is", threw && existsSync(file) && !existsSync(file + BACKUP_SUFFIX));
}

// Reading never creates a database.
{
  const dir = fresh();
  check("a read in an empty folder returns null", readDoc(join(dir, "config.json")) === null && readLines(join(dir, "audit.log")).length === 0);
  check("…and creates no database", !existsSync(join(dir, DB_FILE)));
}

// Kill a writer mid-write, many times: the value is always one whole write, never half of one.
{
  const dir = fresh();
  const file = join(dir, "messages.json");
  writeDoc(file, { n: -1, pad: "" });
  closeDocs();
  const child = `
    import { writeDoc } from ${JSON.stringify(new URL("../server/lib/docs.ts", import.meta.url).pathname)};
    const pad = "x".repeat(200_000);
    for (let n = 0; ; n++) writeDoc(${JSON.stringify(file)}, { n, pad });
  `;
  let ok = true;
  let last = -1;
  for (let round = 0; round < 5; round++) {
    const p = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", child], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 300 + round * 100));
    p.kill("SIGKILL");
    await new Promise((r) => p.once("exit", r));
    const v = readDoc<{ n: number; pad: string }>(file);
    closeDocs();
    if (!v || typeof v.n !== "number" || (v.n >= 0 && v.pad.length !== 200_000)) ok = false;
    last = v?.n ?? -2;
  }
  check("a writer killed mid-write leaves the last whole value", ok && last >= 0, `last n=${last}`);
}

closeDocs();
if (fails) {
  console.error(`${fails} failed`);
  process.exit(1);
}
console.log("all passed");
