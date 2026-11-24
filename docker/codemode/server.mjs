#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// The `codemode` tool server an agent's CLI starts over stdio when its project has Tools as code on.
//   node server.mjs <HQ project URL, as in http://arima-hq:7420/api/projects/ID>
// The agent's HQ token comes from ARIMA_MCP_TOKEN. Every run first asks HQ for the agent's declarations, so a run
// after the owner turns the switch off gets HQ's refusal, and a seat change shows up without a restart.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createRunner, limitsText } from "./run.mjs";

const base = (process.argv[2] ?? "").replace(/\/+$/, "");
const token = process.env.ARIMA_MCP_TOKEN ?? "";
if (!/^https?:\/\/.+\/api\/projects\/[^/]+$/.test(base) || !token) {
  console.error("usage: ARIMA_MCP_TOKEN=... node server.mjs http://HQ/api/projects/ID");
  process.exit(2);
}
const auth = { Authorization: `Bearer ${token}` };

async function declarations() {
  const resp = await fetch(`${base}/mcp-codemode/declarations`, { headers: auth });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(body.error ?? body.message ?? `HQ answered ${resp.status}.`);
  return body;
}

/** A tool result as a value: structured content, else the text (parsed when it's JSON); an error result throws. */
function unwrap(res) {
  const text = (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  if (res.isError) throw new Error(text || "The tool failed.");
  if (res.structuredContent !== undefined) return res.structuredContent;
  if (res.content?.length === 1 && res.content[0].type === "text") {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return res.content ?? null;
}

/** HQ's own message from a refused call, which the SDK wraps in its transport error. */
function hqMessage(e) {
  const body = /(\{"error":.*\})\s*$/.exec(e.message)?.[1];
  try {
    return body ? JSON.parse(body).error : e.message;
  } catch {
    return e.message;
  }
}

const run = createRunner();

async function codemode(code) {
  const decl = await declarations();
  const clients = new Map();
  const client = async (ns) => {
    if (!clients.has(ns)) {
      const { server } = decl.namespaces[ns];
      const url = new URL(server === null ? `${base}/mcp` : `${base}/mcp/${encodeURIComponent(server)}`);
      const c = new Client({ name: "arimaops-codemode", version: "1.0.0" });
      clients.set(ns, c.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: auth } })).then(() => c));
    }
    return clients.get(ns);
  };
  const namespaces = Object.fromEntries(Object.entries(decl.namespaces).map(([ns, n]) => [ns, Object.keys(n.tools)]));
  const search = (query) => {
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    return decl.index.filter((d) => words.every((w) => `${d.name} ${d.description}`.toLowerCase().includes(w))).slice(0, 20);
  };
  try {
    return await run(code, {
      namespaces,
      search,
      call: async (ns, tool, args) => {
        const res = await (await client(ns)).callTool({ name: decl.namespaces[ns].tools[tool], arguments: args }).catch((e) => {
          throw new Error(hqMessage(e));
        });
        return unwrap(res);
      },
    });
  } finally {
    for (const c of clients.values()) c.then((x) => x.close()).catch(() => {});
  }
}

const server = new Server({ name: "codemode", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const decl = await declarations();
  return {
    tools: [
      {
        name: "codemode",
        description: `${decl.description}\n${limitsText()}`,
        inputSchema: { type: "object", properties: { code: { type: "string", description: "JavaScript: an async arrow function, or statements that `return` the result." } }, required: ["code"] },
      },
    ],
  };
});
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "codemode") throw new Error(`Unknown tool: ${req.params.name}`);
  const out = await codemode(req.params.arguments?.code).catch((e) => ({ error: e.message, logs: [] }));
  return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out, isError: "error" in out };
});
await server.connect(new StdioServerTransport());
