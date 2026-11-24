// The stream engine end to end (docs/design/stream-json.md), with no model: HQ's real /agent routes and token
// check, the real runner (Python), and a fake `claude` that answers in the event shapes Claude Code 2.1 prints
// (system init, assistant, rate_limit_event, result; captured from a real headless run).
// Checks: delivery only between turns, nothing lost before an acknowledgement, status from events, a reset
// starts a new conversation, a restarted runner resumes the old one. Skipped where python3 is missing.
//
//   npx tsx scripts/stream-test.ts

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (spawnSync("python3", ["--version"]).status !== 0) {
  console.log("- skipped: python3 isn't installed");
  process.exit(0);
}

const HOME = mkdtempSync(join(tmpdir(), "arima-stream-"));
process.env.HOME = process.env.USERPROFILE = HOME;
const { StreamEngine } = await import("../server/streamEngine");
const { writeRunner, RUNNER_FILE } = await import("../server/streamRunner");
const { startHttp } = await import("../server/http");
const { RemoteGuard } = await import("../server/remote");
const { Users } = await import("../server/users");
const { agentTokenFor } = await import("../server/paths");

let failed = false;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `  ${detail}`}`);
  if (!ok) failed = true;
};
const until = async (what: () => boolean, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (what()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return what();
};

// ---------------------------------------------------------------- the hand-off alone
{
  const status = { state: "idle", note: "" };
  const up: string[] = [];
  const e = new StreamEngine({ status: () => status as never, setStatus: (_id: string, s: object) => void Object.assign(status, s), activity: () => {}, name: (id: string) => id } as never, { up: (id) => void up.push(id) });
  const never = new AbortController().signal;
  check("a runner that hasn't polled isn't ready", !e.ready("a"));
  e.type("a", "first");
  const one = await e.next("a", 0, 0, never);
  const again = await e.next("a", 0, 0, never);
  check("an item stays until the runner acknowledges it", one?.seq === 1 && again?.seq === 1 && "text" in again && again.text === "first");
  check("handing a message over marks a turn running", !e.ready("a"));
  const later = Date.now();
  const none = await e.next("a", 1, 150, never);
  check("acknowledged: the next poll waits, then finds nothing", none === null && Date.now() - later >= 140);
  e.events("a", [{ type: "result", subtype: "success", is_error: false }]);
  check("the turn's result makes it ready again", e.ready("a"));
  e.type("a", "/clear");
  const reset = await e.next("a", 1, 0, never);
  check("the new-conversation command becomes a reset", !!reset && "reset" in reset);
  const waiting = e.next("a", 2, 5000, never);
  setTimeout(() => e.type("a", "wake"), 50);
  const woke = await waiting;
  check("a waiting poll gets a message as soon as it's queued", !!woke && "text" in woke && woke.text === "wake");
  e.events("a", "not a list");
  e.events("a", [null, 7, { type: "something-new" }]);
  check("unknown or malformed events are ignored", true);
}

// ---------------------------------------------------------------- runner, routes and fake claude together
const PORT = 48000 + Math.floor(Math.random() * 1000);
const SECRET = "stream-test-secret";
const status = { state: "idle", note: "", session: { state: "running" } };
const up: string[] = [];
const hub = {
  snap: { config: { team: [] }, agents: [], environments: [] },
  subscribe: () => () => {},
  cfg: (id: string) => (id === "cipher" ? { id, cli: "claude", mode: "container", engine: "stream" } : undefined),
  status: () => status,
  setStatus: (_id: string, s: object) => void Object.assign(status, s),
  activity: () => {},
  name: (id: string) => id,
};
const stream = new StreamEngine(hub as never, { up: (id) => void up.push(id) });
const rt = { slug: "alpha", hub, agentSecret: SECRET, stream, commands: {} };
const server = await startHttp({
  projects: new Map([["alpha", rt as never]]), defaultProject: () => "alpha", loadProject: async () => {}, unloadProject: async () => {},
  port: PORT, browserToken: "link", viewerToken: "viewer", host: "127.0.0.1",
  sameOrigin: false, localOrigins: [], allowedOrigins: [], guard: new RemoteGuard(join(HOME, "guard")), users: new Users(join(HOME, "users.json")), distDir: null,
});

check("the routes need the agent's own token", (await fetch(`http://127.0.0.1:${PORT}/agent/cipher/next`)).status === 401 &&
  (await fetch(`http://127.0.0.1:${PORT}/agent/cipher/events`, { method: "POST", headers: { Authorization: "Bearer nope" }, body: "[]" })).status === 401);

