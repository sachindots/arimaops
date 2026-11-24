// Tool connections (server/connections.ts) against a real MCP server on this machine: HQ sends the owner's key,
// agents call only the ticked read tools of connections their role has, the key never shows in results, and the
// send tool runs only from the owner's click on a proposed send, once.
//
//   npx tsx scripts/connections-test.ts

import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = process.env.USERPROFILE = mkdtempSync(join(tmpdir(), "arima-conn-"));
process.env.ARIMA_MASTER_KEY ??= "b".repeat(64);
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = await import("zod");
const { callConnection, checkUrl, connectionsFor, listConnections, probeConnection, removeConnection, saveConnection } = await import("../server/connections");
const { ActionItems } = await import("../server/actionItems");

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};
const rejects = async (p: Promise<unknown>, re: RegExp) => {
  try {
    await p;
    return false;
  } catch (e) {
    return re.test((e as Error).message);
  }
};

// ---------------------------------------------------------------- a pretend CRM
const KEY = "crm-key-0123456789abcdef";
const seen: { auth?: string; tool: string; args: unknown }[] = [];
let lastAuth = "";
const crm = () => {
  const s = new McpServer({ name: "crm", version: "1" });
  s.registerTool("search_contacts", { description: "Find contacts.", inputSchema: { q: z.string() } }, async ({ q }) => {
    seen.push({ auth: lastAuth, tool: "search_contacts", args: { q } });
    return { content: [{ type: "text", text: `Acme: jo@acme.test (key echo: ${KEY})` }] };
  });
  s.registerTool("delete_contact", { description: "Delete a contact.", inputSchema: { id: z.string() } }, async ({ id }) => {
    seen.push({ tool: "delete_contact", args: { id } });
    return { content: [{ type: "text", text: "deleted" }] };
  });
  s.registerTool("send_email", { description: "Send an email.", inputSchema: { to: z.string(), body: z.string() } }, async (args) => {
    seen.push({ tool: "send_email", args });
    return { content: [{ type: "text", text: "queued" }] };
  });
  return s;
};
const http: Server = createServer(async (req, res) => {
  lastAuth = req.headers.authorization ?? "";
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = crm();
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
});
await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;

// ---------------------------------------------------------------- the owner sets it up
check("https or this machine only", (() => {
  try {
    checkUrl("http://crm.example.com/mcp");
    return false;
  } catch {
    return checkUrl("https://crm.example.com/mcp").startsWith("https://") && checkUrl(url) === url;
  }
})());
saveConnection({ name: "crm", url, apiKey: KEY });
check("a new connection: no roles, no tools, nothing callable", connectionsFor("sales").length === 0 && listConnections()[0].hasKey && listConnections()[0].read.length === 0);
check("tools can't be ticked before Check tools", (() => {
  try {
    saveConnection({ name: "crm", read: ["search_contacts"] });
    return false;
  } catch (e) {
    return /Check tools first/.test((e as Error).message);
  }
})());
const probed = await probeConnection("crm");
check("Check tools lists the server's tools", probed.tools.map((t) => t.name).sort().join() === "delete_contact,search_contacts,send_email", JSON.stringify(probed.tools));
saveConnection({ name: "crm", roles: ["sales"], read: ["search_contacts"], send: "send_email" });
check("a tool can't be both read and send", (() => {
  try {
    saveConnection({ name: "crm", read: ["search_contacts", "send_email"] });
    return false;
  } catch (e) {
    return /both/.test((e as Error).message);
  }
})());

