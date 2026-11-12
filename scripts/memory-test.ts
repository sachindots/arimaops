// The memory store on a real Neo4j (docs/memory-core.md, Phase 2 step 1): the one-time copy of the
// SQLite ledger, the Phase 1 ledger rules, an outage that queues writes and replays them in order, and
// a write Neo4j rejects. Starts a throwaway Neo4j container; skips when Docker or the image is missing.
// Run: npx tsx scripts/memory-test.ts
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "arima-memory-"));
process.env.ARIMA_MASTER_KEY = "11".repeat(32);
const { hqDb, migrate, MIGRATIONS } = await import("../server/lib/db");
const { Neo4jMemory, memoryState, neo4jConfig, saveMemorySettings } = await import("../server/memory");
const { backupAll, backupProject, exportProject, importProject, listBackups, nextBackupAt, parseBackup, restoreProject, KEEP_DAYS } = await import("../server/memoryBackup");
const neo4j = (await import("neo4j-driver")).default;

const IMAGE = "neo4j:2026.10.2-community"; // the version compose.yaml pins
const PASSWORD = "memory-test-pw";
const docker = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8" });

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};
const rejects = (f: () => unknown, mention: RegExp) => {
  try {
    f();
    return false;
  } catch (e) {
    return mention.test((e as Error).message);
  }
};

