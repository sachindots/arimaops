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
const { MemoryWorker, candidatePairs, similarity, EXTRACT_MODEL } = await import("../server/memoryExtract");
type RunRequest = import("../server/modelRunner").RunRequest;
const { buildServer } = await import("../server/mcp");
const { Planner } = await import("../server/planner");
const { DEV_TEMPLATE } = await import("../src/data/templates");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { ActionItems } = await import("../server/actionItems");
const { MemoryReview, nextAt } = await import("../server/memoryReview");
const { pushAlert } = await import("../server/push");
const { forgetProject, recordHtml, saveRecord } = await import("../server/forget");
type OfficeEvent = import("../src/data/source").OfficeEvent;
/** A project's hub, as much of it as the action items and the review use. */
const fakeHub = (projectId: string) => {
  const events: OfficeEvent[] = [];
  const hub = { slug: projectId, snap: { actionItems: [] as import("../src/data/types").ActionItem[], config: { team: [], project: { id: projectId, name: projectId } } },
    emit: (e: OfficeEvent) => events.push(e), activity: () => {}, name: (id: string) => id };
  return { hub, events, actions: new ActionItems(hub as never, { currentTask: () => undefined, notify: () => {} } as never) };
};
/** A model that answers from a script, and remembers what it was asked. */
const fakeRunner = (reply: (req: RunRequest) => string) => {
  const asked: RunRequest[] = [];
  return { asked, run: async (req: RunRequest) => (asked.push(req), { text: reply(req), tokens: { input: 1, cached: 0, output: 1 } }) };
};

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

// ---------------------------------------------------------------- consolidation's look-alike test (no Neo4j)
const mem = (id: string, type: string, text: string, certified = false) => ({ id, projectId: "x", type, text, taskId: null, about: [], certified, certifiedBy: null, source: "extraction" as const, by: "hq", createdAt: "", lastUsedAt: "" });
check("near-duplicates look alike, different facts don't", similarity("Codex sends no Stop hook, so idle polling fails", "Idle polling fails because Codex sends no Stop hook") >= 0.6 &&
  similarity("Codex sends no Stop hook", "Rate limits live in remote.ts") < 0.2);
const pairs = candidatePairs([mem("a", "Lesson", "Codex sends no Stop hook so idle polling fails"), mem("b", "Lesson", "idle polling fails: Codex sends no Stop hook"),
  mem("c", "DeadEnd", "Codex sends no Stop hook so idle polling fails"), mem("d", "Lesson", "Codex sends no Stop hook so idle polling fails", true), mem("e", "Lesson", "Codex sends no Stop hook, idle polling fails", true)]);
check("only same-type pairs are asked about, never two certified ones", pairs.length > 0 && pairs.every(([a, b]) => a.type === b.type && !(a.certified && b.certified)) && !pairs.some(([a, b]) => a.id === "c" || b.id === "c"));

