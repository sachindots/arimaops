// 127.0.0.1 by default (--host to expose, e.g. for Tailscale). Routes:
//   GET  /ws?token=…            browser WebSocket (browser/viewer token, or the hq_sid device cookie)
//   POST /api/login             link token → hq_sid device cookie (survives HQ restarts)
//   POST /hook/<agent>/<event>  Claude Code hooks (that agent's own token)
//   GET  /api/health
//   GET  /*                     the built UI (dist/), when present

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
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
import { agentTokenFor } from "./paths";
import { RISKY_COMMANDS, type RemoteGuard, type Role } from "./remote";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".json": "application/json",
};

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookie(req: IncomingMessage, name: string): string {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

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

  const agentAuth = (auth: string, agentId: string) => !!agentId && safeEqual(auth, `Bearer ${agentTokenFor(o.agentToken, agentId)}`);

  const okOrigin = (req: IncomingMessage) => {
    const origin = req.headers.origin ?? "";
    const host = req.headers.host ?? "";
    return !origin || o.allowedOrigins.includes(origin) || (o.sameOrigin && (origin === `https://${host}` || origin === `http://${host}`));
  };

  /** Local = this machine's own browser: loopback socket, not via a proxy (tailscale serve, tunnel), and a local Origin.
   *  No Origin (a script) or anything else is remote, so it can't skip TOTP step-up by leaving the header out. */
  const isRemote = (req: IncomingMessage) => {
    const origin = req.headers.origin ?? "";
    const proxied = !!(req.headers["x-forwarded-for"] || req.headers["tailscale-user-login"] || req.headers["cf-connecting-ip"]);
    return !(LOOPBACK.has(req.socket.remoteAddress ?? "") && !proxied && o.localOrigins.includes(origin));
  };

  /** Token (link or bearer) first, then the device cookie. */
  const whoIs = (req: IncomingMessage, tok: string): { role: Role; deviceId: string } | null => {
    if (tok && safeEqual(tok, o.browserToken)) return { role: "operator", deviceId: "" };
    if (tok && safeEqual(tok, o.viewerToken)) return { role: "viewer", deviceId: "" };
    const d = o.guard.device(cookie(req, "hq_sid"));
    return d ? { role: d.role, deviceId: d.id } : null;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "POST" && url.pathname === "/api/login") {
      if (!okOrigin(req)) return send(res, 403, "bad origin");
      try {
        const { token } = JSON.parse((await readBody(req, 4096)) || "{}") as { token?: string };
        const tok = String(token ?? "");
        const role: Role | null = tok && safeEqual(tok, o.browserToken) ? "operator" : tok && safeEqual(tok, o.viewerToken) ? "viewer" : null;
        if (!role) return send(res, 401, JSON.stringify({ error: "invalid link" }), "application/json");
        const id = o.guard.addDevice(role, String(req.headers["user-agent"] ?? ""));
        const https = req.headers["x-forwarded-proto"] === "https" || (req.headers.origin ?? "").startsWith("https://");
        res.setHeader("Set-Cookie", `hq_sid=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${o.guard.cookieMaxAge}${https ? "; Secure" : ""}`);
        o.guard.audit({ role, origin: req.headers.origin ?? "", remote: isRemote(req), cmd: "login", args: [], result: "ok" });
        return send(res, 200, JSON.stringify({ role }), "application/json");
      } catch {
        return send(res, 400, "bad request");
      }
    }

    if (req.method === "POST" && url.pathname.startsWith("/hook/")) {
      const [, , rawAgent, event] = url.pathname.split("/");
      const agentId = decodeURIComponent(rawAgent ?? "");
      if (!agentAuth(req.headers.authorization ?? "", agentId)) return send(res, 401, "unauthorized");
      try {
        const body = await readBody(req);
        const r = handleHook(o.hub, o.inbox, agentId, event ?? "", body ? JSON.parse(body) : {});
        if (!r.ok) return send(res, 404, "");
        if (r.response) return send(res, 200, JSON.stringify(r.response), "application/json");
        res.writeHead(204);
        return void res.end();
      } catch {
        return send(res, 400, "bad request");
      }
    }

    // Team MCP: the agent's own token + its id (written into its MCP config by HQ).
    if (url.pathname === "/mcp") {
      const qToken = url.searchParams.get("token");
      const auth = req.headers.authorization ?? (qToken ? `Bearer ${qToken}` : "");
      const agentId = String(req.headers["x-hq-agent"] || url.searchParams.get("agent") || "");
      if (!agentAuth(auth, agentId) || !o.hub.cfg(agentId)) return send(res, 401, "unauthorized");
      if (req.method === "GET" || req.method === "DELETE") return send(res, 405, "stateless server");
      try {
        const raw = await readBody(req, 1024 * 1024);
        return await handleMcp(o.hub, o.planner, agentId, req, res, raw ? JSON.parse(raw) : undefined);
      } catch {
        return res.headersSent ? void res.end() : send(res, 400, "bad request");
      }
    }

    if (url.pathname === "/api/health") return send(res, 200, JSON.stringify({ ok: true }), "application/json");

    // Multi-Project CTO Overwatch REST API: the UI only (browser/viewer token or device cookie), never agents.
    // Writes register folders and change other projects, so they count as risky: remote callers need a step-up'd device.
    if (url.pathname.startsWith("/api/projects")) {
      const qToken = url.searchParams.get("token") ?? "";
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
      const who = whoIs(req, bearer || qToken);
      const operator = who?.role === "operator";
      const viewer = who?.role === "viewer";
      if (viewer && req.method !== "GET") return send(res, 403, JSON.stringify({ error: "viewer token is read-only" }), "application/json");
      if (!operator && !viewer) return send(res, 401, JSON.stringify({ error: "unauthorized" }), "application/json");
      if (req.method !== "GET" && !okOrigin(req)) return send(res, 403, JSON.stringify({ error: "bad origin" }), "application/json");
      if (req.method !== "GET" && isRemote(req) && !(who?.deviceId && Date.now() < o.guard.deviceElevatedUntil(who.deviceId)))
        return send(res, 403, JSON.stringify({ error: "step-up required: enter your authenticator code in HQ first" }), "application/json");

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
      if (!file.startsWith(o.distDir + sep) || !existsSync(file) || statSync(file).isDirectory()) file = join(o.distDir, "index.html");
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
    // Token or device cookie + origin: another website in your browser can't drive HQ.
    const who = whoIs(req, url.searchParams.get("token") ?? "");
    if (url.pathname !== "/ws" || !who || !okOrigin(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }
    const remote = isRemote(req);
    log.info(`ui connected: ${who.role}${remote ? " (remote)" : ""}${origin ? ` from ${origin}` : ""}`);
    wss.handleUpgrade(req, socket, head, (ws) => onClient(ws, who.role, who.deviceId, origin, remote));
  });

  function onClient(ws: WebSocket, role: Role, deviceId: string, origin: string, remote: boolean) {
    // A device that entered a code today stays elevated (24 h); a bare-token connection only until it closes.
    let elevatedUntil = deviceId ? o.guard.deviceElevatedUntil(deviceId) : 0;
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
          if (deviceId) o.guard.elevateDevice(deviceId, elevatedUntil);
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
        if (remote && RISKY_COMMANDS.has(cmd) && Date.now() > Math.max(elevatedUntil, deviceId ? o.guard.deviceElevatedUntil(deviceId) : 0)) {
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