// ---------------------------------------------------------------- backups that need no Neo4j
check("backups run at 03:00 tonight, or tomorrow once it's past", nextBackupAt(new Date(2026, 10, 12, 2, 0)).getTime() === new Date(2026, 10, 12, 3, 0).getTime() && nextBackupAt(new Date(2026, 10, 12, 3, 0)).getTime() === new Date(2026, 10, 13, 3, 0).getTime());
const head = JSON.stringify({ v: 1, projectId: "bk", at: "x" });
check("a backup of another project is refused", rejects(() => parseBackup(JSON.stringify({ v: 1, projectId: "other", at: "x" }), "bk"), /not bk/));
check("a label that could inject Cypher is refused", rejects(() => parseBackup(`${head}\n${JSON.stringify({ n: 0, labels: ["X`) DETACH DELETE n //"], p: {} })}`, "bk"), /bad label/));
check("an edge to a missing node is refused", rejects(() => parseBackup(`${head}\n${JSON.stringify({ n: 0, labels: ["Lesson"], p: {} })}\n${JSON.stringify({ r: "ABOUT", from: 0, to: 7, p: {} })}`, "bk"), /isn't in it/));
check("a node's project id comes from the restore, not the file", parseBackup(`${head}\n${JSON.stringify({ n: 0, labels: ["Lesson"], p: { projectId: "other" } })}`, "bk").nodes[0].p.projectId === "bk");

// ---------------------------------------------------------------- Settings → Memory (no Neo4j needed)
const noEnv = {};
check("nothing set: memory is unconfigured", memoryState(noEnv).status === "unconfigured" && neo4jConfig(noEnv) === null);
check("a bad address is refused", rejects(() => saveMemorySettings({ url: "http://x:7474", user: "neo4j", password: "long-enough" }, noEnv), /bolt:/));
check("a short password is refused", rejects(() => saveMemorySettings({ url: "bolt://127.0.0.1:7687", user: "neo4j", password: "short" }, noEnv), /8 characters/));
check("the first save needs a password", rejects(() => saveMemorySettings({ url: "bolt://127.0.0.1:7687", user: "neo4j" }, noEnv), /password/));
const envCfg = { ARIMA_NEO4J_URL: "bolt://127.0.0.1:7687", ARIMA_NEO4J_PASSWORD: "from-compose" };
check("compose's settings can't be overridden from the browser", rejects(() => saveMemorySettings({ url: "bolt://127.0.0.1:1", user: "neo4j", password: "long-enough" }, envCfg), /\.env/));
check("compose's settings win", neo4jConfig(envCfg)?.password === "from-compose" && memoryState(envCfg).source === "env");
// Port 9 refuses at once: the save connects (and fails) without a Neo4j.
await saveMemorySettings({ url: "bolt://127.0.0.1:9", user: "arima", password: "a-saved-password" }, noEnv);
const saved = memoryState(noEnv);
check("a saved connection is used, password from the vault", neo4jConfig(noEnv)?.password === "a-saved-password" && saved.source === "settings" && saved.user === "arima");
check("the browser's view never holds the password", !JSON.stringify(saved).includes("a-saved-password") && saved.passwordSet);
check("an unreachable Neo4j shows as offline", saved.status === "offline", JSON.stringify(saved));

if (docker("image", "inspect", IMAGE).status !== 0 && docker("pull", "-q", IMAGE).status !== 0) {
  console.log(`- skipped the Neo4j checks: Docker or the ${IMAGE} image isn't available`);
  process.exit(fails ? 1 : 0);
}


const name = `arima-memory-test-${process.pid}`;
const run = docker("run", "-d", "--rm", "--name", name, "-p", "127.0.0.1::7687", "-e", `NEO4J_AUTH=neo4j/${PASSWORD}`, "-e", "NEO4J_server_memory_heap_max__size=512m", IMAGE);
if (run.status !== 0) throw new Error(run.stderr);
const port = docker("port", name, "7687").stdout.trim().split(":").pop();
const cfg = { url: `bolt://127.0.0.1:${port}`, user: "neo4j", password: PASSWORD };
const probe = neo4j.driver(cfg.url, neo4j.auth.basic(cfg.user, cfg.password), { disableLosslessIntegers: true, connectionTimeout: 2_000 });

async function waitUp() {
  for (let i = 0; i < 90; i++) {
    try {
      await probe.verifyConnectivity();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  throw new Error("Neo4j didn't start in 90 s");
}
const count = async (q: string, p = {}) => ((await probe.executeQuery(q, p)).records[0].get(0) as number);

try {
  await waitUp();

  // ---------------------------------------------------------------- the one-time copy of the Phase 1 ledger
  const db = hqDb(mkdtempSync(join(tmpdir(), "arima-memdb-")));
  // hqDb migrated to the end; rebuild a Phase 1 database by hand to test the step from 1 to 2.
  const old = hqDb(mkdtempSync(join(tmpdir(), "arima-memdb-old-")));
  old.exec("DROP TABLE memory_outbox; DROP TABLE memory_ids; DELETE FROM schema_version; INSERT INTO schema_version VALUES (1);");
  const ins = old.prepare("INSERT INTO ledger (project_id, task_id, ledger, kind, text, by, at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id");
  const a = (ins.get("old", "T1", "task", "plan", "Parser first", "lead", Date.UTC(2026, 10, 1)) as { id: number }).id;
  const b = (ins.get("old", "T1", "task", "plan", "Lexer first", "lead", Date.UTC(2026, 10, 2)) as { id: number }).id;
  ins.get("old", null, "progress", "stall", "Arul idle 6 min", "hq", Date.UTC(2026, 10, 3));
  old.prepare("UPDATE ledger SET superseded_by = ? WHERE id = ?").run(b, a);
  migrate(old, MIGRATIONS);
  const copied = new Neo4jMemory(old, () => cfg);
  check("old ledger rows are readable before Neo4j is reached", copied.ledger("old").map((e) => e.text).join("|") === "Lexer first|Arul idle 6 min");
  check("their times survive the copy", copied.ledger("old")[0].at === "2026-11-02T00:00:00.000Z", copied.ledger("old")[0]?.at);
  await copied.flush();
  check("the copy reaches Neo4j, revision link included", (await count("MATCH (:LedgerEntry {projectId: 'old'}) RETURN count(*)")) === 3 && (await count("MATCH (n:LedgerEntry {id: $b})-[:SUPERSEDES]->(o:LedgerEntry {id: $a}) RETURN count(*)", { a, b })) === 1);
  check("new ids keep counting after the old ones", copied.addLedger({ projectId: "old", taskId: null, ledger: "task", kind: "fact", text: "x", by: "lead" }).id > b + 1);
  await copied.close();
  // Two HQ databases count ids from 1, so they can't share one Neo4j: start the next part on an empty graph.
  await probe.executeQuery("MATCH (n) DETACH DELETE n");

  // ---------------------------------------------------------------- the Phase 1 rules, on Neo4j
  const memory = new Neo4jMemory(db, () => cfg);
  const plan = memory.addLedger({ projectId: "p", taskId: "T1", ledger: "task", kind: "plan", text: "Ship the parser first", by: "lead" });
  memory.addLedger({ projectId: "p", taskId: null, ledger: "task", kind: "fact", text: "CI runs on Node 24", by: "lead" });
  memory.addLedger({ projectId: "other", taskId: null, ledger: "task", kind: "fact", text: "elsewhere", by: "lead" });
  const revised = memory.reviseLedger("p", plan.id, "Ship the lexer first", "lead");
  await memory.flush();
  check("Neo4j is online with nothing queued", JSON.stringify(memory.status()) === JSON.stringify({ state: "online", queued: 0 }), JSON.stringify(memory.status()));
  const fresh = new Neo4jMemory(db, () => cfg);
  await fresh.flush();
  check("a new HQ reads the ledgers back from Neo4j", fresh.ledger("p").map((e) => e.text).join("|") === "CI runs on Node 24|Ship the lexer first", fresh.ledger("p").map((e) => e.text).join("|"));
  check("revisions and task filters hold after the round trip", fresh.ledger("p", { taskId: "T1" }).length === 1 && fresh.ledger("p", { taskId: null }).length === 1 && fresh.ledger("p", { taskId: "T1" })[0].id === revised.id);
  check("an entry can't be revised twice", rejects(() => fresh.reviseLedger("p", plan.id, "x", "lead"), /already revised/));
  check("another project's entry can't be revised", rejects(() => fresh.reviseLedger("p", fresh.ledger("other")[0].id, "x", "lead"), /No ledger entry/));
  check("empty text is refused", rejects(() => fresh.addLedger({ projectId: "p", taskId: null, ledger: "task", kind: "fact", text: "  ", by: "lead" }), /needs text/));
  await fresh.close();

  // ---------------------------------------------------------------- an outage
  docker("stop", "-t", "5", name); // --rm removes it; it comes back below as a new, empty Neo4j on the same port
  const during = [1, 2, 3].map((n) => memory.addLedger({ projectId: "p", taskId: null, ledger: "progress", kind: "stall", text: `stall ${n}`, by: "hq" }));
  memory.forgetProject("other");
  await memory.flush();
  const st = memory.status();
  check("while Neo4j is down, writes queue and the ledger still reads", st.state === "offline" && memory.ledger("p", { ledger: "progress" }).length === 3, JSON.stringify(st));
  // Bring Neo4j back on the same port (an empty one: the earlier data went with the container).
  const again = docker("run", "-d", "--rm", "--name", name, "-p", `127.0.0.1:${port}:7687`, "-e", `NEO4J_AUTH=neo4j/${PASSWORD}`, "-e", "NEO4J_server_memory_heap_max__size=512m", IMAGE);
  if (again.status !== 0) throw new Error(again.stderr);
  await waitUp();
  await memory.flush();
  check("when it's back, the queue empties", JSON.stringify(memory.status()) === JSON.stringify({ state: "online", queued: 0 }), JSON.stringify(memory.status()));
  const order = (await probe.executeQuery("MATCH (e:LedgerEntry {projectId: 'p', ledger: 'progress'}) RETURN e.text AS t ORDER BY e.id")).records.map((r) => r.get("t"));
  check("queued writes arrived, in order", order.join("|") === during.map((e) => e.text).join("|"), order.join("|"));
  check("a queued forget ran too", (await count("MATCH (n) WHERE n.projectId = 'other' RETURN count(n)")) === 0 && memory.ledger("other").length === 0);

  // ---------------------------------------------------------------- a write Neo4j rejects
  db.prepare("INSERT INTO memory_outbox (project_id, op, at) VALUES ('p', '{\"op\":\"ledger\"}', 0)").run();
  memory.addLedger({ projectId: "p", taskId: null, ledger: "task", kind: "note", text: "after the bad one", by: "lead" });
  await memory.flush();
  const failed = db.prepare("SELECT count(*) AS n FROM memory_outbox WHERE failed IS NOT NULL").get() as { n: number };
  check("a rejected write is set aside and doesn't block the next", failed.n === 1 && (await count("MATCH (e:LedgerEntry {text: 'after the bad one'}) RETURN count(e)")) === 1);

  // ---------------------------------------------------------------- backup and restore
  const root = mkdtempSync(join(tmpdir(), "arima-backups-"));
  const keep = memory.addLedger({ projectId: "bk", taskId: "T1", ledger: "task", kind: "plan", text: "Keep the parser", by: "lead" });
  memory.reviseLedger("bk", keep.id, "Keep the lexer", "lead");
  memory.addLedger({ projectId: "bk", taskId: null, ledger: "progress", kind: "stall", text: "Kavin idle 7 min", by: "hq" });
  memory.addLedger({ projectId: "bystander", taskId: null, ledger: "task", kind: "fact", text: "untouched", by: "lead" });
  await memory.flush();
  // Two nodes types and an edge with a property, as later steps will write.
  await probe.executeQuery("CREATE (:Lesson {projectId: 'bk', id: 'L1', text: 'gh needs statusCheckRollup', tags: ['gh', 'ci'], certified: true})-[:ABOUT {weight: 2}]->(:Component {projectId: 'bk', path: 'server/github.ts'})");
  const shape = async (p: string) => {
    const nodes = (await probe.executeQuery("MATCH (n {projectId: $p}) RETURN labels(n) AS l, properties(n) AS p", { p })).records.map((r) => JSON.stringify([r.get("l"), Object.entries(r.get("p")).sort()])).sort();
    const edges = (await probe.executeQuery("MATCH (a {projectId: $p})-[r]->(b {projectId: $p}) RETURN type(r) AS t, properties(r) AS rp, properties(a) AS a, properties(b) AS b", { p })).records
      .map((r) => JSON.stringify([r.get("t"), r.get("rp"), Object.entries(r.get("a")).sort(), Object.entries(r.get("b")).sort()])).sort();
    return JSON.stringify({ nodes, edges });
  };
  const before = await shape("bk");
  const file = await backupProject(memory, "bk", root, new Date(2026, 10, 12, 3));
  check("tonight's backup is a private file", existsSync(file) && (statSync(file).mode & 0o077) === 0 && listBackups("bk", root).join() === "2026-11-12");
  const text = await exportProject(probe, "bk");
  check("the export holds every node and edge", text.trim().split("\n").length === 1 + 5 + 2, String(text.trim().split("\n").length));

  await probe.executeQuery("MATCH (n {projectId: 'bk'}) DETACH DELETE n");
  memory.addLedger({ projectId: "bk", taskId: null, ledger: "task", kind: "note", text: "written after the backup", by: "lead" });
  await memory.flush();
  await restoreProject(memory, "bk", "2026-11-12", root);
  check("export, wipe, import gives the same nodes and edges", (await shape("bk")) === before, `${await shape("bk")}\n${before}`);
  check("no restore marks are left on nodes", (await count("MATCH (n) WHERE n._restore IS NOT NULL RETURN count(n)")) === 0);
  check("the ledger HQ reads is the restored one", memory.ledger("bk").map((e) => e.text).join("|") === "Keep the lexer|Kavin idle 7 min", memory.ledger("bk").map((e) => e.text).join("|"));
  check("other projects are untouched", memory.ledger("bystander").length === 1 && (await count("MATCH (n {projectId: 'bystander'}) RETURN count(n)")) === 1);

  const badLine = gzipSync(`${JSON.stringify({ v: 1, projectId: "bk", at: "x" })}\n${JSON.stringify({ n: 0, labels: ["Lesson"], p: {} })}\n${JSON.stringify({ r: "ABOUT", from: 0, to: 9, p: {} })}\n`);
  writeFileSync(join(root, "bk", "2026-11-11.jsonl.gz"), badLine);
  check("a broken backup is refused before anything is deleted", (await restoreProject(memory, "bk", "2026-11-11", root).then(() => false, (e: Error) => /isn't in it/.test(e.message))) && (await shape("bk")) === before);

  for (let d = 1; d <= 9; d++) await backupProject(memory, "bk", root, new Date(2026, 10, 12 + d, 3));
  check(`only the newest ${KEEP_DAYS} backups are kept`, listBackups("bk", root).length === KEEP_DAYS && listBackups("bk", root)[0] === "2026-11-21");
  const all = await backupAll(memory, root, new Date(2026, 10, 30, 3));
  check("the nightly job backs up every project with memory", all.failed.length === 0 && ["bk", "bystander", "p"].every((p) => all.done.includes(p)), JSON.stringify(all));
  await importProject(probe, "bystander", gunzipSync(readFileSync(join(root, "bystander", "2026-11-30.jsonl.gz"))).toString());
  check("importing twice doesn't duplicate", (await count("MATCH (n {projectId: 'bystander'}) RETURN count(n)")) === 1);

  // ---------------------------------------------------------------- forget
  memory.forgetProject("p");
  await memory.flush();
  check("forgetting a project removes its nodes", (await count("MATCH (n) WHERE n.projectId = 'p' RETURN count(n)")) === 0 && memory.ledger("p").length === 0);
  await memory.close();
} finally {
  await probe.close();
  docker("rm", "-f", name);
}

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
