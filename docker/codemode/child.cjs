// SPDX-License-Identifier: AGPL-3.0-or-later
// One codemode run. The parent starts this under a heap limit, sends one `run` line on stdin, answers each
// `call` line, and kills the process when the run ends or overstays.
"use strict";

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const pending = new Map();
let nextId = 0;

const show = (v) => {
  if (typeof v === "string") return v;
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
  } catch {
    return String(v);
  }
};
const logLine = (...a) => send({ type: "log", line: a.map(show).join(" ") });
const capturedConsole = { log: logLine, info: logLine, warn: logLine, error: logLine, debug: logLine };

const call = (ns, tool, args) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    send({ type: "call", id, ns, tool, args: args === undefined ? {} : args });
  });

function describe(err) {
  try {
    if (err && typeof err === "object" && "message" in err) return `${err.name || "Error"}: ${err.message}`;
    return String(err);
  } catch {
    return "The script failed.";
  }
}

async function run({ code, namespaces }) {
  const api = { search: (query) => call(null, "search", { query: String(query) }) };
  for (const [ns, tools] of Object.entries(namespaces)) {
    api[ns] = Object.freeze(Object.fromEntries(tools.map((t) => [t, (args) => call(ns, t, args)])));
  }
  const codemode = Object.freeze(api);

  let fn;
  try {
    // An expression: usually `async () => { ... }`, which is then called.
    fn = new Function("codemode", "console", `return (${code}\n);`);
  } catch {
    // Statements: run as an async function's body, so `await` and `return` work.
    fn = new Function("codemode", "console", `return (async () => {\n${code}\n})();`);
  }
  let value = fn(codemode, capturedConsole);
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
      if (p && "error" in msg) p.reject(new Error(String(msg.error)));
      else if (p) p.resolve(msg.value === undefined ? null : msg.value);
    }
  }
});
