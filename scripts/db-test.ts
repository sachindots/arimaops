// The core-model tables: migrations, constraints and cascades.
// Run: npx tsx scripts/db-test.ts
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDocs, DB_FILE, openDb, readDoc, writeDoc } from "../server/lib/docs";
import { hqDb, migrate, MIGRATIONS, schemaVersion } from "../server/lib/db";

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};
const throws = (fn: () => unknown) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};
const fresh = () => mkdtempSync(join(tmpdir(), "arima-db-"));
const tables = (dir: string) =>
  (openDb(dir).prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
const now = Date.now();

{
  const dir = fresh();
  const db = hqDb(dir);
  const want = ["boards", "findings", "gate_events", "ledger", "projects_model", "tasks", "templates", "usage_events"];
  const have = tables(dir);
  check("a fresh database gets every core table", want.every((t) => have.includes(t)), have.join(","));
  check("its version is the last migration", schemaVersion(db) === MIGRATIONS.length);
  check("the database stays private to this user", (statSync(join(dir, DB_FILE)).mode & 0o777) === 0o600);

  migrate(db);
  check("migrating again changes nothing", schemaVersion(db) === MIGRATIONS.length);

  writeDoc(join(dir, "config.json"), { ok: true });
  check("the docs table lives beside the core tables", readDoc<{ ok: boolean }>(join(dir, "config.json"))?.ok === true);
}

{
  const dir = fresh();
  const db = openDb(dir);
  const bad = ["CREATE TABLE a (x INTEGER)", "CREATE TABLE b (x INTEGER); CREATE TABLE nope ("];
  check("a failing migration throws", throws(() => migrate(db, bad)));
  check("the migrations before it stay applied", schemaVersion(db) === 1 && tables(dir).includes("a"));
  check("the failing one leaves nothing behind", !tables(dir).includes("b"));
  check("a database from a newer HQ is refused", throws(() => migrate(db, [])));
}

{
  const db = hqDb(fresh());
  const board = db.prepare("INSERT INTO boards (project_id, id, title, status, ord) VALUES (?, ?, ?, ?, ?)");
  const task = db.prepare(
    "INSERT INTO tasks (project_id, id, board_id, stage_id, title, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const gate = db.prepare(
    "INSERT INTO gate_events (project_id, task_id, gate_id, state, by_kind, by_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  board.run("p1", "B1", "Backlog", "active", 0);
  task.run("p1", "T1", "B1", "implement", "Build it", "todo", now);
  gate.run("p1", "T1", "merged", "passed", "hq", "hq", now);

  check("a task needs a board that exists", throws(() => task.run("p1", "T2", "B9", "implement", "x", "todo", now)));
  check("a task status outside the list is refused", throws(() => task.run("p1", "T3", "B1", "implement", "x", "doing", now)));
  check("a gate event needs a task that exists", throws(() => gate.run("p1", "T9", "merged", "passed", "hq", "hq", now)));
  check("a gate state outside the list is refused", throws(() => gate.run("p1", "T1", "merged", "maybe", "hq", "hq", now)));
  check("the same task id may exist in another project", !throws(() => {
    board.run("p2", "B1", "Backlog", "active", 0);
    task.run("p2", "T1", "B1", "implement", "Other", "todo", now);
  }));

  db.prepare("DELETE FROM boards WHERE project_id = ? AND id = ?").run("p1", "B1");
  const left = db.prepare("SELECT (SELECT COUNT(*) FROM tasks WHERE project_id = 'p1') + (SELECT COUNT(*) FROM gate_events WHERE project_id = 'p1') AS n").get() as { n: number };
  check("deleting a board removes its tasks and their gate events", left.n === 0);
}

{
  const db = hqDb(fresh());
  const finding = db.prepare(
    `INSERT INTO findings (project_id, id, reporter_id, title, asset_kind, asset_value, cvss_vector, cvss_score, severity, description, status, at, updated_at)
     VALUES ('p1', ?, 'red', 'SQLi', 'url', 'https://x.test', ?, ?, ?, 'd', 'open', ${now}, ${now})`,
  );
  check("a finding with a vector and a score is stored", !throws(() => finding.run("F-1", "CVSS:4.0/AV:N", 9.3, "critical")));
  check("a score without a vector is refused", throws(() => finding.run("F-2", null, 9.3, "critical")));
  check("a score above 10 is refused", throws(() => finding.run("F-3", "CVSS:4.0/AV:N", 11, "critical")));
  check("an unknown severity is refused", throws(() => finding.run("F-4", null, null, "urgent")));

  const usage = db.prepare(
    `INSERT INTO usage_events (at, project_id, source, account, provider, model, input, cached, output, cost_usd)
     VALUES (${now}, 'p1', ?, 'default', 'anthropic', 'claude-sonnet-5-5', ?, 0, 10, ?)`,
  );
  check("a usage event with an unknown price is stored", !throws(() => usage.run("agent", 100, null)));
  check("negative tokens are refused", throws(() => usage.run("agent", -1, null)));
  check("an unknown usage source is refused", throws(() => usage.run("cron", 1, null)));

  const ledger = db.prepare(
    `INSERT INTO ledger (project_id, ledger, kind, text, by, at, superseded_by) VALUES ('p1', ?, ?, 't', 'lead', ${now}, ?)`,
  );
  check("a ledger entry is stored", !throws(() => ledger.run("task", "fact", null)));
  check("a ledger entry can't point at a missing successor", throws(() => ledger.run("task", "plan", 999)));
  check("an unknown ledger kind is refused", throws(() => ledger.run("task", "rumour", null)));
}

closeDocs();
if (fails) {
  console.error(`\n${fails} failed`);
  process.exit(1);
}
console.log("\nall passed");
