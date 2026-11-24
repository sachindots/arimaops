// The codemode runner baked into the agent image (docker/codemode). Run: npx tsx scripts/codemode-test.ts
import { createRunner, LIMITS, normalize, spawnChild } from "../docker/codemode/run.mjs";

let fails = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  if (!ok) fails++;
};

const calls: [string, string, unknown][] = [];
const tools = {
  namespaces: { arima: ["list_tasks", "get_task"], docs: ["read_page"] },
  call: async (ns: string, tool: string, args: any) => {
    calls.push([ns, tool, args]);
    if (tool === "list_tasks") return [{ id: "T1" }, { id: "T2" }];
    if (tool === "get_task") return { id: args.id, title: `Task ${args.id}` };
    throw new Error("upstream refused");
  },
  search: (query: string) => [{ name: "codemode.docs.read_page", query }],
};

const short = { ...LIMITS, timeMs: 1500 };
const run = createRunner(short);

check("the limits are the plan's", LIMITS.timeMs === 30_000 && LIMITS.heapMb === 128 && LIMITS.calls === 50 && LIMITS.resultBytes === 65536 && LIMITS.logBytes === 16384 && LIMITS.concurrent === 2, LIMITS);
check("a fenced reply is unwrapped", normalize("```js\nasync () => 1\n```") === "async () => 1");

let r: any = await run(
  `async () => {
    const tasks = await codemode.arima.list_tasks({});
    const full = await Promise.all(tasks.map((t) => codemode.arima.get_task({ id: t.id })));
    console.log("found", tasks.length, { first: tasks[0].id });
    return full.map((t) => t.title);
  }`,
  tools,
);
check("chained calls return one value", JSON.stringify(r.result) === '["Task T1","Task T2"]', r);
check("console lines come back as logs", JSON.stringify(r.logs) === '["found 2 {\\"first\\":\\"T1\\"}"]', r.logs);
check("each call reached the parent", calls.length === 3 && calls[1][2] && (calls[1][2] as any).id === "T1", calls);

r = await run("const t = await codemode.arima.list_tasks();\nreturn t.length;", tools);
check("plain statements with await and return run", r.result === 2, r);
r = await run("1 + 1", tools);
check("an expression is its own result", r.result === 2, r);
r = await run("async () => { try { await codemode.docs.read_page({}); } catch (e) { return e.message; } }", tools);
check("a failed tool call throws inside the script", r.result === "upstream refused", r);
r = await run("async () => codemode.search('page')", tools);
check("search is answered by the parent", r.result?.[0]?.query === "page", r);
r = await run("async () => codemode.docs.delete_all({})", tools);
check("an undeclared tool doesn't exist", /not a function/.test(r.error), r);

let started = Date.now();
r = await run("while (true) {}", tools);
check("a synchronous infinite loop is killed at the deadline", /stopped: a run may take at most 1.5 s/.test(r.error) && Date.now() - started < 3000, r);
started = Date.now();
r = await run("async () => 'ok'", tools);
check("the next run succeeds within 2 s", r.result === "ok" && Date.now() - started < 2000, { r, ms: Date.now() - started });

r = await run("const a = []; while (true) a.push(new Array(1e6).fill(Math.random()));", tools);
check("a heap blow-up is killed", /more than 128 MB/.test(r.error), r);

r = await run("async () => await fetch('https://example.com')", tools);
check("fetch of another host fails", /fetch is not defined/.test(r.error), r);
for (const escape of ["this.constructor.constructor('return process')()", "globalThis.constructor.constructor('return process')()", "Object.getPrototypeOf(globalThis).constructor.constructor('return process')()", "codemode.constructor.constructor('return process')()", "await (async () => 1).constructor('return process')()", "new Error().constructor.constructor('return process')()"]) {
  r = await run(`async () => typeof (${escape})`, tools);
  check(`the code can't reach process: ${escape}`, r.result === "undefined" || /process is not defined|Cannot read properties of (undefined|null)/.test(r.error), r);
}
r = await run("async () => [typeof require, typeof setTimeout, typeof globalThis.process, typeof import.meta]", tools);
check("no require, timers or process", r.error !== undefined || JSON.stringify(r.result) === '["undefined","undefined","undefined"]', r);
r = await run("async () => { const f = codemode.arima.list_tasks; return typeof f.constructor('return process')(); }", tools);
check("an API function doesn't lead out of the sandbox", r.result === "undefined" || /process is not defined/.test(r.error), r);

const child = (code: string) =>
  new Promise<{ out: string; err: string; status: number | null }>((resolve) => {
    const c = spawnChild(["-e", code]);
    let out = "";
    let err = "";
    c.stdout.on("data", (d: Buffer) => (out += d));
    c.stderr.on("data", (d: Buffer) => (err += d));
    c.on("close", (status: number | null) => resolve({ out, err, status }));
  });
process.env.ARIMA_MCP_TOKEN = "mcp_secret-token";
process.env.ARIMA_CODEMODE_PARENT_ONLY = "parent";
let c = await child("process.stdout.write(JSON.stringify(process.env))");
const childEnv = JSON.parse(c.out || "{}");
// macOS and Windows add a few OS variables to every process even with env {}; nothing of the parent's may get through.
check(
  "the child's environment holds nothing of the parent's, no token",
  !c.out.includes("mcp_secret-token") && !("ARIMA_MCP_TOKEN" in childEnv) && !("ARIMA_CODEMODE_PARENT_ONLY" in childEnv) && (process.platform !== "linux" || c.out === "{}"),
  c,
);
c = await child("require('fs').writeFileSync('/tmp/codemode-should-not-exist', 'x')");
check("file writes are denied", /ERR_ACCESS_DENIED/.test(c.err) && c.status !== 0, c.err.slice(0, 300));
c = await child("require('child_process').spawnSync('true')");
check("spawning a process is denied", /ERR_ACCESS_DENIED/.test(c.err), c.err.slice(0, 300));
c = await child("new (require('worker_threads').Worker)('1', { eval: true })");
check("workers are denied", /ERR_ACCESS_DENIED/.test(c.err), c.err.slice(0, 300));
c = await child("require('fs').readFileSync('/etc/hostname')");
check("reading other files is denied", /ERR_ACCESS_DENIED/.test(c.err), c.err.slice(0, 300));

r = await run(`async () => { const out = []; for (let i = 0; i < 52; i++) { try { await codemode.arima.list_tasks({}); out.push("ok"); } catch (e) { out.push(e.message); } } return out.slice(49); }`, tools);
check("at most 50 tool calls per run", r.result?.[0] === "ok" && /already made 50 tool calls/.test(r.result?.[1]), r);
r = await run("async () => 'x'.repeat(70000)", tools);
check("a result over 64 KB is refused", /at most 64 KB/.test(r.error), r);
r = await run("async () => { for (let i = 0; i < 100; i++) console.log('y'.repeat(1000)); return 1; }", tools);
check("logs are cut at 16 KB", r.result === 1 && r.logs.length === 17 && /cut at 16 KB/.test(r.logs[16]), r.logs.length);

const loops = [run("while (true) {}", tools), run("while (true) {}", tools)];
r = await run("async () => 1", tools);
check("a third concurrent run for one agent is refused", /2 runs are already going/.test(r.error), r);
await Promise.all(loops);
r = await run("async () => 1", tools);
check("runs start again once one ends", r.result === 1, r);

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
