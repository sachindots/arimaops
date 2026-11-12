// The three interfaces of the core model: memory (ledgers and the lead's tools), GitHub events, and
// model runs. No network and no paid calls. Run: npx tsx scripts/interfaces-test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GhPr } from "../server/github";

process.env.HOME = mkdtempSync(join(tmpdir(), "arima-ifaces-"));
const { hqDb } = await import("../server/lib/db");
const { Neo4jMemory } = await import("../server/memory");
const { buildServer } = await import("../server/mcp");
const { Planner } = await import("../server/planner");
const { GitHubSync } = await import("../server/githubSync");
const { ClaudeCliRunner, AnthropicKeyRunner, MeteredRunner } = await import("../server/modelRunner");
const { spend } = await import("../server/usageEvents");
const { DEV_TEMPLATE } = await import("../src/data/templates");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};
const rejects = async (p: Promise<unknown>, mention: RegExp) => {
  try {
    await p;
    return false;
  } catch (e) {
    return mention.test((e as Error).message);
  }
};
const db = hqDb();

// ---------------------------------------------------------------- memory (Neo4j not configured: everything stays queued; memory-test covers a real Neo4j)
const memory = new Neo4jMemory(db, () => null);
const plan = memory.addLedger({ projectId: "p", taskId: "T1", ledger: "task", kind: "plan", text: "Ship the parser first", by: "lead" });
memory.addLedger({ projectId: "p", taskId: null, ledger: "task", kind: "fact", text: "CI runs on Node 24", by: "lead" });
memory.addLedger({ projectId: "other", taskId: null, ledger: "task", kind: "fact", text: "elsewhere", by: "lead" });
const revised = memory.reviseLedger("p", plan.id, "Ship the lexer first", "lead");
check("a revision is a new entry", revised.id !== plan.id && revised.taskId === "T1" && revised.kind === "plan");
check("the revised entry drops out of the current ledger", memory.ledger("p", { taskId: "T1" }).map((e) => e.text).join() === "Ship the lexer first");
check("ledgers are per project, and filter by task", memory.ledger("p").length === 2 && memory.ledger("p", { taskId: null }).length === 1);
check("an entry can't be revised twice", await rejects(Promise.resolve().then(() => memory.reviseLedger("p", plan.id, "x", "lead")), /already revised/));
check("empty text is refused", await rejects(Promise.resolve().then(() => memory.addLedger({ projectId: "p", taskId: null, ledger: "task", kind: "fact", text: "  ", by: "lead" })), /needs text/));
memory.forgetProject("p");
check("forgetting a project removes its ledger and nothing else", memory.ledger("p").length === 0 && memory.ledger("other").length === 1);

