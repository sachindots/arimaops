// 127.0.0.1 by default (--host to expose, e.g. for Tailscale). Routes:
//   GET  /ws?token=…            browser WebSocket (browser token)
//   POST /hook/<agent>/<event>  Claude Code hooks (agent token)
//   GET  /api/health
//   GET  /*                     the built UI (dist/), when present

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { OfficeEvent } from "../src/data/source";
import { handleHook } from "./hooks";
import type { Hub } from "./hub";
import type { Inbox } from "./inbox";
import { handleMcp } from "./mcp";
import type { Planner } from "./planner";
import { createCrossProjectTask, listProjectsOverview, registerProjectPath, updateCrossProjectTask } from "./projectsRegistry";
import { log } from "./lib/log";
import { RISKY_COMMANDS, type RemoteGuard } from "./remote";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".json": "application/json",
};

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Commands a viewer token may send. Everything else needs the operator token. */
const VIEWER_COMMANDS = new Set(["sendMessage", "recheckSetup", "refreshSbx", "refreshMcp"]);

function readBody(req: IncomingMessage, limit = 256 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) reject(new Error("too large"));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

interface Options {
  hub: Hub;
  inbox: Inbox;
  planner: Planner;
  port: number;
  browserToken: string;
  /** Read-only + chat token for tablets/phones. Can't run shells, change settings or approve. */
  viewerToken: string;
  agentToken: string;
  host: string;
  /** Remote mode: also accept the page's own origin (Tailscale / tunnel / LAN), token still required. */
  sameOrigin: boolean;
  /** Origins that count as "this machine". Anything else is remote and needs TOTP step-up for risky commands. */
  localOrigins: string[];
  guard: RemoteGuard;
  distDir: string | null;
  allowedOrigins: string[];
  commands: Record<string, (...args: unknown[]) => unknown>;
}

