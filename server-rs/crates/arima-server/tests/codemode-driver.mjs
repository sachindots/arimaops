// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs inside the agent image for tests/codemode_container.rs: starts the codemode server over stdio the way a CLI
// does, prints one JSON line of results, waits for a line on stdin, then makes one more call and prints that.
import { Client } from "/opt/arima-codemode/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "/opt/arima-codemode/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const client = new Client({ name: "codemode-e2e", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["/opt/arima-codemode/server.mjs", process.argv[2]], env: { ARIMA_MCP_TOKEN: process.env.ARIMA_MCP_TOKEN, PATH: process.env.PATH } }));
const call = async (code) => {
  const started = Date.now();
  const res = await client.callTool({ name: "codemode", arguments: { code } }, undefined, { timeout: 120_000 });
  return { ...res.structuredContent, ms: Date.now() - started };
};

const out = { tools: (await client.listTools()).tools.map((t) => ({ name: t.name, description: t.description })) };
out.chain = await call(`async () => {
  const tasks = await codemode.arima.list_tasks({});
  const page = await codemode.web_docs.search({ q: "x", token: "hidden" });
  console.log("tasks is a list:", Array.isArray(tasks.tasks));
  return { tasks, page };
}`);
out.found = await call("async () => (await codemode.search('search')).map((d) => d.name)");
out.loop = await call("while (true) {}");
out.after = await call("async () => 'ok'");
out.blocked = await call(`async () => {
  await codemode.web_docs.block_me({});
  try { await codemode.web_docs.search({ q: "y" }); return "not refused"; } catch (e) { return e.message; }
}`);
out.heap = await call("const a = []; while (true) a.push(new Array(1e6).fill(Math.random()));");
console.log(JSON.stringify(out));

await new Promise((resolve) => process.stdin.once("data", resolve));
console.log(JSON.stringify({ off: await call("async () => 1") }));
await client.close();
process.exit(0);
