// SPDX-License-Identifier: AGPL-3.0-or-later
// Tool connections: the owner's remote MCP servers (CRM, analytics, billing, mail) that HQ itself talks to, so the
// agents never hold the key and never reach the service. Blocked by default:
// - an agent sees a connection only when its role is listed, and calls only the tools the owner ticked as read
//   tools (read_connection);
// - one tool may be the connection's send tool. No agent calls it. An agent proposes a send (propose_send), the
//   owner reads it in the Inbox, and HQ calls the tool once per click of Send (server/actionItems.ts).
// A server's own description doesn't prove a tool only reads, so the owner decides per tool; prefer a read-only key.

import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ConnectionInput, ToolConnection } from "../src/data/types";
import { BRAND } from "../src/data/brand";
import { credentialsVault, redactor } from "./credentials/registry";
import { readDoc, writeDoc } from "./lib/docs";
import { homeRoot } from "./paths";

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_OUTPUT = 20_000;
const TIMEOUT_MS = 30_000;

const file = () => join(homeRoot(), "connections.json");
const keyRef = (name: string) => `connection:${name}`;

interface Stored {
  name: string;
  url: string;
  roles: string[];
  read: string[];
  send: string | null;
  tools: { name: string; description: string }[];
  probedAt: string | null;
}

const load = (): Stored[] => readDoc<Stored[]>(file()) ?? [];
const store = (all: Stored[]) => writeDoc(file(), all);

function hasKey(name: string): boolean {
  try {
    return credentialsVault().list().some((s) => s.ref === keyRef(name));
  } catch {
    return false; // vault locked
  }
}

/** Every connection as the UI sees it: no key, only whether one is stored. */
export function listConnections(): ToolConnection[] {
  return load().map((c) => ({ ...c, hasKey: hasKey(c.name) }));
}

/** HTTPS, or plain HTTP to this machine only. */
export function checkUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error("The connection needs the MCP server's URL, like https://mcp.example.com/mcp.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.username || u.password) throw new Error("Put the key in the key field, not in the URL.");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error("Use an https:// URL (plain http only for this machine).");
  return u.toString();
}


/** Adds or edits a connection. Read and send tools must come from the last tool list (Check tools). */
export function saveConnection(input: ConnectionInput): ToolConnection {
  const name = String(input.name ?? "").trim().toLowerCase();
  if (!NAME.test(name)) throw new Error("A connection name is lowercase letters, digits and dashes, like crm or stripe.");
  const all = load();
  const old = all.find((c) => c.name === name);
  const url = input.url !== undefined ? checkUrl(input.url) : old?.url;
  if (!url) throw new Error("The connection needs the MCP server's URL.");
  const next: Stored = old ? { ...old, url } : { name, url, roles: [], read: [], send: null, tools: [], probedAt: null };
  if (old && url !== old.url) Object.assign(next, { tools: [], read: [], send: null, probedAt: null }); // another server: tick its tools again
  if (input.roles) next.roles = [...new Set(input.roles.map((r) => String(r).trim()).filter(Boolean))].slice(0, 40);
  const known = new Set(next.tools.map((t) => t.name));
  if (input.read) {
    const unknown = input.read.filter((t) => !known.has(t));
    if (unknown.length) throw new Error(`Not tools of ${name}: ${unknown.join(", ")}. Check tools first.`);
    next.read = [...new Set(input.read)];
  }
  if (input.send !== undefined) {
    if (input.send !== null && !known.has(input.send)) throw new Error(`${input.send} is not a tool of ${name}. Check tools first.`);
    next.send = input.send;
  }
  if (next.send && next.read.includes(next.send)) throw new Error(`${next.send} can't be both a read tool and the send tool.`);
  if (input.apiKey !== undefined) {
    if (input.apiKey.trim()) credentialsVault().set(keyRef(name), input.apiKey.trim());
    else credentialsVault().delete(keyRef(name));
  }
  store([...all.filter((c) => c.name !== name), next].sort((a, b) => a.name.localeCompare(b.name)));
  return { ...next, hasKey: hasKey(name) };
}