const dir = mkdtempSync(join(tmpdir(), "arima-stream-agent-"));
mkdirSync(join(dir, ".claude"), { recursive: true });
writeFileSync(join(dir, ".claude", "hq-mcp.json"), JSON.stringify({ mcpServers: { hq: { type: "http", url: `http://127.0.0.1:${PORT}/mcp`, headers: { Authorization: `Bearer ${agentTokenFor(SECRET, "cipher")}`, "X-HQ-Agent": "cipher" } } } }));
writeRunner(dir);
const fake = join(dir, "fake-claude.py");
writeFileSync(fake, String.raw`import json, sys, os
log = open("fake.log", "a")
resume = sys.argv[sys.argv.index("--resume") + 1] if "--resume" in sys.argv else None
log.write("start " + (resume or "new") + (" headless" if "--input-format" in sys.argv and "-p" in sys.argv else "") + "\n"); log.flush()
n = 0
for line in sys.stdin:
    msg = json.loads(line)["message"]["content"]
    log.write("got " + msg + "\n"); log.flush()
    sid = resume or "S-%d" % os.getpid()
    if n == 0:
        print(json.dumps({"type": "system", "subtype": "init", "session_id": sid, "model": "claude-haiku-5-5", "cwd": os.getcwd()}), flush=True)
    n += 1
    print(json.dumps({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Read", "input": {"file_path": "a.ts"}}]}, "session_id": sid}), flush=True)
    print(json.dumps({"type": "rate_limit_event", "rate_limit_info": {}, "session_id": sid}), flush=True)
    print(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "ok"}]}, "session_id": sid}), flush=True)
    print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "num_turns": 1, "result": "ok", "total_cost_usd": 0.0032, "session_id": sid,
                      "usage": {"input_tokens": 2, "output_tokens": 4, "cache_read_input_tokens": 9066}}), flush=True)
`);
const log = () => (existsSync(join(dir, "fake.log")) ? readFileSync(join(dir, "fake.log"), "utf8") : "");
const runner = () => spawn("python3", [RUNNER_FILE, "--", "python3", fake], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
const watch = (p: ChildProcess) => (p.stdout?.on("data", (d) => (out += d)), p.stderr?.on("data", (d) => (out += d)), p);

let r = watch(runner());
check("the runner starts claude and tells HQ it's up", await until(() => up.includes("cipher") && stream.ready("cipher")), out);
check("claude is started headless, in stream-json", await until(() => log().includes("start new headless")), log());
stream.type("cipher", "[HQ] Message from you: fix the lexer");
check("a message reaches claude's stdin as one stream-json line", await until(() => log().includes("got [HQ] Message from you: fix the lexer")), log());
check("the turn's result sets it idle and ready for the next", await until(() => status.state === "idle" && stream.ready("cipher")), JSON.stringify(status));
check("the terminal shows a readable log", await until(() => /tool:\s+Read/.test(out) && /done:\s+success/.test(out)), out);
check("the session id is kept for a resume", await until(() => existsSync(join(dir, ".claude", "arima-session"))));

r.kill();
await new Promise((res) => r.once("exit", res));
r = watch(runner());
check("a restarted runner resumes the conversation", await until(() => /start S-\d+ headless/.test(log())), log());
stream.type("cipher", "/clear");
check("a reset starts a new conversation", await until(() => log().trim().split("\n").filter((l) => l.startsWith("start ")).pop() === "start new headless"), log());
stream.type("cipher", "after the reset");
check("and messages after it go to the new one", await until(() => log().includes("got after the reset")), log());

r.kill();
server.close();
process.exit(failed ? 1 : 0);
