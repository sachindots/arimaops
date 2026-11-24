// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs agent-written code, one fresh child process per run. The child has no environment and no token, can't write
// files or start processes or workers, and asks this process for every tool call; this process makes the call.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const LIMITS = { timeMs: 30_000, heapMb: 128, calls: 50, resultBytes: 64 << 10, logBytes: 16 << 10, concurrent: 2 };

const CHILD = fileURLToPath(new URL("./child.cjs", import.meta.url));
// A child printing more than this between our reads is broken or hostile; it is stopped.
const MAX_LINE = 1 << 20;

export function limitsText(limits = LIMITS) {
  return `Limits per run: ${limits.timeMs / 1000} s, ${limits.heapMb} MB of memory, ${limits.calls} tool calls, ${limits.resultBytes >> 10} KB of result, ${limits.logBytes >> 10} KB of logs.`;
}

/** Starts Node under the run's restrictions; `args` is the script (the child, or `-e` in tests). */
export function spawnChild(args, limits = LIMITS) {
  return spawn(process.execPath, ["--permission", `--allow-fs-read=${CHILD}`, `--max-old-space-size=${limits.heapMb}`, ...args], {
    env: {},
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Strips a Markdown fence around the code and the whitespace around it. */
export function normalize(code) {
  const text = String(code ?? "").trim();
  const fenced = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(text);
  return (fenced ? fenced[1] : text).trim();
}

/**
 * A runner for one agent. `call(ns, tool, args)` makes a tool call and returns its value or throws; `search(query)`
 * answers `codemode.search`. Each `run` resolves to `{ result, logs }` or `{ error, logs }`, never rejects.
 */
export function createRunner(limits = LIMITS) {
  let active = 0;
  return async function run(code, { namespaces, call, search }) {
    if (active >= limits.concurrent) {
      return { error: `${limits.concurrent} runs are already going for this agent. Wait for one to finish.`, logs: [] };
    }
    active++;
    try {
      return await once(normalize(code), namespaces, call, search, limits);
    } finally {
      active--;
    }
  };
}

function once(code, namespaces, call, search, limits) {
  return new Promise((resolve) => {
    const child = spawnChild([CHILD], limits);
    const logs = [];
    let logBytes = 0;
    let logsCut = false;
    let calls = 0;
    let out = "";
    let err = "";
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      if (logsCut) logs.push(`[later logs cut at ${limits.logBytes >> 10} KB]`);
      resolve({ ...outcome, logs });
    };
    const timer = setTimeout(() => finish({ error: `The script was stopped: a run may take at most ${limits.timeMs / 1000} s.` }), limits.timeMs);
    const reply = (msg) => {
      if (!settled) child.stdin.write(JSON.stringify(msg) + "\n");
    };

    const handle = async (msg) => {
      if (msg.type === "log") {
        if (logsCut || logBytes + msg.line.length > limits.logBytes) logsCut = true;
        else (logBytes += msg.line.length), logs.push(msg.line);
      } else if (msg.type === "call") {
        if (msg.ns === null && msg.tool === "search") return reply({ type: "reply", id: msg.id, value: search(msg.args.query) });
        if (++calls > limits.calls) return reply({ type: "reply", id: msg.id, error: `This run already made ${limits.calls} tool calls, the most one run may make.` });
        if (!namespaces[msg.ns]?.includes(msg.tool)) return reply({ type: "reply", id: msg.id, error: `codemode.${msg.ns}.${msg.tool} isn't a tool this agent has.` });
        try {
          reply({ type: "reply", id: msg.id, value: await call(msg.ns, msg.tool, msg.args) });
        } catch (e) {
          reply({ type: "reply", id: msg.id, error: e instanceof Error ? e.message : String(e) });
        }
      } else if (msg.type === "done") {
        if (msg.result.length > limits.resultBytes) {
          finish({ error: `The result is ${msg.result.length >> 10} KB; one run returns at most ${limits.resultBytes >> 10} KB. Return less.` });
        } else finish({ result: JSON.parse(msg.result) });
      } else if (msg.type === "error") finish({ error: msg.error });
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
      let nl;
      while ((nl = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, nl);
        out = out.slice(nl + 1);
        handle(JSON.parse(line)).catch((e) => finish({ error: `The runner failed: ${e.message}` }));
      }
      if (out.length > MAX_LINE) finish({ error: "The script sent more than the runner reads at once." });
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (err.length < 4096) err += chunk;
    });
    child.stdin.on("error", () => {});
    child.on("close", (code, signal) => {
      const oom = /heap out of memory|Allocation failed/i.test(err);
      finish({ error: oom ? `The script was stopped: it used more than ${limits.heapMb} MB of memory.` : `The script's process ended (${signal ?? `exit ${code}`}). ${err.trim().split("\n").slice(-3).join(" ")}`.trim() });
    });
    child.on("error", (e) => finish({ error: `The runner couldn't start the script: ${e.message}` }));
    child.stdin.write(JSON.stringify({ type: "run", code, namespaces }) + "\n");
  });
}