// ---------------------------------------------------------------- agents read
const out = await callConnection("crm", "search_contacts", { q: "acme" }, { roleId: "sales" });
check("a sales agent reads through HQ with the owner's key", out.includes("jo@acme.test") && seen.at(-1)?.auth === `Bearer ${KEY}`, JSON.stringify(seen.at(-1)));
check("…and never sees the key, even when the server echoes it", !out.includes(KEY) && out.includes("[redacted]"), out);
check("another role can't use it", await rejects(callConnection("crm", "search_contacts", { q: "x" }, { roleId: "marketer" }), /Your role can't use crm/));
check("an unticked tool can't be called", await rejects(callConnection("crm", "delete_contact", { id: "1" }, { roleId: "sales" }), /isn't one of crm's read tools/) && !seen.some((s) => s.tool === "delete_contact"));
check("an agent can't call the send tool", await rejects(callConnection("crm", "send_email", { to: "a", body: "b" }, { roleId: "sales" }), /propose it with propose_send/) && !seen.some((s) => s.tool === "send_email"));
check("the owner path calls only the send tool", await rejects(callConnection("crm", "delete_contact", { id: "1" }, "owner-send"), /not crm's send tool/));

// ---------------------------------------------------------------- a proposed send, sent by the owner's click
{
  const team = [{ id: "bd", name: "Bea", roleId: "sales", isLead: false }];
  const snap = { config: { team, project: { id: "co" } }, tasks: [], actionItems: [] };
  const hub = { slug: "co", snap, emit: () => {}, activity: () => {}, cfg: (id: string) => team.find((a) => a.id === id), name: (id: string) => team.find((a) => a.id === id)?.name ?? id };
  const told: string[] = [];
  const planner = { currentTask: () => null, notify: (_: string, t: string) => void told.push(t) };
  const items = new ActionItems(hub as never, planner as never);
  const item = items.addSend("bd", "Reply to Acme", "They asked for the invoice.", { connection: "crm", tool: "send_email", args: { to: "jo@acme.test", body: "Invoice attached." } });
  check("a proposal waits in the Inbox; nothing is sent yet", item.kind === "send" && !seen.some((s) => s.tool === "send_email"));
  check("it can't be marked done without sending", (() => {
    try {
      items.resolve(item.id, "done");
      return false;
    } catch (e) {
      return /only with Send/.test((e as Error).message);
    }
  })());
  const call = (s: { connection: string; tool: string; args: Record<string, unknown> }) => callConnection(s.connection, s.tool, s.args, "owner-send");
  await items.send(item.id, call);
  const sent = seen.filter((s) => s.tool === "send_email");
  check("Send makes exactly that call, once", sent.length === 1 && JSON.stringify(sent[0].args) === JSON.stringify({ to: "jo@acme.test", body: "Invoice attached." }), JSON.stringify(sent));
  check("…the item is done and the agent is told", snap.actionItems.some((i: { id: string; status: string }) => i.id === item.id && i.status === "done") && told.some((t) => /sent "Reply to Acme"/.test(t)));
  check("a second click sends nothing", (await rejects(items.send(item.id, call), /no longer open/)) && seen.filter((s) => s.tool === "send_email").length === 1);
  const other = items.addSend("bd", "Follow up", "", { connection: "crm", tool: "send_email", args: { to: "x", body: "y" } });
  items.resolve(other.id, "dismissed", "not now");
  check("Don't send: nothing goes out, the agent hears why", seen.filter((s) => s.tool === "send_email").length === 1 && told.some((t) => /didn't send "Follow up".*not now/.test(t)));
  const failing = items.addSend("bd", "Broken", "", { connection: "crm", tool: "send_email", args: { to: "x" } }); // body missing: the server refuses
  await items.send(failing.id, call).catch(() => {});
  const f = (snap.actionItems as { id: string; status: string; send?: { error?: string } }[]).find((i) => i.id === failing.id)!;
  check("a failed send stays open with the error and a warning", f.status === "open" && /may or may not have gone out/.test(f.send?.error ?? ""), JSON.stringify(f));
}

removeConnection("crm");
check("removing it drops the connection and its key", listConnections().length === 0 && (await rejects(callConnection("crm", "search_contacts", {}, { roleId: "sales" }), /No connection/)));

http.close();
console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