// ---------------------------------------------------------------- the lead's ledger tools over MCP
{
  const team = [
    { id: "cipher", name: "Cipher", roleId: "lead", isLead: true },
    { id: "ghost", name: "Ghost", roleId: "developer", isLead: false },
  ];
  const snap = {
    config: { template: DEV_TEMPLATE, project: { id: "mcp" }, team, workflow: { mode: "github-pr", review: { enabled: true } } },
    boards: [{ id: "B1", title: "Backlog", status: "active", order: 0 }],
    tasks: [{ id: "B1-T01", boardId: "B1", stageId: "build", title: "Parser", ownerId: "ghost", status: "in-progress", needs: [], prNumber: null }],
    agents: [],
    messages: [],
    pullRequests: [],
    actionItems: [],
  };
  const hub = { snap, repo: { root: mkdtempSync(join(tmpdir(), "arima-ifaces-repo-")) }, cfg: (id: string) => team.find((a) => a.id === id), name: (id: string) => id, emit: () => {}, planChanged: () => {}, activity: () => {}, status: () => null, setStatus: () => {} };
  const planner = new Planner(hub as never, { push: () => {} } as never);
  planner.memory = memory;
  const call = async (me: string, name: string, args: Record<string, unknown>) => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await buildServer(hub as never, planner, me).connect(a);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(b);
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    await client.close();
    return { error: !!r.isError, text: r.content.map((c) => c.text).join("") };
  };
  const added = await call("cipher", "ledger_add", { kind: "guess", text: "The flaky test is a race", taskId: "B1-T01" });
  check("the lead can add to the task ledger", !added.error && memory.ledger("mcp", { ledger: "task" }).length === 1, added.text);
  const refused = await call("ghost", "ledger_add", { kind: "fact", text: "I'm the lead now" });
  check("a non-lead's ledger_add is refused", refused.error && /Only the Lead/.test(refused.text) && memory.ledger("mcp").length === 1, refused.text);
  check("a non-lead can't read the ledger either", (await call("ghost", "read_ledger", {})).error);
  check("the lead can't write HQ's stall entries", (await call("cipher", "ledger_add", { kind: "stall", text: "x" })).error);
  check("an entry on an unknown task is refused", (await call("cipher", "ledger_add", { kind: "fact", text: "x", taskId: "B9-T99" })).error);
  const id = memory.ledger("mcp")[0].id;
  check("the lead revises an entry", !(await call("cipher", "ledger_revise", { id, text: "It's a race in the lexer" })).error && memory.ledger("mcp")[0].text === "It's a race in the lexer");
  const read = JSON.parse((await call("cipher", "read_ledger", {})).text);
  check("read_ledger returns the current task ledger", read.task.length === 1 && read.task[0].kind === "guess");
  const mine = await call("ghost", "get_my_task", {});
  const brief = mine.error ? "" : (JSON.parse(mine.text).brief as string);
  check("get_my_task returns the brief, with the lead's ledger and the open gates", brief.startsWith("# B1-T01: Parser") && brief.includes("guess: It's a race in the lexer") && brief.includes("merged (pr-merged)"), mine.text.slice(0, 300));
}

// ---------------------------------------------------------------- GitHub events
{
  const gh = (n: number, merged = false): GhPr =>
    ({ number: n, title: `[B1-T01] Parser`, headRefName: "ghost/B1-T01", url: `https://x/${n}`, state: merged ? "MERGED" : "OPEN", mergedAt: merged ? "2026-11-12T00:00:00Z" : null, isDraft: false, reviewDecision: null, reviews: { nodes: [] }, reviewThreads: { nodes: [] }, commits: { nodes: [] }, mergeable: "MERGEABLE", createdAt: "2026-11-12T00:00:00Z" }) satisfies GhPr;
  let onEvent: ((e: unknown) => void) | null = null;
  let nudged = 0;
  let stopped = false;
  const source = { watch: (_repo: string, on: (e: unknown) => void) => ((onEvent = on), { nudge: () => nudged++, stop: () => (stopped = true) }) };
  const acts: string[] = [];
  const done: string[] = [];
  const hub = {
    snap: { config: { team: [{ id: "ghost", isLead: false }], workflow: { review: { tool: "human", enabled: false }, merge: { by: "human" } }, template: DEV_TEMPLATE }, pullRequests: [] as unknown[], setup: { checks: [] } },
    subscribe: () => () => {},
    emit: () => {},
    activity: (_t: string, _a: string | null, text: string) => acts.push(text),
    name: (id: string) => id,
  };
  const planner = { task: () => ({ id: "B1-T01", ownerId: "ghost", status: "in-progress" }), updateTask: (id: string, p: { status?: string }) => p.status && done.push(`${id}:${p.status}`), notify: () => {} };
  const sync = new GitHubSync(hub as never, planner as never, "me/repo", source as never);
  sync.start();
  check("GitHubSync watches through the GitHubEvents source", typeof onEvent === "function");
  onEvent!({ type: "prs", open: [gh(5)], merged: [], closed: [] });
  check("PRs from the source reach the board", hub.snap.pullRequests.length === 1 && done.includes("B1-T01:in-review"));
  onEvent!({ type: "prs", open: [], merged: [gh(5, true)], closed: [] });
  check("a merge from the source finishes the task", done.includes("B1-T01:done"));
  onEvent!({ type: "rate-limited", until: new Date(Date.now() + 60_000) });
  check("a rate limit from the source is reported once", acts.filter((a) => a.includes("rate limit")).length === 1);
  onEvent!({ type: "rate-limited", until: new Date(Date.now() + 60_000) });
  check("…and not repeated", acts.filter((a) => a.includes("rate limit")).length === 1);
  sync.nudge();
  sync.stop();
  check("nudges and stop go to the source", nudged === 1 && stopped);
}