// ---------------------------------------------------------------- memories to check (2.6), no Neo4j
{
  const { hub, events, actions } = fakeHub("review-unit");
  const m = (id: string, taskId: string | null, type = "Lesson") => ({ id, type, text: `memory ${id} with enough words in it`, about: ["src/a.ts"], taskId });
  actions.addMemory(m("M-1", "T1"));
  actions.addMemory(m("M-2", "T1"));
  actions.addMemory(m("M-3", "T2"));
  actions.addMemory(m("M-1", "T1"));
  const open = hub.snap.actionItems.filter((i) => i.kind === "memory" && i.status === "open");
  check("new memories group into one item per task, never twice", open.length === 2 && open.find((i) => i.taskId === "T1")?.memories?.length === 2 && open.find((i) => i.taskId === "T1")?.title === "2 memories from T1 to check");
  check("there are 3 to check", actions.pendingMemories() === 3);
  const t1 = open.find((i) => i.taskId === "T1")!;
  const first = actions.decideMemories(t1.id, { "M-1": "reject" });
  check("one memory decided: the item stays open with the rest", first.reject.join() === "M-1" && t1.status === "open" && t1.title === "1 memory from T1 to check");
  const rest = actions.decideMemories(t1.id, { "M-2": "certify", "M-9": "certify" });
  check("deciding the last one closes the item, with a tally; unknown ids are ignored", rest.certify.join() === "M-2" && t1.status === "done" && t1.note === "1 certified, 1 rejected");
  check("a closed item can't be decided again", rejects(() => actions.decideMemories(t1.id, { "M-2": "certify" }), /already checked/));
  actions.syncMemories([m("M-4", "T3")]);
  const t2 = hub.snap.actionItems.find((i) => i.taskId === "T2")!;
  check("a memory merged or faded away leaves its item; new ones from the graph are added", t2.status === "dismissed" && hub.snap.actionItems.some((i) => i.taskId === "T3" && i.status === "open"));
  check("memory items aren't pushed one by one", events.filter((e) => e.type === "action.updated").every((e) => pushAlert(hub as never, e) === null));
  const digest = pushAlert(hub as never, { type: "memory.digest", key: "digest:x", count: 3, urgent: null });
  check("the digest is one push, to owners and operators, opening Action items", !!digest && /3 new memories wait/.test(digest.body) && digest.operatorsOnly && digest.path.includes("open=actions"));
  check("the digest runs at 09:00: today before nine, tomorrow after", nextAt(new Date(2026, 10, 12, 8, 59), 9).getDate() === 12 && nextAt(new Date(2026, 10, 12, 9, 0), 9).getDate() === 13);
}

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
check("the Neo4j Browser link is shown only for a tailnet HTTPS address", memoryState({ ARIMA_NEO4J_BROWSER_URL: "https://arimaops.tail4dcc3c.ts.net:7474/browser/" }).browserUrl?.endsWith("/browser/") === true &&
  memoryState({ ARIMA_NEO4J_BROWSER_URL: "http://192.168.1.15:7474/browser/" }).browserUrl === null && memoryState({ ARIMA_NEO4J_BROWSER_URL: "javascript:alert(1)" }).browserUrl === null);
