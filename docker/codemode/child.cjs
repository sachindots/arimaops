// SPDX-License-Identifier: AGPL-3.0-or-later
// One codemode run. The parent starts this with an empty environment under Node's permission model, sends one
// `run` line on stdin, answers each `call` line, and kills the process when the run ends or overstays.
"use strict";
const vm = require("node:vm");

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const pending = new Map();
let nextId = 0;

// The code sees only what the bootstrap below builds inside its own context. Every value the host hands it is a
// string, so no host object (and through it the host's Function or process) is ever reachable from the code.
function bridge(kind, payload, resolve, reject) {
  try {
    if (kind === "log") return send({ type: "log", line: String(payload) });
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    send({ type: "call", id, ...JSON.parse(String(payload)) });
  } catch {
    // Never let a host error object reach the code.
  }
}

const BOOTSTRAP = `(() => {
  const bridge = globalThis.__bridge;
  delete globalThis.__bridge;
  const show = (v) => {
    if (typeof v === "string") return v;
    try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch { return String(v); }
  };
  const out = (...a) => bridge("log", a.map(show).join(" "));
  globalThis.console = { log: out, info: out, warn: out, error: out, debug: out };
  const call = (ns, tool, args) => new Promise((resolve, reject) =>
    bridge("call", JSON.stringify({ ns, tool, args: args === undefined ? {} : args }), (text) => resolve(JSON.parse(text)), (message) => reject(new Error(message))));
  const api = { search: (query) => call(null, "search", { query: String(query) }) };
  const namespaces = JSON.parse(globalThis.NAMESPACES);
  delete globalThis.NAMESPACES;
  for (const [ns, tools] of Object.entries(namespaces)) {
    api[ns] = Object.freeze(Object.fromEntries(tools.map((t) => [t, (args) => call(ns, t, args)])));
  }
  globalThis.codemode = Object.freeze(api);
})();`;

function describe(err) {
  try {
    if (err && typeof err === "object" && "message" in err) return `${err.name || "Error"}: ${err.message}`;
    return String(err);
  } catch {
    return "The script failed.";
  }
}

async function run({ code, namespaces }) {
  // A null-prototype global: a plain object would lend the code the host's Object, and through it the host's Function.
  const context = vm.createContext(Object.assign(Object.create(null), { __bridge: bridge, NAMESPACES: JSON.stringify(namespaces) }));
  vm.runInContext(BOOTSTRAP, context);
  let script;
  try {
    // An expression: usually `async () => { ... }`, which is then called.
    script = new vm.Script(`(${code}\n)`);
  } catch {
    // Statements: run as an async function's body, so `await` and `return` work.
    script = new vm.Script(`(async () => {\n${code}\n})()`);
  }
  let value = script.runInContext(context);
  if (typeof value === "function") value = value();
  value = await value;
  return JSON.stringify(value) ?? "null";
}

process.on("unhandledRejection", () => {});
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let nl;
  while ((nl = input.indexOf("\n")) >= 0) {
    const msg = JSON.parse(input.slice(0, nl));
    input = input.slice(nl + 1);
    if (msg.type === "run") {
      run(msg).then(
        (result) => send({ type: "done", result }),
        (err) => send({ type: "error", error: describe(err) }),
      );
    } else if (msg.type === "reply") {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (p && "error" in msg) p.reject(String(msg.error));
      else if (p) p.resolve(JSON.stringify(msg.value === undefined ? null : msg.value));
    }
  }
});