// ---------------------------------------------------------------- model runs
{
  const ran: { cmd: string; args: string[]; input?: string; env?: Record<string, string> }[] = [];
  const cli = new ClaudeCliRunner(async (cmd, args, opts) => {
    ran.push({ cmd, args, input: opts?.input, env: opts?.env });
    return { ok: true, code: 0, stdout: JSON.stringify({ result: "four", is_error: false, usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 2 } }), stderr: "" } as never;
  });
  const sent: unknown[] = [];
  const api = new AnthropicKeyRunner(
    (account) => (account === "acme-key" ? "test-key-not-real" : null),
    () =>
      ({
        messages: {
          create: async (body: unknown) => (sent.push(body), { stop_reason: "end_turn", stop_details: null, content: [{ type: "text", text: "four" }], usage: { input_tokens: 20, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
        },
      }) as never,
  );
  const accounts = { provider: (a: string) => (a === "acme-key" ? "anthropic" : a === "oai" ? "openai" : null) } as never;
  const runner = new MeteredRunner(db, accounts, cli, api);
  const base = { model: "claude-haiku-5-5", system: "Answer briefly.", prompt: "2+2?", maxTokens: 64, purpose: "helper" as const, projectId: "runs" };

  const viaCli = await runner.run({ ...base, account: "default" });
  check("a CLI sign-in runs claude -p with no tools and the prompt on stdin", ran[0].cmd === "claude" && ran[0].args.includes("-p") && ran[0].args[ran[0].args.indexOf("--tools") + 1] === "" && ran[0].input === "2+2?");
  check("the CLI run's text and tokens come back", viaCli.text === "four" && viaCli.tokens.input === 15 && viaCli.tokens.cached === 100);
  await runner.run({ ...base, account: "personal" });
  check("a named CLI account runs in its own config folder", ran[1].env?.CLAUDE_CONFIG_DIR?.endsWith("claude-personal") === true);

  const viaKey = await runner.run({ ...base, account: "acme-key", taskId: "T1" });
  check("an Anthropic key account runs through the Messages API", viaKey.text === "four" && (sent[0] as { model: string }).model === "claude-haiku-5-5" && ran.length === 2);
  check("every run is metered", spend(db, { projectId: "runs" }).input === 15 + 15 + 20);
  check("an OpenAI key account is refused for now", await rejects(runner.run({ ...base, account: "oai" }), /aren't supported yet/));
  check("a non-Claude model on a CLI sign-in is refused for now", await rejects(runner.run({ ...base, account: "default", model: "gpt-6.1-sol" }), /only through Claude Code/));
  check("a failed CLI run throws instead of returning empty text", await rejects(new ClaudeCliRunner(async () => ({ ok: false, code: 1, stdout: "", stderr: "not signed in" }) as never).run({ ...base, account: "default" }), /not signed in/));
  const refusing = new AnthropicKeyRunner(() => "k", () => ({ messages: { create: async () => ({ stop_reason: "refusal", stop_details: { category: "cyber" }, content: [], usage: { input_tokens: 1, output_tokens: 0 } }) } }) as never);
  check("a refusal is an error, not an empty answer", await rejects(refusing.run({ ...base, account: "acme-key" }), /declined.*cyber/));
}

if (fails) {
  console.error(`\n${fails} failed`);
  process.exit(1);
}
console.log("\nall passed");