const compose = readFileSync(join(import.meta.dirname, "..", "compose.yaml"), "utf8");
const neo4jPorts = compose.slice(compose.indexOf("  neo4j:")).match(/^\s+- "([^"]+)"$/gm) ?? [];
check("compose binds Neo4j's Browser and Bolt to this machine only", neo4jPorts.length === 2 && neo4jPorts.every((p) => /"127\.0\.0\.1:/.test(p)), neo4jPorts.join());

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
  old.exec("DROP TABLE memory_outbox; DROP TABLE memory_ids; DROP TABLE task_summaries; DROP TABLE memory_keep_out; DROP TABLE specs; DROP TABLE template_lessons; ALTER TABLE tasks DROP COLUMN spec_items; ALTER TABLE tasks DROP COLUMN high_stakes; DELETE FROM schema_version; INSERT INTO schema_version VALUES (1);");
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

  // ---------------------------------------------------------------- extraction (2.4)
  db.exec("UPDATE task_summaries SET extracted_at = 0"); // summaries from earlier parts of this test aren't this part's business
  const ex = new Neo4jMemory(db, () => cfg, { templateTypes: (p) => (p === "ext" ? ["Asset"] : []) });
  const sample = { projectId: "ext", taskId: "T5", title: "Detect idle Codex agents", description: "Find out when a Codex agent is idle", doneWhen: null, stageId: null, ownerId: "arul",
    needs: [], files: ["server/hooks.ts"], prNumber: 12, deliverablePath: null, note: "Polling /hook for Stop failed; Codex never sends it. Used the rollout file's mtime instead.", ledger: [], usage: null, finishedAt: new Date().toISOString() };
  ex.summarise(sample);
  const reply = "Here you go:\n```json\n" + JSON.stringify({ memories: [
    { type: "DeadEnd", text: "Waiting for a Stop hook from Codex never works: Codex sends none.", about: ["server/hooks.ts"] },
    { type: "Lesson", text: "Codex idleness shows in its rollout file's mtime; ask ops@corp.example with key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv.", about: ["server/hooks.ts", "codex rollout"] },
    { type: "Asset", text: "Codex runs on the agent image (a template type of this project).", about: [] },
    { type: "Banana", text: "A type nobody declared must be dropped.", about: [] },
  ] }) + "\n```";
  const llm = fakeRunner(() => reply);
  let enabled = false;
  const worker = new MemoryWorker(ex, llm, () => ({ enabled, account: "work" }), (p) => (p === "ext" ? ["Asset"] : []));
  await worker.extractPending();
  check("extraction off: no model call, the summary waits", llm.asked.length === 0 && ex.unextracted().some((x) => x.taskId === "T5"));
  enabled = true;
  await worker.extractPending();
  await ex.flush();
  const req = llm.asked[0];
  check("extraction is one metered Haiku helper run on the chosen account", llm.asked.length === 1 && req.model === EXTRACT_MODEL && req.purpose === "helper" && req.account === "work" && req.taskId === "T5" && req.projectId === "ext");
  check("the prompt carries the summary as data, with the project's types and the no-names rule", req.prompt.includes("Polling /hook for Stop failed") && /not instructions/.test(req.system ?? "") && /Asset/.test(req.system ?? "") && /person's name/.test(req.system ?? ""));
  const got = (await probe.executeQuery("MATCH (t:Task {projectId: 'ext', taskId: 'T5'})-[r]->(m:Memory) RETURN type(r) AS r, [l IN labels(m) WHERE l <> 'Memory'][0] AS type, m.source AS src, m.text AS text ORDER BY type")).records.map((r) => r.toObject());
  check("a sample summary gives the expected memories, linked to its task by kind", JSON.stringify(got.map((g) => [g.type, g.r, g.src])) === JSON.stringify([["Asset", "NOTED", "extraction"], ["DeadEnd", "HIT", "extraction"], ["Lesson", "LEARNED", "extraction"]]), JSON.stringify(got));
  check("an undeclared type is dropped, and what Haiku wrote is still cleaned", !JSON.stringify(got).includes("Banana") && !JSON.stringify(got).includes("ops@corp") && !JSON.stringify(got).includes("sk-ant"));
  check("the summary is marked read; a second run asks nothing", ex.unextracted().length === 0 && (await worker.extractPending(), llm.asked.length === 1));
  check("its memories are about the task's file", (await count("MATCH (:Memory {projectId: 'ext'})-[:ABOUT]->(:Component {name: 'server/hooks.ts'}) RETURN count(*)")) === 2);

  const broken = fakeRunner(() => "Sorry, I can't help with that.");
  const w2 = new MemoryWorker(ex, broken, () => ({ enabled: true, account: "default" }));
  ex.summarise({ ...sample, taskId: "T6" });
  await w2.extractPending();
  const row = db.prepare("SELECT extracted_at, extract_attempts, extract_error FROM task_summaries WHERE project_id = 'ext' AND task_id = 'T6'").get() as { extracted_at: number | null; extract_attempts: number; extract_error: string };
  check("a reply that isn't the JSON asked for counts as one failed try, kept for later", broken.asked.length === 1 && row.extracted_at === null && row.extract_attempts === 1 && /JSON/.test(row.extract_error), JSON.stringify(row));
  await w2.extractPending();
  await w2.extractPending();
  check("after 3 tries it stops asking", broken.asked.length === 3 && ex.unextracted().every((x) => x.taskId !== "T6"));

  // ---------------------------------------------------------------- consolidation (2.4)
  const a1 = ex.remember({ projectId: "con", type: "Lesson", text: "Codex sends no Stop hook so polling for idle fails", about: ["server/hooks.ts"], by: "hq" });
  const a2 = ex.remember({ projectId: "con", type: "Lesson", text: "Polling for idle fails because Codex sends no Stop hook", about: ["server/inbox.ts"], taskId: "T7", by: "hq" });
  const a3 = ex.remember({ projectId: "con", type: "Lesson", text: "Rate limits live in remote.ts, next to the step-up", by: "hq" });
  await ex.flush();
  const merger = fakeRunner(() => JSON.stringify({ merges: [
    { keep: a1.id, drop: a2.id, text: "Codex sends no Stop hook, so polling for idle never fires; watch its rollout file instead." },
    { keep: a1.id, drop: a3.id, text: "not asked about: must be ignored" },
  ] }));
  const w3 = new MemoryWorker(ex, merger, () => ({ enabled: true, account: "default" }));
  check("duplicates merge: one call, one merge", (await w3.consolidate("con")) === 1 && merger.asked.length === 1 && merger.asked[0].prompt.includes(a2.id) && !merger.asked[0].prompt.includes(a3.id));
  const left = await ex.memories("con");
  check("the kept memory takes the merged text and the dropped one's links", left.map((m) => m.id).sort().join() === [a1.id, a3.id].sort().join() &&
    left.find((m) => m.id === a1.id)?.about.join() === "server/hooks.ts,server/inbox.ts" && /rollout file/.test(left.find((m) => m.id === a1.id)!.text) &&
    (await count("MATCH (:Task {projectId: 'con', taskId: 'T7'})-[:LEARNED]->(:Memory {id: $id}) RETURN count(*)", { id: a1.id })) === 1);
  check("the dropped memory stays as history but isn't recalled", (await count("MATCH (:Memory {id: $k})-[:SUPERSEDES]->(:Memory {id: $d, supersededBy: $k}) RETURN count(*)", { k: a1.id, d: a2.id })) === 1 &&
    !(await ex.recall("con", "polling idle Codex Stop hook")).some((m) => m.id === a2.id));

  const c1 = ex.remember({ projectId: "con", type: "DeadEnd", text: "Restarting tmux to clear a stuck Codex session loses its scrollback", by: "hq" });
  const c2 = ex.remember({ projectId: "con", type: "DeadEnd", text: "Restarting tmux to clear a stuck Codex session loses the scrollback", by: "hq" });
  await ex.flush();
  await probe.executeQuery("MATCH (m:Memory {id: $id}) SET m.certified = true, m.certifiedBy = 'owner'", { id: c2.id });
  const w4 = new MemoryWorker(ex, fakeRunner(() => JSON.stringify({ merges: [{ keep: c1.id, drop: c2.id, text: "rewritten" }] })), () => ({ enabled: true, account: "default" }));
  await w4.consolidate("con");
  const kept2 = (await ex.memories("con")).filter((m) => m.type === "DeadEnd");
  check("a certified memory is never merged away, and its text is never rewritten", kept2.length === 1 && kept2[0].id === c2.id && kept2[0].text.endsWith("the scrollback"));

  // ---------------------------------------------------------------- fading (2.4)
  const f1 = ex.remember({ projectId: "fade", type: "Lesson", text: "An old lesson nobody has used for a long while", by: "hq" });
  const f2 = ex.remember({ projectId: "fade", type: "Lesson", text: "An old certified lesson that must stay forever", by: "hq" });
  const f3 = ex.remember({ projectId: "fade", type: "Lesson", text: "A recent lesson that is still fresh enough", by: "hq" });
  await ex.flush();
  const longAgo = new Date(Date.now() - 40 * 86_400_000).toISOString();
  await probe.executeQuery("MATCH (m:Memory) WHERE m.id IN [$a, $b] SET m.lastUsedAt = $t, m.createdAt = $t", { a: f1.id, b: f2.id, t: longAgo });
  await probe.executeQuery("MATCH (m:Memory {id: $id}) SET m.certified = true", { id: f2.id });
  await new MemoryWorker(ex, fakeRunner(() => '{"merges":[]}'), () => ({ enabled: true, account: "default" })).nightly();
  const alive = (await ex.memories("fade")).map((m) => m.id).sort().join();
  check("after 30 unused days an uncertified memory fades; certified and recent ones stay", alive === [f2.id, f3.id].sort().join(), alive);
  await ex.close();

  // ---------------------------------------------------------------- agents use memory (2.7), over MCP
  {
    const e2e = new Neo4jMemory(db, () => cfg);
    const team = [
      { id: "cipher", name: "Cipher", roleId: "lead", isLead: true },
      { id: "ghost", name: "Ghost", roleId: "developer", isLead: false },
      { id: "devi", name: "Devi", roleId: "developer", isLead: false },
    ];
    const task = (id: string, title: string, ownerId: string, status: string, needs: string[], files: string[]) => ({ id, boardId: "B1", stageId: "build", title, ownerId, status, needs, files, prNumber: null });
    const snap = {
      config: { template: DEV_TEMPLATE, project: { id: "brief" }, team, workflow: { mode: "github-pr", review: { enabled: true } } },
      boards: [{ id: "B1", title: "Backlog", status: "active", order: 0 }],
      tasks: [task("B1-T01", "Lexer", "ghost", "in-progress", [], ["src/lexer.ts"]), task("B1-T02", "Parser on top of the lexer", "devi", "todo", ["B1-T01"], ["src/parser.ts"]),
        task("B1-T03", "Speed up the tokenizer", "cipher", "todo", [], ["src/lexer.ts"]), task("B1-T04", "Write the README", "cipher", "todo", [], ["README.md"])],
      agents: [], messages: [], pullRequests: [], actionItems: [],
    };
    const hub = { snap, repo: { root: mkdtempSync(join(tmpdir(), "arima-brief-repo-")) }, cfg: (id: string) => team.find((a) => a.id === id), name: (id: string) => id, emit: () => {}, planChanged: () => {}, activity: () => {}, status: () => null, setStatus: () => {} };
    const planner = new Planner(hub as never, { push: () => {} } as never);
    planner.memory = e2e;
    const call = async (me: string, name: string, args: Record<string, unknown>) => {
      const [a, b] = InMemoryTransport.createLinkedPair();
      await buildServer(hub as never, planner, me).connect(a);
      const client = new Client({ name: "test", version: "1" });
      await client.connect(b);
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      await client.close();
      return { error: !!r.isError, text: r.content.map((c) => c.text).join("") };
    };
    const DEAD = "Tokenizing with one big regex was too slow on 1 MB files";
    await call("ghost", "remember", { type: "Lesson", text: "The lexer's tests live in test/lexer and run with pnpm test lexer", about: ["src/lexer.ts"] });
    const said = await call("ghost", "remember", { type: "DeadEnd", text: DEAD, about: ["src/lexer.ts"] });
    check("an agent remembers a dead end on its current task", !said.error && /uncertified/.test(said.text), said.text);
    // B1-T01 finishes: the planner writes its summary (planner-test covers both ways a task finishes).
    e2e.summarise({ projectId: "brief", taskId: "B1-T01", title: "Lexer", description: null, doneWhen: null, stageId: "build", ownerId: "ghost", needs: [], files: ["src/lexer.ts"],
      prNumber: 3, deliverablePath: null, note: "Hand-written scanner; see the dead end.", ledger: [], usage: null, finishedAt: new Date().toISOString() });
    snap.tasks[0].status = "done";
    await e2e.flush();
    // Each agent's current task is its first unfinished one: cipher has B1-T03, then B1-T04.
    const briefOf = async (who: string) => {
      const r = await call(who, "get_my_task", {});
      return r.error ? r.text : (JSON.parse(r.text).brief as string);
    };
    const followUp = await briefOf("devi");
    check("a follow-up task's brief carries the dead end of the task it builds on, unasked", followUp.includes("## Memory") && followUp.includes(DEAD) && followUp.includes("from B1-T01"), followUp);
    check("dead ends come first among the brief's memories", followUp.indexOf(DEAD) < followUp.indexOf("tests live in test/lexer"));
    const sameFile = await briefOf("cipher");
    check("a task on the same file gets it too", sameFile.includes(DEAD));
    snap.tasks[2].status = "done";
    const unrelated = await briefOf("cipher");
    check("an unrelated task's brief doesn't", !unrelated.includes(DEAD) && !unrelated.includes("## Memory"), unrelated);

    const recalled = JSON.parse((await call("devi", "recall", { query: "regex tokenizer slow" })).text) as { id: string; type: string }[];
    check("recall over MCP finds it", recalled.some((m) => m.type === "DeadEnd"));
    const rel = JSON.parse((await call("devi", "related", { path: "src/lexer.ts" })).text) as { id: string }[];
    check("related over MCP finds it by file", rel.some((m) => m.id === recalled.find((x) => x.type === "DeadEnd")!.id));
    await call("devi", "remember", { type: "Lesson", text: "Rhea Thomas reviews every parser change before merge", taskId: "B1-T02" });
    await call("devi", "keep_out_of_memory", { name: "Rhea Thomas" });
    await e2e.flush();
    check("a name kept out over MCP leaves memory", (await count("MATCH (m:Memory {projectId: 'brief'}) WHERE m.text CONTAINS 'Rhea' RETURN count(m)")) === 0);
    await e2e.close();
  }

  // ---------------------------------------------------------------- certify (2.6), on Neo4j
  {
    const rv = new Neo4jMemory(db, () => cfg);
    const { hub, events, actions } = fakeHub("certify");
    const review = new MemoryReview(hub as never, actions, rv);
    const old = rv.remember({ projectId: "certify", type: "DeadEnd", text: "Caching the gh token in a file broke when it rotated", about: ["server/github.ts"], taskId: "T1", by: "hq" });
    const keep = rv.remember({ projectId: "certify", type: "Lesson", text: "gh pr view needs statusCheckRollup for the CI state", taskId: "T1", by: "hq" });
    const drop = rv.remember({ projectId: "certify", type: "Lesson", text: "Polling GitHub every second is fine for rate limits", taskId: "T1", by: "hq" });
    rv.remember({ projectId: "elsewhere", type: "Lesson", text: "Another project's memory never shows up here", by: "hq" });
    await rv.flush();
    const item = hub.snap.actionItems.find((i) => i.kind === "memory")!;
    check("every new memory lands in the project's Action items, others' don't", item?.memories?.map((p) => p.id).join() === [old.id, keep.id, drop.id].join() && hub.snap.actionItems.length === 1);
    const r = actions.decideMemories(item.id, { [old.id]: "certify", [keep.id]: "certify", [drop.id]: "reject" });
    rv.certify("certify", r.certify, "user");
    rv.reject("certify", r.reject);
    await rv.flush();
    check("batch certify marks them certified; reject deletes", (await count("MATCH (m:Memory {projectId: 'certify', certified: true, certifiedBy: 'user'}) RETURN count(m)")) === 2 &&
      (await count("MATCH (m:Memory {id: $id}) RETURN count(m)", { id: drop.id })) === 0 && item.status === "done");
    rv.reject("certify", [keep.id]);
    await rv.flush();
    check("a certified memory can't be rejected afterwards", (await count("MATCH (m:Memory {id: $id}) RETURN count(m)", { id: keep.id })) === 1);
    check("certified memories rank first in recall", (await rv.recall("certify", "gh token rotated statusCheckRollup")).every((m) => m.certified));

    const clash = rv.remember({ projectId: "certify", type: "DeadEnd", text: "Caching the gh token in a file works fine across rotations", about: ["server/github.ts"], taskId: "T2", by: "arul" });
    await new Promise((res) => setTimeout(res, 300)); // the conflict check runs after the write is sent
    await rv.flush();
    await review.checkConflict(clash);
    const pending = hub.snap.actionItems.find((i) => i.taskId === "T2")?.memories?.[0];
    const urgent = events.find((e) => e.type === "memory.digest" && e.urgent);
    check("a new dead end on the same file as a certified one is flagged and pushed at once", pending?.conflict?.id === old.id && !!urgent && urgent.type === "memory.digest" && urgent.urgent!.includes(old.id), JSON.stringify({ pending, urgent }));
    review.digest(new Date(2026, 10, 13, 9));
    check("the daily digest counts what still waits", events.some((e) => e.type === "memory.digest" && e.key === "digest:2026-11-13" && e.count === 1));
    await probe.executeQuery("MATCH (m:Memory {id: $id}) DETACH DELETE m", { id: clash.id });
    await review.sync();
    check("sync drops a memory that left the graph (merged, faded)", actions.pendingMemories() === 0);
    review.stop();
    await rv.close();
  }

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

  // ---------------------------------------------------------------- forget project (2.8): a purge leaves no trace
  {
    const fdb = hqDb(mkdtempSync(join(tmpdir(), "arima-forget-")));
    await probe.executeQuery("MATCH (n) WHERE n.projectId IN ['acme', 'zeta'] DETACH DELETE n");
    const fm = new Neo4jMemory(fdb, () => cfg);
    const fill = (p: string) => {
      fdb.prepare("INSERT INTO projects_model (project_id, template_id, template_version, body, updated_at) VALUES (?, 'dev', 1, '{}', 0)").run(p);
      fdb.prepare("INSERT INTO boards (project_id, id, title, status, ord) VALUES (?, 'B1', ?, 'active', 0)").run(p, `${p} board`);
      fdb.prepare("INSERT INTO tasks (project_id, id, board_id, stage_id, title, status, updated_at) VALUES (?, 'B1-T01', 'B1', 'build', ?, 'done', 0)").run(p, `${p} login`);
      fdb.prepare("INSERT INTO gate_events (project_id, task_id, gate_id, state, by_kind, by_id, at) VALUES (?, 'B1-T01', 'review', 'passed', 'agent', 'kavin', 0)").run(p);
      fdb.prepare("INSERT INTO findings (project_id, id, reporter_id, title, asset_kind, asset_value, severity, description, status, at, updated_at) VALUES (?, 'F-001', 'red', ?, 'host', ?, 'high', 'x', 'open', 0, 0)").run(p, `${p} SQLi`, `${p}.example.test`);
      fdb.prepare("INSERT INTO ledger (project_id, task_id, ledger, kind, text, by, at) VALUES (?, 'B1-T01', 'task', 'fact', ?, 'lead', 0)").run(p, `${p} old ledger`);
      fdb.prepare("INSERT INTO usage_events (at, project_id, task_id, agent_id, source, account, provider, cli, model, input, cached, output, cost_usd) VALUES (0, ?, 'B1-T01', 'kavin', 'agent', 'default', 'anthropic', 'claude', 'claude-opus-5-5', 100, 0, 10, 0.01)").run(p);
      fdb.prepare("INSERT INTO usage_marks (project_id, agent_id, model, input, cached, output) VALUES (?, 'kavin', 'opus', 1, 0, 1)").run(p);
      fm.addLedger({ projectId: p, taskId: "B1-T01", ledger: "task", kind: "plan", text: `${p} plan`, by: "lead" });
      fm.remember({ projectId: p, type: "Lesson", text: `${p} lesson: the staging login needs a CSRF token first`, about: [`src/${p}.ts`], taskId: "B1-T01", by: "hq" });
      fm.summarise({ projectId: p, taskId: "B1-T01", title: `${p} login`, description: null, doneWhen: null, stageId: "build", ownerId: "kavin", needs: [], files: [`src/${p}.ts`], prNumber: 1, deliverablePath: null, note: `${p} done`, ledger: [], usage: null, finishedAt: new Date().toISOString() });
      fm.keepOut(p, `${p} contact`, "red");
    };
    fill("acme");
    fill("zeta");
    await fm.flush();
    const broot = mkdtempSync(join(tmpdir(), "arima-forget-backups-"));
    await backupProject(fm, "acme", broot, new Date(2026, 10, 10, 3));
    await backupProject(fm, "zeta", broot, new Date(2026, 10, 10, 3));
    const folder = mkdtempSync(join(tmpdir(), "arima-forget-acme-"));
    writeFileSync(join(folder, "chat.log"), "acme chat");
    const sizeOf = async (p: string) => [
      await count("MATCH (n {projectId: $p}) RETURN count(n)", { p }),
      ...["tasks", "findings", "task_summaries", "memory_keep_out"].map((t) => (fdb.prepare(`SELECT count(*) AS n FROM ${t} WHERE project_id = ?`).get(p) as { n: number }).n),
      listBackups(p, broot).length,
    ].join();
    const zetaBefore = await sizeOf("zeta");

    const rec = await forgetProject({ db: fdb, mem: fm, projectId: "acme", projectName: "Acme <Corp>", by: "Sachin", backupsRoot: broot, folders: [folder] });
    // Scan everything: every table, every node, the backups and the folders.
    const tables = (fdb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    const traces = tables.filter((t) => JSON.stringify(fdb.prepare(`SELECT * FROM "${t}"`).all()).toLowerCase().includes("acme"));
    const nodes = await count("MATCH (n) WHERE any(k IN keys(n) WHERE toLower(toString(n[k])) CONTAINS 'acme') RETURN count(n)");
    check("a purge leaves no trace: no table row, no graph node, no backup, no folder", traces.length === 0 && nodes === 0 && !existsSync(join(broot, "acme")) && !existsSync(folder), `tables ${traces} nodes ${nodes}`);
    check("usage stays in the account's totals, anonymized", (fdb.prepare("SELECT count(*) AS n FROM usage_events WHERE project_id = '' AND task_id IS NULL AND agent_id IS NULL AND cost_usd = 0.01").get() as { n: number }).n === 1);
    check("the other project keeps everything, backups included", (await sizeOf("zeta")) === zetaBefore, `${await sizeOf("zeta")} vs ${zetaBefore}`);
    const counted = Object.fromEntries(rec.removed.map((r) => [r.what, r.count]));
    check("the record counts what went", rec.graph === "deleted" && counted["Memories (decisions, lessons, dead ends)"] === 1 && counted["Ledger entries"] === 1 && counted["Findings"] === 1 &&
      counted["Task summaries"] === 1 && counted["Memory backups"] === 1 && rec.removed.some((r) => /folders/.test(r.what) && r.count === 1) && rec.kept.some((k) => /audit log/.test(k)), JSON.stringify(rec.removed));
    const html = recordHtml(rec);
    check("the printable record escapes the project's name", html.includes("Acme &lt;Corp&gt;") && !html.includes("<Corp>") && !/<script/i.test(html));
    const rdir = mkdtempSync(join(tmpdir(), "arima-records-"));
    const name = saveRecord(rec, rdir);
    check("the record is saved as private JSON and HTML", ["json", "html"].every((x) => existsSync(join(rdir, `${name}.${x}`)) && (statSync(join(rdir, `${name}.${x}`)).mode & 0o077) === 0));

    // With Neo4j unreachable the purge still happens; the graph part is queued and the record says so.
    const offline = new Neo4jMemory(fdb, () => null);
    offline.remember({ projectId: "zeta", type: "Lesson", text: "zeta lesson written while the graph is down", by: "hq" });
    const rec2 = await forgetProject({ db: fdb, mem: offline, projectId: "zeta", projectName: "Zeta", by: "Sachin", backupsRoot: broot, folders: [] });
    const outbox = fdb.prepare("SELECT op FROM memory_outbox WHERE project_id = 'zeta'").all() as { op: string }[];
    check("offline: the graph's deletion is queued, everything else is gone, and the record says so", rec2.graph === "queued" && outbox.length === 1 && JSON.parse(outbox[0].op).op === "forget" &&
      rec2.removed[0].count === null && rec2.kept.some((k) => /queued/.test(k)) && (fdb.prepare("SELECT count(*) AS n FROM findings WHERE project_id = 'zeta'").get() as { n: number }).n === 0);
    await fm.flush(); // the online store sends the queued forget
    check("and once the graph is back, the queued forget runs", (await count("MATCH (n {projectId: 'zeta'}) RETURN count(n)")) === 0);
    await offline.close();
    await fm.close();
  }

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