export function removeConnection(name: string) {
  store(load().filter((c) => c.name !== name));
  try {
    credentialsVault().delete(keyRef(name));
  } catch {
    /* vault locked: the key stays until it's unlocked; it is unused without the connection */
  }
}

/** Runs `fn` with a client connected to the connection's server, then closes it. */
async function withClient<T>(c: Stored, fn: (client: Client) => Promise<T>): Promise<T> {
  const key = hasKey(c.name) ? credentialsVault().get(keyRef(c.name)) : null;
  const transport = new StreamableHTTPClientTransport(new URL(c.url), key ? { requestInit: { headers: { Authorization: `Bearer ${key}` } } } : undefined);
  const client = new Client({ name: BRAND.name, version: "1" });
  const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${c.name} didn't answer within ${TIMEOUT_MS / 1000} s.`)), TIMEOUT_MS).unref());
  try {
    return await Promise.race([
      (async () => {
        await client.connect(transport);
        return fn(client);
      })(),
      timer,
    ]);
  } finally {
    await client.close().catch(() => {});
  }
}

/** Asks the server for its tools and keeps the list; read and send tools no longer offered are dropped. */
export async function probeConnection(name: string): Promise<ToolConnection> {
  const all = load();
  const c = all.find((x) => x.name === name);
  if (!c) throw new Error(`No connection ${name}.`);
  const { tools } = await withClient(c, (client) => client.listTools());
  c.tools = tools.slice(0, 200).map((t) => ({ name: t.name, description: (t.description ?? "").replace(/\s+/g, " ").slice(0, 300) }));
  const names = new Set(c.tools.map((t) => t.name));
  c.read = c.read.filter((t) => names.has(t));
  if (c.send && !names.has(c.send)) c.send = null;
  c.probedAt = new Date().toISOString();
  store(all);
  return { ...c, hasKey: hasKey(c.name) };
}

/** The connections a role may use. */
export function connectionsFor(roleId: string | undefined): ToolConnection[] {
  return roleId ? listConnections().filter((c) => c.roles.includes(roleId)) : [];
}

/** The result as text: redacted (the key and stored secrets) and capped. */
function textOf(result: unknown, key: string | null): string {
  const r = result as { content?: { type: string; text?: string }[]; isError?: boolean; structuredContent?: unknown };
  const parts = (r.content ?? []).map((p) => (p.type === "text" ? (p.text ?? "") : `[${p.type} content left out]`));
  let text = parts.join("\n") || (r.structuredContent ? JSON.stringify(r.structuredContent) : "");
  if (key) text = text.split(key).join("[redacted]");
  text = redactor().redact(text);
  if (text.length > MAX_OUTPUT) text = `${text.slice(0, MAX_OUTPUT)}\n[cut at ${MAX_OUTPUT} characters: ask for less, with a filter or a limit]`;
  return r.isError ? `The tool returned an error: ${text}` : text;
}

/**
 * Calls one tool. `as` says who asks: an agent's role may call only ticked read tools; "owner-send" calls only the
 * connection's send tool and comes only from the owner's click (ActionItems.send).
 */
export async function callConnection(name: string, tool: string, args: Record<string, unknown>, as: { roleId: string | undefined } | "owner-send"): Promise<string> {
  const c = load().find((x) => x.name === name);
  if (!c) throw new Error(`No connection ${name}.`);
  if (as === "owner-send") {
    if (tool !== c.send) throw new Error(`${tool} is not ${name}'s send tool.`);
  } else {
    if (!as.roleId || !c.roles.includes(as.roleId)) throw new Error(`Your role can't use ${name}. The owner chooses which roles get each connection.`);
    if (!c.read.includes(tool))
      throw new Error(tool === c.send ? `${tool} sends: propose it with propose_send and the owner sends it.` : `${tool} isn't one of ${name}'s read tools (${c.read.join(", ") || "none ticked yet"}).`);
  }
  const key = hasKey(c.name) ? credentialsVault().get(keyRef(c.name)) : null;
  return withClient(c, async (client) => textOf(await client.callTool({ name: tool, arguments: args }), key));
}
