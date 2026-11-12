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
const { cleanMemory, saysSomething } = await import("../server/memoryClean");

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

// ---------------------------------------------------------------- never stored: the cleaner (2.5)
const VAULT_KEY = "vault-held-value-0123456789";
const ctx = { redact: (x: string) => x.split(VAULT_KEY).join("••••6789"), keepOut: ["Ravi Kumar", "r4vi"], scope: { inScope: ["203.0.114.7", "app.example.test"], outOfScope: [], rules: "" } };
const SENSITIVE = [
  VAULT_KEY, "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv", "AKIAIOSFODNN7EXAMPLE", "ghp_0123456789abcdefghijABCDEFGHIJ0123", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlX2hlcmU",
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", "hunter22", "s3cr3tpass", "ravi.kumar@corp.example", "+91 98765 43210", "(415) 555-0100", "9876543210", "Ravi Kumar", "ravi kumar", "r4vi", "8.8.4.4",
];
const dirty = `Logged in with ${VAULT_KEY} and sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv; AWS AKIAIOSFODNN7EXAMPLE, token ghp_0123456789abcdefghijABCDEFGHIJ0123,
  session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlX2hlcmU. Key: -----BEGIN RSA PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASC
-----END RSA PRIVATE KEY----- password=hunter22 and postgres://admin:s3cr3tpass@db.internal:5432/app.
  Mail ravi.kumar@corp.example, call +91 98765 43210 or (415) 555-0100 or 9876543210. Ravi Kumar (ravi kumar, handle r4vi) runs 8.8.4.4.`;