export function startHttp(o: Options) {
  const send = (res: ServerResponse, code: number, body: string, type = "text/plain") => {
    res.writeHead(code, { "Content-Type": type });
    res.end(body);
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "POST" && url.pathname.startsWith("/hook/")) {
      const auth = req.headers.authorization ?? "";
      if (!safeEqual(auth, `Bearer ${o.agentToken}`)) return send(res, 401, "unauthorized");
      const [, , agentId, event] = url.pathname.split("/");
      try {
        const body = await readBody(req);
        const r = handleHook(o.hub, o.inbox, decodeURIComponent(agentId ?? ""), event ?? "", body ? JSON.parse(body) : {});
        if (!r.ok) return send(res, 404, "");
        if (r.response) return send(res, 200, JSON.stringify(r.response), "application/json");
        res.writeHead(204);
        return void res.end();
      } catch {
        return send(res, 400, "bad request");
      }
    }

    // Team MCP: agent token + the agent's id (written into its MCP config by HQ).
    if (url.pathname === "/mcp") {
      const qToken = url.searchParams.get("token");
      const auth = req.headers.authorization ?? (qToken ? `Bearer ${qToken}` : "");
      const agentId = String(req.headers["x-hq-agent"] || url.searchParams.get("agent") || "");
      if (!safeEqual(auth, `Bearer ${o.agentToken}`) || !o.hub.cfg(agentId)) return send(res, 401, "unauthorized");
      if (req.method === "GET" || req.method === "DELETE") return send(res, 405, "stateless server");
      try {
        const raw = await readBody(req, 1024 * 1024);
        return await handleMcp(o.hub, o.planner, agentId, req, res, raw ? JSON.parse(raw) : undefined);
      } catch {
        return res.headersSent ? void res.end() : send(res, 400, "bad request");
      }
    }

    if (url.pathname === "/api/health") return send(res, 200, JSON.stringify({ ok: true }), "application/json");

    // Multi-Project CTO Overwatch REST API (authenticated via browser token or agent token)
    if (url.pathname.startsWith("/api/projects")) {
      const qToken = url.searchParams.get("token") ?? "";
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
      const tok = bearer || qToken;
      const operator = safeEqual(tok, o.browserToken) || safeEqual(tok, o.agentToken);
      const viewer = !operator && safeEqual(tok, o.viewerToken);
      if (viewer && req.method !== "GET") return send(res, 403, JSON.stringify({ error: "viewer token is read-only" }), "application/json");
      if (!operator && !viewer) return send(res, 401, JSON.stringify({ error: "unauthorized" }), "application/json");

      try {
        if (req.method === "GET" && url.pathname === "/api/projects") {
          return send(res, 200, JSON.stringify({ projects: listProjectsOverview(o.hub) }), "application/json");
        }
        if (req.method === "POST" && url.pathname === "/api/projects/register") {
          const body = JSON.parse((await readBody(req)) || "{}") as { path?: string };
          if (!body.path) return send(res, 400, JSON.stringify({ error: "path required" }), "application/json");
          const project = registerProjectPath(body.path, o.hub);
          return send(res, 200, JSON.stringify({ project, projects: listProjectsOverview(o.hub) }), "application/json");
        }
        const parts = url.pathname.split("/").filter(Boolean); // ["api", "projects", projectId, "tasks", taskId?]
        if (parts.length === 4 && parts[3] === "tasks" && req.method === "POST") {
          const projectId = decodeURIComponent(parts[2]);
          const body = JSON.parse((await readBody(req)) || "{}") as {
            title?: string;
            boardId?: string;
            description?: string;
            doneWhen?: string;
            ownerId?: string;
          };
          if (!body.title?.trim()) return send(res, 400, JSON.stringify({ error: "title required" }), "application/json");
          const task = createCrossProjectTask(
            projectId,
            {
              title: body.title,
              boardId: body.boardId,
              description: body.description,
              doneWhen: body.doneWhen,
              ownerId: body.ownerId,
            },
            o.hub,
            o.planner,
          );
          return send(res, 200, JSON.stringify({ task, projects: listProjectsOverview(o.hub) }), "application/json");
        }
        if (parts.length === 5 && parts[3] === "tasks" && (req.method === "PATCH" || req.method === "POST")) {
          const projectId = decodeURIComponent(parts[2]);
          const taskId = decodeURIComponent(parts[4]);
          const body = JSON.parse((await readBody(req)) || "{}");
          const task = updateCrossProjectTask(projectId, taskId, body, o.hub, o.planner);
          return send(res, 200, JSON.stringify({ task, projects: listProjectsOverview(o.hub) }), "application/json");
        }
      } catch (err) {
        return send(res, 400, JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), "application/json");
      }
    }

    if ((req.method === "GET" || req.method === "HEAD") && o.distDir) {
      const rel = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
      let file = join(o.distDir, rel);
      if (!file.startsWith(o.distDir) || !existsSync(file) || statSync(file).isDirectory()) file = join(o.distDir, "index.html");
      res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
      if (req.method === "HEAD") return void res.end();
      return void createReadStream(file).pipe(res);
    }
    send(res, 404, "not found");
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const origin = req.headers.origin ?? "";
    const token = url.searchParams.get("token") ?? "";
    // Token + origin: another website in your browser can't drive HQ.
    const role = safeEqual(token, o.browserToken) ? "operator" : safeEqual(token, o.viewerToken) ? "viewer" : null;
    const host = req.headers.host ?? "";
    const okOrigin = !origin || o.allowedOrigins.includes(origin) || (o.sameOrigin && (origin === `https://${host}` || origin === `http://${host}`));
    if (url.pathname !== "/ws" || !role || !okOrigin) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }
    log.info(`ui connected: ${role}${origin ? ` from ${origin}` : ""}`);
    const remote = !!origin && !o.localOrigins.includes(origin);
    wss.handleUpgrade(req, socket, head, (ws) => onClient(ws, role, origin, remote));
  });

  function onClient(ws: WebSocket, role: "operator" | "viewer", origin: string, remote: boolean) {
    let elevatedUntil = 0;
    const sendEvent = (e: OfficeEvent) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(e));
    sendEvent({ type: "snapshot", snapshot: o.hub.snap });
    const unsub = o.hub.subscribe(sendEvent);
    ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { cmd?: string; args?: unknown[] };
        const cmd = String(msg.cmd ?? "");
        const args = Array.isArray(msg.args) ? msg.args : [];
        const audit = (result: Parameters<RemoteGuard["audit"]>[0]["result"], c = cmd, a: unknown[] = args) =>
          o.guard.audit({ role, origin, remote, cmd: c, args: a, result });

        // Step-up: { cmd: "elevate", args: [code, pendingCmd?, pendingArgs?] }
        if (cmd === "elevate") {
          if (role !== "operator") return audit("blocked");
          if (!o.guard.verify(String(args[0] ?? ""))) {
            audit("bad-code", "elevate", []);
            return sendEvent({ type: "remote.stepup", status: "denied" });
          }
          elevatedUntil = o.guard.stepUpUntil();
          audit("elevated", "elevate", []);
          sendEvent({ type: "remote.stepup", status: "ok", until: elevatedUntil });
          const pending = typeof args[1] === "string" ? args[1] : "";
          if (!pending || !o.commands[pending]) return;
          const pArgs = Array.isArray(args[2]) ? args[2] : [];
          await o.commands[pending](...pArgs);
          return audit("ok", pending, pArgs);
        }

        const fn = cmd ? o.commands[cmd] : undefined;
        if (!fn) return log.warn("unknown command", cmd);
        if (role === "viewer" && !VIEWER_COMMANDS.has(cmd)) {
          audit("blocked");
          return log.warn("viewer blocked:", cmd);
        }
        if (remote && RISKY_COMMANDS.has(cmd) && Date.now() > elevatedUntil) {
          audit("step-up-required");
          return sendEvent({ type: "remote.stepup", status: "required", cmd, args });
        }
        try {
          await fn(...args);
          audit("ok");
        } catch (err) {
          audit("error");
          throw err;
        }
      } catch (err) {
        log.warn("command failed:", err instanceof Error ? err.message : err);
      }
    });
    ws.on("close", () => unsub());
  }

  return new Promise<typeof server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host, () => resolve(server));
  });
}
