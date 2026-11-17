// The runner for stream-engine agents (docs/design/stream-json.md): HQ writes it into the agent's folder and tmux runs
// it where Claude Code runs (a sandbox, a container). Python 3, standard library only: sbx's Claude sandbox has no
// Node, and both it and the agent image have python3. It reads HQ's address and the agent's token from the Team MCP
// config HQ already writes, starts `claude -p` in stream-json mode, hands it HQ's messages one per line, posts its
// events back, and prints a short readable log, which is what the agent's terminal shows.

import { agentWrite } from "./lib/agentFs";
import { MCP_CONFIG } from "./agentFiles";

export const RUNNER_FILE = ".claude/arima-run.py";
/** Claude's session id, kept so a restarted runner resumes the conversation; deleted on a reset. */
const SESSION_FILE = ".claude/arima-session";

export const streamCommand = (claudeArgs: string[]) => ["python3", RUNNER_FILE, "--", "claude", ...claudeArgs];

export function writeRunner(dir: string) {
  agentWrite(dir, RUNNER_FILE, RUNNER, { mode: 0o644 });
}

const RUNNER = String.raw`#!/usr/bin/env python3
# ArimaOps stream runner (written by HQ; edits are overwritten at the next start).
import json, os, subprocess, sys, threading, time, urllib.request, urllib.error

MCP = ${JSON.stringify(MCP_CONFIG)}
SESSION = ${JSON.stringify(SESSION_FILE)}
STREAM = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]

cfg = json.load(open(MCP))["mcpServers"]["hq"]
base = cfg["url"].rsplit("/mcp", 1)[0]
agent = cfg["headers"]["X-HQ-Agent"]
headers = {"Authorization": cfg["headers"]["Authorization"], "Content-Type": "application/json"}
claude = sys.argv[sys.argv.index("--") + 1:]

def say(text):
    print(time.strftime("%H:%M:%S"), text, flush=True)

def call(method, path, body=None, timeout=35):
    req = urllib.request.Request(base + path, method=method, headers=headers, data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read()

def post(events):
    for attempt in range(5):
        try:
            call("POST", "/agent/%s/events" % agent, events, timeout=15)
            return
        except Exception as e:
            time.sleep(1 + attempt)
    say("couldn't reach HQ to report events")

def show(e):
    t = e.get("type")
    if t == "assistant":
        for c in e.get("message", {}).get("content", []):
            if c.get("type") == "text" and c.get("text", "").strip():
                say("claude: " + c["text"].strip().replace("\n", " ")[:300])
            elif c.get("type") == "tool_use":
                say("tool:   " + c.get("name", "?") + " " + json.dumps(c.get("input", {}))[:200])
    elif t == "result":
        say("done:   %s, %s turns, $%.4f" % (e.get("subtype"), e.get("num_turns"), e.get("total_cost_usd") or 0))

started = {"at": 0, "resumed": False}

def start():
    args = list(claude) + STREAM
    started["resumed"] = os.path.exists(SESSION)
    started["at"] = time.time()
    if started["resumed"]:
        args += ["--resume", open(SESSION).read().strip()]
    say("starting " + " ".join(args[:1]) + (" (resuming)" if "--resume" in args else ""))
    p = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
    threading.Thread(target=read, args=(p,), daemon=True).start()
    post([{"type": "runner", "subtype": "started"}])
    return p

def read(p):
    for line in p.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except ValueError:
            say(line[:300])
            continue
        if e.get("type") == "system" and e.get("subtype") == "init" and e.get("session_id"):
            with open(SESSION, "w") as f:
                f.write(e["session_id"])
        show(e)
        post([e])

def stop(p):
    try:
        p.stdin.close()
        p.wait(timeout=10)
    except Exception:
        p.kill()

proc = start()
ack = 0
while True:
    if proc.poll() is not None:
        say("claude exited (%s); restarting in 3 s" % proc.returncode)
        if started["resumed"] and time.time() - started["at"] < 15 and os.path.exists(SESSION):
            os.remove(SESSION)  # a session it can't resume: start a new one rather than fail forever
        time.sleep(3)
        proc = start()
    try:
        status, body = call("GET", "/agent/%s/next?ack=%d" % (agent, ack))
    except Exception as e:
        say("waiting for HQ (%s)" % e)
        time.sleep(3)
        continue
    if status != 200 or not body:
        continue
    item = json.loads(body)
    if item.get("reset"):
        say("new conversation")
        stop(proc)
        if os.path.exists(SESSION):
            os.remove(SESSION)
        proc = start()
    else:
        say("you:    " + item["text"][:300])
        try:
            proc.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": item["text"]}}) + "\n")
            proc.stdin.flush()
        except Exception:
            say("claude wasn't reading; the message is sent again after a restart")
            continue
    ack = item["seq"]
`;