const cleaned = cleanMemory(dirty, ctx);
const leaked = SENSITIVE.filter((x) => cleaned.toLowerCase().includes(x.toLowerCase()));
check("secrets, emails, phones, kept-out names and outside IPs are masked", leaked.length === 0, `${leaked.join(" | ")}\n${cleaned}`);
check("the labels say what was there", ["[secret]", "[email]", "[phone]", "[name]", "[ip]", "••••6789", "password=[secret]", "postgres://[secret]@db.internal"].every((x) => cleaned.includes(x)), cleaned);
const harmless = "On 2026-11-12 10:30 Neo4j 2026.10.2 listened on 127.0.0.1:7687 and 100.101.102.103; T-12 hit CVE-2024-12345 (CWE-89) with ' OR 1=1 -- at epoch 1731400000123 against 203.0.114.7, Ravikumarlib v1.2.3.4 untouched.";
check("dates, versions, ports, ids, payloads, local and in-scope IPs stay", cleanMemory(harmless, ctx) === harmless, cleanMemory(harmless, ctx));
check("a memory that was only a key says nothing", !saysSomething(cleanMemory("sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv", ctx)) && saysSomething(cleaned));

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
  old.exec("DROP TABLE memory_outbox; DROP TABLE memory_ids; DROP TABLE task_summaries; DROP TABLE memory_keep_out; DELETE FROM schema_version; INSERT INTO schema_version VALUES (1);");
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

  // ---------------------------------------------------------------- the ontology: remember, recall, related
  const typed = new Neo4jMemory(db, () => cfg, { templateTypes: (p) => (p === "sec" ? ["Asset"] : []) });
  const dead = typed.remember({ projectId: "dev", type: "DeadEnd", text: "Polling the hook endpoint for idle failed: Codex sends no Stop hook", taskId: "T1", about: ["server/hooks.ts", "server/hooks.ts", " "], by: "arul" });
  check("a memory starts uncertified, with its components cleaned", !dead.certified && dead.id.startsWith("M-") && dead.about.join() === "server/hooks.ts");
  const lesson = typed.remember({ projectId: "dev", type: "Lesson", text: "gh pr view needs statusCheckRollup for the CI state", taskId: "T2", about: ["server/hooks.ts"], by: "kavin" });
  typed.remember({ projectId: "dev", type: "Decision", text: "Rate limits live in remote.ts", about: ["server/remote.ts"], by: "lead" });
  typed.remember({ projectId: "sec", type: "Asset", text: "staging.example.test runs an old nginx with the parser bug", by: "red" });
  typed.remember({ projectId: "other-dev", type: "Lesson", text: "parser hook secrets of another project", by: "x" });
  check("a template's own type is accepted in its project", typed.ledger("sec").length === 0); // (remember above didn't throw)
  check("another project's template type is refused", rejects(() => typed.remember({ projectId: "dev", type: "Asset", text: "x", by: "a" }), /isn't a memory type/));
  check("an unknown type is refused", rejects(() => typed.remember({ projectId: "dev", type: "Banana", text: "x", by: "a" }), /isn't a memory type.*DeadEnd/));
  check("a graph label isn't a memory type", rejects(() => typed.remember({ projectId: "dev", type: "Task", text: "x", by: "a" }), /isn't a memory type/));
  check("an empty memory is refused", rejects(() => typed.remember({ projectId: "dev", type: "Lesson", text: " ", by: "a" }), /needs text/));
  typed.addLedger({ projectId: "dev", taskId: "T1", ledger: "task", kind: "fact", text: "Codex has no Stop hook", by: "lead" });
  await typed.flush();
  check("a memory carries its type as a label", (await count("MATCH (m:Memory:DeadEnd {id: $id}) RETURN count(m)", { id: dead.id })) === 1);
  check("its task points at it by kind", (await count("MATCH (:Task {projectId: 'dev', taskId: 'T1'})-[:HIT]->(m:Memory {id: $id}) RETURN count(m)", { id: dead.id })) === 1 &&
    (await count("MATCH (:Task {taskId: 'T2'})-[:LEARNED]->(:Lesson) RETURN count(*)")) === 1);
  check("one Component node per file, shared by its memories", (await count("MATCH (c:Component {projectId: 'dev', name: 'server/hooks.ts'})<-[:ABOUT]-(m) RETURN count(m)")) === 2 && (await count("MATCH (c:Component {projectId: 'dev'}) RETURN count(c)")) === 2);
  check("ledger entries hang off their task", (await count("MATCH (:Task {projectId: 'dev', taskId: 'T1'})-[:HAS_ENTRY]->(:LedgerEntry) RETURN count(*)")) === 1);

  const found = await typed.recall("dev", "why does polling the hook fail?");
  check("recall finds a memory by its words", found[0]?.id === dead.id && found[0].type === "DeadEnd" && found[0].about.join() === "server/hooks.ts", JSON.stringify(found));
  check("recall stays in its project", (await typed.recall("dev", "parser secrets")).length === 0);
  check("recall filters by type", (await typed.recall("dev", "hook statusCheckRollup", { types: ["Lesson"] })).map((m) => m.id).join() === lesson.id);
  check("Lucene syntax in a query is only words", (await typed.recall("dev", 'text:* OR "unclosed ~ hook^9')).some((m) => m.id === dead.id));
  check("a query with no words finds nothing", (await typed.recall("dev", "?! *")).length === 0);
  await probe.executeQuery("MATCH (m:Memory {id: $id}) SET m.certified = true, m.certifiedBy = 'owner'", { id: lesson.id });
  check("certified memories rank first", (await typed.recall("dev", "hook polling statusCheckRollup")).map((m) => m.id).join() === `${lesson.id},${dead.id}`);

  check("related to a task: what it produced", (await typed.related("dev", { taskId: "T1" })).map((m) => m.id).join() === dead.id);
  check("related to a file: every memory about it", (await typed.related("dev", { path: "server/hooks.ts" })).length === 2);
  check("one hop from a memory: nothing; two hops: its neighbours by file", (await typed.related("dev", { memoryId: dead.id }, { depth: 1 })).length === 0 &&
    (await typed.related("dev", { memoryId: dead.id })).map((m) => m.id).join() === lesson.id);
  check("related with nothing to start from finds nothing", (await typed.related("dev", {})).length === 0);
  // ---------------------------------------------------------------- task summaries (2.3)
  const summary = (taskId: string, needs: string[], files: string[], note: string) => ({
    projectId: "dev", taskId, title: `Task ${taskId}`, description: null, doneWhen: null, stageId: "build", ownerId: "arul",
    needs, files, prNumber: null, deliverablePath: null, note, ledger: [], usage: null, finishedAt: new Date().toISOString(),
  });
  typed.summarise(summary("T3", ["T1"], ["server/inbox.ts", "server/inbox.ts"], "first try"));
  typed.summarise(summary("T3", ["T1"], ["server/inbox.ts"], "finished again"));
  await typed.flush();
  check("finishing a task again replaces its summary", typed.summary("dev", "T3")?.note === "finished again" && (db.prepare("SELECT count(*) AS n FROM task_summaries WHERE task_id = 'T3'").get() as { n: number }).n === 1);
  check("the task follows what it built on, touched its files and was worked on by its owner",
    (await count("MATCH (:Task {projectId: 'dev', taskId: 'T3'})-[:FOLLOWS]->(:Task {taskId: 'T1'}) RETURN count(*)")) === 1 &&
    (await count("MATCH (:Task {taskId: 'T3'})-[:TOUCHED]->(:Component {name: 'server/inbox.ts'}) RETURN count(*)")) === 1 &&
    (await count("MATCH (:Agent {projectId: 'dev', agentId: 'arul'})-[:WORKED_ON]->(:Task {taskId: 'T3'}) RETURN count(*)")) === 1);
  check("a follow-up task reaches the dead end of the task it follows", (await typed.related("dev", { taskId: "T3" })).some((m) => m.id === dead.id));

  await typed.flush();
  check("what recall hands out counts as used", (await count("MATCH (m:Memory {id: $id}) WHERE m.lastUsedAt > m.createdAt RETURN count(m)", { id: dead.id })) === 1);
  await typed.close();

  // ---------------------------------------------------------------- nothing sensitive reaches the graph (2.5)
  const careful = new Neo4jMemory(db, () => cfg, { context: () => ({ redact: ctx.redact, scope: ctx.scope }) });
  careful.keepOut("osint", "Ravi Kumar", "red");
  careful.keepOut("osint", "r4vi", "red");
  careful.remember({ projectId: "osint", type: "Lesson", text: dirty, about: ["server/auth.ts", "ravi.kumar@corp.example"], taskId: "T9", by: "red" });
  check("a memory that was only secrets is refused", rejects(() => careful.remember({ projectId: "osint", type: "Lesson", text: `${VAULT_KEY} ravi.kumar@corp.example`, by: "red" }), /Nothing is left/));
  careful.addLedger({ projectId: "osint", taskId: "T9", ledger: "task", kind: "fact", text: dirty, by: "lead" });
  careful.summarise({ projectId: "osint", taskId: "T9", title: "Profile Ravi Kumar", description: dirty, doneWhen: null, stageId: null, ownerId: "red", needs: [], files: ["notes/ravi.kumar@corp.example.md"], prNumber: null, deliverablePath: null, note: dirty, ledger: [{ kind: "fact", text: dirty }], usage: null, finishedAt: new Date().toISOString() });
  await careful.flush();
  const stored = JSON.stringify((await probe.executeQuery("MATCH (n {projectId: 'osint'}) RETURN properties(n) AS p")).records.map((r) => r.get("p"))) +
    (db.prepare("SELECT body FROM task_summaries WHERE project_id = 'osint'").get() as { body: string }).body + JSON.stringify(careful.ledger("osint"));
  const found2 = SENSITIVE.filter((x) => stored.toLowerCase().includes(x.toLowerCase()));
  check("memories, ledger, summaries and task nodes hold no secret or personal data", found2.length === 0 && stored.includes("[name]"), found2.join(" | "));
  // A name added after the fact is scrubbed from what was already stored.
  careful.remember({ projectId: "osint", type: "Lesson", text: "Meena Iyer reuses one password across the staging admin panels", by: "red" });
  careful.addLedger({ projectId: "osint", taskId: null, ledger: "task", kind: "note", text: "Ask Meena Iyer's team about SSO", by: "lead" });
  await careful.flush();
  careful.keepOut("osint", "meena iyer", "lead");
  await careful.flush();
  check("keeping a name out later scrubs it from the graph and the ledger", (await count("MATCH (n {projectId: 'osint'}) WHERE toLower(toString(n.text)) CONTAINS 'meena' RETURN count(n)")) === 0 &&
    !JSON.stringify(careful.ledger("osint")).toLowerCase().includes("meena") && careful.keptOut("osint").length === 3);
  await careful.close();

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
  const graphSize = (await count("MATCH (n {projectId: 'bk'}) RETURN count(n)")) + (await count("MATCH ({projectId: 'bk'})-[r]->({projectId: 'bk'}) RETURN count(r)"));
  check("the export holds every node and edge", text.trim().split("\n").length === 1 + graphSize, `${text.trim().split("\n").length} vs ${1 + graphSize}`);

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
