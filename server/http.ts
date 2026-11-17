// 127.0.0.1 by default (--host to expose, e.g. for Tailscale). Routes:
//   GET  /ws?project=…&token=…  browser WebSocket for one project (browser/viewer token, or the hq_sid device cookie)
//   POST /api/login             link token → hq_sid device cookie (survives HQ restarts)
//   POST /hook/<agent>/<event>  Claude Code hooks (that agent's own token; the token tells which project)
//   GET  /api/health
//   GET  /*                     the built UI (dist/), when present

import { ownerSeen } from "./presence";
import { githubAppState, handleWebhook, WEBHOOK_PATH } from "./githubApp";
import { createReadStream, existsSync, statSync } from "node:fs";
import { redactor } from "./credentials/registry";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { createGzip } from "node:zlib";
import { WebSocketServer, type WebSocket } from "ws";
import type { OfficeEvent } from "../src/data/source";
import { handleHook } from "./hooks";
import { handleMcp } from "./mcp";
import type { Runtime } from "./project";
import { handleProjectsApi } from "./projectsApi";
import { log } from "./lib/log";
import { agentTokenFor } from "./paths";
import { canOperate, type RemoteGuard, type Role } from "./remote";
import { authorize } from "./commandPolicy";
import { Throttle, Users } from "./users";
import { homedir } from "node:os";
import { BRAND } from "../src/data/brand";
import { PushDevices, pushRegistrationBody } from "./push";
import { z } from "zod";
import { accountModels } from "./models";
import { isAgentCli } from "../src/data/types";

const passwordChange = z.object({ currentPassword: z.string().max(200), newPassword: z.string().min(10).max(200) });

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json",
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

// The app page: only its own scripts, and it talks only to this server. Inline styles stay (the body's, React's).
const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Commands a viewer token may send. Everything else needs the operator token. */

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
  /** Every loaded project, by slug. */
  projects: Map<string, Runtime>;
  /** Project a browser gets when it doesn't ask for one. */
  defaultProject: () => string;
  /** Loads a newly registered project into the server. */
  loadProject: (path: string) => Promise<void>;
  /** Stops a project's agents and unloads it (archive). */
  unloadProject: (slug: string) => Promise<void>;
  port: number;
  browserToken: string;
  /** Read-only + chat token for tablets/phones. Can't run shells, change settings or approve. */
  viewerToken: string;
  host: string;
  /** Also listen here (e.g. the container network's gateway, so Container-mode agents reach hooks and the Team MCP). */
  extraHosts?: string[];
  /** Remote mode: also accept the page's own origin (Tailscale / tunnel / LAN), token still required. */
  sameOrigin: boolean;
  /** Origins that count as "this machine". Anything else is remote and needs TOTP step-up for risky commands. */
  localOrigins: string[];
  guard: RemoteGuard;
  /** People who can sign in (default: ~/.arima/users.json). */
  users?: Users;
  push?: PushDevices;
  distDir: string | null;
  allowedOrigins: string[];
}

/** Who is calling: a role, the device cookie (if any) and the signed-in person (if any). */
interface Who {
  role: Role;
  deviceId: string;
  userId?: string;
  userName?: string;
}

/** Only the owner manages accounts (API keys), the memory database and the machine-wide proxy. */

export function startHttp(o: Options) {
  const users = o.users ?? new Users(join(homedir(), BRAND.homeDir, "users.json"));
  const push = o.push ?? new PushDevices((deviceId, userId) => {
    const device = o.guard.device(deviceId, false);
    const user = users.active(userId);
    return device?.userId === userId && user ? user.role : null;
  });
  const pushSubscriptions = new Map<Runtime, () => void>();
  const refreshPush = () => {
    const live = new Set(o.projects.values());
    for (const [rt, stop] of pushSubscriptions) if (!live.has(rt)) { stop(); pushSubscriptions.delete(rt); }
    for (const rt of live) if (!pushSubscriptions.has(rt)) pushSubscriptions.set(rt, push.watch(rt.hub));
  };
  refreshPush();
  const throttle = new Throttle();
  const send = (res: ServerResponse, code: number, body: string, type = "text/plain") => {
    res.writeHead(code, { "Content-Type": type });
    res.end(body);
  };

  /** The project whose secret signed this agent's token (agent ids repeat across projects; tokens don't). */
  const agentProject = (auth: string, agentId: string): Runtime | null => {
    if (!agentId) return null;
    for (const rt of o.projects.values()) if (rt.hub.cfg(agentId) && safeEqual(auth, `Bearer ${agentTokenFor(rt.agentSecret, agentId)}`)) return rt;
    return null;
  };

  const okOrigin = (req: IncomingMessage) => {
    const origin = req.headers.origin ?? "";
    const host = req.headers.host ?? "";
    return !origin || o.allowedOrigins.includes(origin) || (o.sameOrigin && (origin === `https://${host}` || origin === `http://${host}`));
  };

  /** Local = this machine's own browser: loopback socket, not via a proxy (tailscale serve, tunnel), and a local Origin.
   *  No Origin (a script) or anything else is remote, so it can't skip TOTP step-up by leaving the header out. */
  const isRemote = (req: IncomingMessage) => {
    // Browsers send no Origin on same-origin GETs: for a read, the Host it asked for must be a local address instead.
    // A write with no Origin (a script) still counts as remote.
    const read = (req.method === "GET" || req.method === "HEAD") && !req.headers.upgrade; // browsers always send Origin on a WebSocket
    const origin = req.headers.origin ?? (read && req.headers.host ? `http://${req.headers.host}` : "");
    const proxied = !!(req.headers["x-forwarded-for"] || req.headers["tailscale-user-login"] || req.headers["cf-connecting-ip"]);
    return !(LOOPBACK.has(req.socket.remoteAddress ?? "") && !proxied && o.localOrigins.includes(origin));
  };

  /**
   * Token (link or bearer) first, then the device cookie. The role is read from the person on every call, so a
   * changed role, a disabled person or a removed one takes effect at once. Before anyone has signed up, the start-up
   * link is the owner; after, it works only on this machine (as the first owner) and remote devices sign in by name.
   */
  const whoIs = (req: IncomingMessage, tok: string): Who | null => {
    const owner = users.firstOwner();
    const asOwner = (deviceId: string): Who | null => (!isRemote(req) && owner ? { role: owner.role, deviceId, userId: owner.id, userName: owner.name } : null);
    if (tok && safeEqual(tok, o.browserToken)) return users.count() ? asOwner("") : { role: "owner", deviceId: "" };
    if (tok && safeEqual(tok, o.viewerToken)) return { role: "viewer", deviceId: "" };
    const d = o.guard.device(cookie(req, "hq_sid"));
    if (!d) return null;
    if (d.userId) {
      const u = users.active(d.userId);
      return u ? { role: u.role, deviceId: d.id, userId: u.id, userName: u.name } : null;
    }
    // A token-link device: the owner while nobody has signed up; after that, local only.
    if (!users.count()) return { role: d.role === "operator" ? "owner" : d.role, deviceId: d.id };
    return d.role === "viewer" ? { role: "viewer", deviceId: d.id } : asOwner(d.id);
  };

  const json = (res: ServerResponse, code: number, body: unknown) => send(res, code, JSON.stringify(body), "application/json");
  // X-Forwarded-For counts only from a proxy on this machine (tailscale serve, a tunnel); anyone else could forge it.
  const clientIp = (req: IncomingMessage) =>
    (LOOPBACK.has(req.socket.remoteAddress ?? "") && String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim()) || req.socket.remoteAddress || "?";
  const setCookie = (req: IncomingMessage, res: ServerResponse, id: string, maxAge: number) => {
    const https = req.headers["x-forwarded-proto"] === "https" || (req.headers.origin ?? "").startsWith("https://");
    res.setHeader("Set-Cookie", `hq_sid=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${https ? "; Secure" : ""}`);
  };

  let deliveryEmitAt = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    // GitHub App webhooks: the one path Tailscale Funnel makes public. No cookie or origin, only GitHub's signature.
    if (url.pathname === WEBHOOK_PATH) {
      if (req.method !== "POST") return send(res, 405, "POST only");
      let body: string;
      try {
        body = await readBody(req, 5 * 1024 * 1024);
      } catch {
        return send(res, 413, "too large");
      }
      const code = handleWebhook(req.headers, body);
      if (code === 202 && Date.now() - deliveryEmitAt > 60_000) {
        deliveryEmitAt = Date.now();
        const state = githubAppState();
        for (const rt of o.projects.values()) {
          rt.hub.snap.githubApp = state;
          rt.hub.emit({ type: "githubApp.updated", githubApp: state });
        }
      }
      if (code === 401) log.warn(`github webhook: bad signature from ${clientIp(req)}`);
      return send(res, code, code === 202 ? "ok" : code === 401 ? "bad signature" : code === 503 ? "no GitHub App here" : "");
    }

    // The manifest flow's way back: GitHub sends the owner's browser here with a one-time code. The cookie isn't sent
    // on that cross-site hop, so this only hands the code to the page, where the owner's own session finishes it.
    if (req.method === "GET" && url.pathname === "/api/github/app/callback") {
      const code = url.searchParams.get("code") ?? "";
      const state = url.searchParams.get("state") ?? "";
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(code) || !/^[A-Za-z0-9_-]{0,100}$/.test(state)) return send(res, 400, "bad code");
      res.writeHead(302, { Location: `/?${new URLSearchParams({ github_code: code, github_state: state })}` });
      return res.end();
    }

    if (req.method === "POST" && url.pathname === "/api/login") {
      if (!okOrigin(req)) return send(res, 403, "bad origin");
      try {
        const { token } = JSON.parse((await readBody(req, 4096)) || "{}") as { token?: string };
        const tok = String(token ?? "");
        const who = tok ? whoIs(req, tok) : null;
        if (!who) return json(res, 401, { error: users.count() ? "Sign in with your name and password." : "invalid link" });
        const id = o.guard.addDevice(who.role, String(req.headers["user-agent"] ?? ""), who.userId);
        setCookie(req, res, id, o.guard.cookieMaxAge);
        o.guard.audit({ role: who.role, user: who.userName, origin: req.headers.origin ?? "", remote: isRemote(req), cmd: "login", args: [], result: "ok" });
        return json(res, 200, { role: who.role });
      } catch {
        return send(res, 400, "bad request");
      }
    }

    // ---------------------------------------------------------------- people: sign-in, sign-out, who am I
    if (url.pathname.startsWith("/api/auth/")) {
      const origin = req.headers.origin ?? "";
      if (req.method === "POST" && url.pathname === "/api/auth/login") {
        if (!okOrigin(req)) return send(res, 403, "bad origin");
        let body: { name?: unknown; password?: unknown };
        try {
          body = JSON.parse((await readBody(req, 4096)) || "{}");
        } catch {
          return send(res, 400, "bad request");
        }
        const keys = [`ip:${clientIp(req)}`, `name:${String(body.name ?? "").trim().toLowerCase()}`];
        if (keys.some((k) => throttle.blocked(k))) {
          o.guard.audit({ role: "-", user: String(body.name ?? "").slice(0, 40), origin, remote: isRemote(req), cmd: "signin", args: [], result: "throttled" });
          return json(res, 429, { error: "Too many wrong tries. Wait 15 minutes." });
        }
        const u = users.verify(body.name, body.password);
        if (!u) {
          keys.forEach((k) => throttle.fail(k));
          o.guard.audit({ role: "-", user: String(body.name ?? "").slice(0, 40), origin, remote: isRemote(req), cmd: "signin", args: [], result: "bad-password" });
          return json(res, 401, { error: "Wrong name or password." });
        }
        keys.forEach((k) => throttle.clear(k));
        const id = o.guard.addDevice(u.role, String(req.headers["user-agent"] ?? ""), u.id);
        setCookie(req, res, id, o.guard.cookieMaxAge);
        o.guard.audit({ role: u.role, user: u.name, origin, remote: isRemote(req), cmd: "signin", args: [], result: "ok" });
        return json(res, 200, { role: u.role, name: u.name });
      }
      if (req.method === "POST" && url.pathname === "/api/auth/logout") {
        if (!okOrigin(req)) return send(res, 403, "bad origin");
        const id = cookie(req, "hq_sid");
        if (id) {
          o.guard.removeDevice(id);
          try { push.remove(id); } catch { log.warn("Could not remove push registration for the signed-out device."); }
        }
        setCookie(req, res, "", 0);
        return json(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/api/auth/me") {
        const who = whoIs(req, url.searchParams.get("token") ?? "");
        if (!who) return json(res, 401, { error: "Sign in.", people: users.count() });
        return json(res, 200, { role: who.role, user: who.userId ? { id: who.userId, name: who.userName } : null, people: users.count() });
      }
      if (req.method === "POST" && url.pathname === "/api/auth/password") {
        if (!okOrigin(req)) return send(res, 403, "bad origin");
        const who = whoIs(req, "");
        if (!who?.userId || !who.deviceId) return json(res, 401, { error: "Sign in with your HQ account first." });
        const key = `password:${who.userId}:${clientIp(req)}`;
        if (throttle.blocked(key)) return json(res, 429, { error: "Too many wrong tries. Wait 15 minutes." });
        try {
          const parsed = passwordChange.safeParse(JSON.parse(await readBody(req, 8192)));
          if (!parsed.success) return json(res, 400, { error: "Enter your current password and a new password of 10 to 200 characters." });
          if (!users.verify(who.userName, parsed.data.currentPassword)) {
            throttle.fail(key);
            o.guard.audit({ role: who.role, user: who.userName, origin, remote: isRemote(req), cmd: "password.change", args: [], result: "bad-password" });
            return json(res, 403, { error: "Your current password is incorrect." });
          }
          users.update(who.userId, { password: parsed.data.newPassword });
          o.guard.revokeUserDevices(who.userId);
          const id = o.guard.addDevice(who.role, String(req.headers["user-agent"] ?? ""), who.userId);
          setCookie(req, res, id, o.guard.cookieMaxAge);
          throttle.clear(key);
          o.guard.audit({ role: who.role, user: who.userName, origin, remote: isRemote(req), cmd: "password.change", args: [], result: "ok" });
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 400, { error: error instanceof Error && error.message.startsWith("Passwords need") ? error.message : "Could not change your password. Use 10 to 200 characters." });
        }
      }
      return send(res, 404, "not found");
    }

    if (url.pathname === "/api/push/register") {
      if (!okOrigin(req) || !req.headers.origin) return send(res, 403, "bad origin");
      const who = whoIs(req, "");
      if (!who?.userId || !who.deviceId) return json(res, 401, { error: "Sign in with your HQ account first." });
      if (req.method === "DELETE") {
        push.remove(who.deviceId);
        return json(res, 200, { ok: true });
      }
      if (req.method !== "POST") return send(res, 405, "method not allowed");
      try {
        const body = pushRegistrationBody.safeParse(JSON.parse(await readBody(req, 8192)));
        if (!body.success) return json(res, 400, { error: "Invalid push registration token." });
        push.register({ deviceId: who.deviceId, userId: who.userId, token: body.data.token, server: req.headers.origin });
        return json(res, 200, { ok: true });
      } catch {
        return json(res, 400, { error: "Could not save push registration." });
      }
    }

    // ---------------------------------------------------------------- people: the owner's Users page
    if (url.pathname === "/api/users" || url.pathname.startsWith("/api/users/")) {
      const who = whoIs(req, url.searchParams.get("token") ?? "");
      if (!who) return json(res, 401, { error: "Sign in." });
      if (who.role !== "owner") return json(res, 403, { error: "Only the owner manages people." });
      if (req.method !== "GET") {
        if (!okOrigin(req)) return send(res, 403, "bad origin");
        if (isRemote(req) && !(who.deviceId && Date.now() < o.guard.deviceElevatedUntil(who.deviceId)))
          return json(res, 403, { error: "From another device, enter your authenticator code in HQ first (any risky action asks for it)." });
      }
      const audit = (cmd: string, args: unknown[], result: "ok" | "error") =>
        o.guard.audit({ role: who.role, user: who.userName, origin: req.headers.origin ?? "", remote: isRemote(req), cmd, args, result });
      try {
        if (req.method === "GET" && url.pathname === "/api/users") return json(res, 200, { users: users.views(), me: who.userId ?? null });
        const body = req.method === "DELETE" ? {} : (JSON.parse((await readBody(req, 8192)) || "{}") as Record<string, unknown>);
        if (req.method === "POST" && url.pathname === "/api/users") {
          const first = users.count() === 0;
          const made = users.create({ name: body.name, role: first ? "owner" : body.role, password: body.password });
          // The first owner was created from a token-link device: that device is now theirs.
          if (first && who.deviceId) o.guard.bindDevice(who.deviceId, made.user.id);
          audit("users.create", [made.user.name, made.user.role], "ok");
          return json(res, 200, made);
        }
        const id = decodeURIComponent(url.pathname.slice("/api/users/".length));
        if (req.method === "PATCH") {
          const out = users.update(id, body);
          audit("users.update", [id, ...Object.keys(body).filter((k) => k !== "password"), ...(body.password ? ["password"] : [])], "ok");
          return json(res, 200, out);
        }
        if (req.method === "DELETE") {
          users.remove(id);
          audit("users.remove", [id], "ok");
          return json(res, 200, { ok: true });
        }
        return send(res, 404, "not found");
      } catch (e) {
        audit(`users.${req.method?.toLowerCase()}`, [], "error");
        return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
    }

    if (req.method === "POST" && url.pathname.startsWith("/hook/")) {
      const [, , rawAgent, event] = url.pathname.split("/");
      const agentId = decodeURIComponent(rawAgent ?? "");
      const rt = agentProject(req.headers.authorization ?? "", agentId);
      if (!rt) return send(res, 401, "unauthorized");
      try {
        const body = await readBody(req);
        const payload = body ? JSON.parse(body) : {};
        const r = handleHook(rt.hub, rt.inbox, agentId, event ?? "", payload);
        if (event === "PostToolUse" || event === "PostToolUseFailure" || event === "AfterTool") rt.onToolDone(agentId, event, payload);
        if (!r.ok) return send(res, 404, "");
        if (r.response) return send(res, 200, JSON.stringify(r.response), "application/json");
        res.writeHead(204);
        return void res.end();
      } catch {
        return send(res, 400, "bad request");
      }
    }

    // A stream-engine agent's runner (docs/design/stream-json.md): its next message, and Claude's events. Same token as hooks.
    if (url.pathname.startsWith("/agent/")) {
      const [, , rawAgent, what] = url.pathname.split("/");
      const agentId = decodeURIComponent(rawAgent ?? "");
      const rt = agentProject(req.headers.authorization ?? "", agentId);
      if (!rt) return send(res, 401, "unauthorized");
      try {
        if (req.method === "GET" && what === "next") {
          const gone = new AbortController();
          res.on("close", () => gone.abort());
          const item = await rt.stream.next(agentId, Math.max(0, Number(url.searchParams.get("ack")) || 0), 25_000, gone.signal);
          if (!item) return void res.writeHead(204).end();
          return send(res, 200, JSON.stringify(item), "application/json");
        }
        if (req.method === "POST" && what === "events") {
          rt.stream.events(agentId, JSON.parse((await readBody(req, 1024 * 1024)) || "[]"));
          return void res.writeHead(204).end();
        }
        return send(res, 404, "");
      } catch {
        return res.headersSent ? void res.end() : send(res, 400, "bad request");
      }
    }

    // Team MCP: the agent's own token + its id (written into its MCP config by HQ).
    if (url.pathname === "/mcp") {
      const qToken = url.searchParams.get("token");
      const auth = req.headers.authorization ?? (qToken ? `Bearer ${qToken}` : "");
      const agentId = String(req.headers["x-hq-agent"] || url.searchParams.get("agent") || "");
      const rt = agentProject(auth, agentId);
      if (!rt) return send(res, 401, "unauthorized");
      if (req.method === "GET" || req.method === "DELETE") return send(res, 405, "stateless server");
      try {
        const raw = await readBody(req, 1024 * 1024);
        return await handleMcp(rt.hub, rt.planner, agentId, req, res, raw ? JSON.parse(raw) : undefined);
      } catch {
        return res.headersSent ? void res.end() : send(res, 400, "bad request");
      }
    }

    if (req.method === "GET" && url.pathname === "/api/models/account") {
      if (!whoIs(req, url.searchParams.get("token") ?? "") || !okOrigin(req)) return send(res, 401, "not signed in");
      const cli = url.searchParams.get("cli");
      if (!isAgentCli(cli)) return send(res, 400, "unknown CLI");
      try { return send(res, 200, JSON.stringify({ models: await accountModels(url.searchParams.get("account") ?? "", cli) }), "application/json"); }
      catch (e) { return send(res, 503, JSON.stringify({ error: e instanceof Error ? e.message : "Catalog unavailable" }), "application/json"); }
    }
    if (url.pathname === "/api/health") return send(res, 200, JSON.stringify({ ok: true }), "application/json");

    // Multi-Project CTO Overwatch REST API: the UI only (browser/viewer token or device cookie), never agents.
    // Writes register folders and change other projects, so they count as risky: remote callers need a step-up'd device.
    if (url.pathname.startsWith("/api/projects")) {
      const qToken = url.searchParams.get("token") ?? "";
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
      const who = whoIs(req, bearer || qToken);
      const elevated = !!(who?.deviceId && Date.now() < o.guard.deviceElevatedUntil(who.deviceId));
      return await handleProjectsApi(req, res, url, {
        who,
        okOrigin: okOrigin(req),
        remote: isRemote(req),
        elevated,
        projects: o.projects,
        loadProject: o.loadProject,
        unloadProject: o.unloadProject,
        refreshPush,
        closeSockets: (rt) => { for (const ws of sockets.get(rt) ?? []) ws.close(4004, "project archived"); },
        readBody,
      });
    }

    if ((req.method === "GET" || req.method === "HEAD") && o.distDir) {
      const rel = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
      let file = join(o.distDir, rel);
      if (!file.startsWith(o.distDir + sep) || !existsSync(file) || statSync(file).isDirectory()) file = join(o.distDir, "index.html");
      const type = MIME[extname(file)] ?? "application/octet-stream";
      // Text assets gzipped (a phone on Wi-Fi loads ~4× less); hashed assets cached, the page itself never.
      const gzip = /text|javascript|json|svg|manifest/.test(type) && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
      const cache = file.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache";
      res.writeHead(200, { "Content-Type": type, "Cache-Control": cache, Vary: "Accept-Encoding", ...(gzip ? { "Content-Encoding": "gzip" } : {}), ...(type.startsWith("text/html") ? { "Content-Security-Policy": APP_CSP } : {}) });
      if (req.method === "HEAD") return void res.end();
      const stream = createReadStream(file);
      return void (gzip ? stream.pipe(createGzip()).pipe(res) : stream.pipe(res));
    }
    send(res, 404, "not found");
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  /** Open sockets per project, closed when it's archived. */
  const sockets = new Map<Runtime, Set<WebSocket>>();
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const origin = req.headers.origin ?? "";
    // Token or device cookie + origin: another website in your browser can't drive HQ.
    const who = whoIs(req, url.searchParams.get("token") ?? "");
    // An unknown or removed project (e.g. a stale bookmark) falls back to the default one.
    const rt = o.projects.get(url.searchParams.get("project") ?? "") ?? o.projects.get(o.defaultProject());
    if (url.pathname !== "/ws" || !who || !okOrigin(req) || !rt) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }
    const remote = isRemote(req);
    // ?watch=1: the one-building office following another project. Status only (no terminal output), commands ignored.
    const watch = url.searchParams.get("watch") === "1";
    log.info(`ui connected: ${rt.slug} ${who.role}${watch ? " watching" : ""}${remote ? " (remote)" : ""}${origin ? ` from ${origin}` : ""}`);
    if (who.role === "owner" && !watch) ownerSeen(); // a page or the phone app opening
    wss.handleUpgrade(req, socket, head, (ws) => onClient(ws, rt, who, origin, remote, watch));
  });

  function onClient(ws: WebSocket, rt: Runtime, who: Who, origin: string, remote: boolean, watch = false) {
    const { deviceId } = who;
    // Read per command: a role change or sign-out applies to an open socket too.
    const current = (): Who | null => {
      if (deviceId && !o.guard.device(deviceId, false)) return null;
      return who.userId ? ((u) => (u ? { ...who, role: u.role } : null))(users.active(who.userId)) : who;
    };
    // A device that entered a code today stays elevated (24 h); a bare-token connection only until it closes.
    let elevatedUntil = deviceId ? o.guard.deviceElevatedUntil(deviceId) : 0;
    const sendEvent = (e: OfficeEvent) => {
      if (!current()) { ws.close(4001, "session expired"); return; }
      if (watch && (e.type === "terminal.output" || e.type === "workspace.info")) return;
      if (ws.readyState === ws.OPEN) ws.send(redactor().redact(JSON.stringify(e))); // messages, notes, findings: masked too
    };
    sendEvent({ type: "snapshot", snapshot: rt.hub.snap });
    const unsub = rt.hub.subscribe(sendEvent);
    ws.on("message", async (raw) => {
      if (watch) return;
      try {
        const msg = JSON.parse(String(raw)) as { cmd?: string; args?: unknown[] };
        let cmd = String(msg.cmd ?? "");
        let args = Array.isArray(msg.args) ? msg.args : [];
        const audit = (result: Parameters<RemoteGuard["audit"]>[0]["result"], c = cmd, a: unknown[] = args) =>
          o.guard.audit({ project: rt.slug, role: current()?.role ?? "-", user: who.userName, origin, remote, cmd: c, args: a, result });
        const me = current();
        if (!me) return void (audit("blocked"), ws.close());
        const role = me.role;
        if (role === "owner") ownerSeen();

        // Step-up: { cmd: "elevate", args: [code, pendingCmd?, pendingArgs?] }
        if (cmd === "elevate") {
          if (!canOperate(role)) return audit("blocked");
          // Each person's own authenticator; token-link devices use the server's.
          if (!o.guard.verify(String(args[0] ?? ""), who.userId ? users.active(who.userId)?.totp : undefined)) {
            audit("bad-code", "elevate", []);
            return sendEvent({ type: "remote.stepup", status: "denied" });
          }
          elevatedUntil = o.guard.stepUpUntil();
          if (deviceId) o.guard.elevateDevice(deviceId, elevatedUntil);
          audit("elevated", "elevate", []);
          sendEvent({ type: "remote.stepup", status: "ok", until: elevatedUntil });
          const pending = typeof args[1] === "string" ? args[1] : "";
          if (!pending || pending === "elevate") return;
          const pArgs = Array.isArray(args[2]) ? args[2] : [];
          // A valid authenticator code proves identity, never permission for the pending command.
          cmd = pending;
          args = pArgs;
        }

        const verdict = authorize(cmd, args, { role, remote, elevated: Date.now() <= Math.max(elevatedUntil, deviceId ? o.guard.deviceElevatedUntil(deviceId) : 0) }, {
          agentMode: (id) => rt.hub.cfg(id)?.mode,
        });
        const fn = verdict.ok ? rt.commands[verdict.name] : undefined;
        if (!verdict.ok || !fn) {
          if (verdict.ok || verdict.why === "unknown") return log.warn("unknown command", cmd);
          if (verdict.why === "step-up") {
            audit("step-up-required");
            return sendEvent({ type: "remote.stepup", status: "required", cmd, args });
          }
          audit("blocked");
          return log.warn(`${verdict.why === "role" ? "not allowed for a " + role : "bad arguments"}:`, cmd);
        }
        args = verdict.args;
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
    const mine = sockets.get(rt) ?? new Set<WebSocket>();
    sockets.set(rt, mine.add(ws));
    ws.on("close", () => (unsub(), mine.delete(ws)));
  }

  server.on("close", () => { for (const stop of pushSubscriptions.values()) stop(); pushSubscriptions.clear(); });

  // Same handlers on each extra address; a failure there (e.g. Docker down) only disables that address.
  for (const h of o.extraHosts ?? []) {
    if (h === o.host || o.host === "0.0.0.0") continue;
    const extra = createServer();
    for (const l of server.listeners("request")) extra.on("request", l as (...a: unknown[]) => void);
    for (const l of server.listeners("upgrade")) extra.on("upgrade", l as (...a: unknown[]) => void);
    extra.on("error", (err) => log.warn(`couldn't listen on ${h}:${o.port}: ${err.message}`));
    extra.listen(o.port, h);
    server.on("close", () => extra.close());
  }

  return new Promise<typeof server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host, () => resolve(server));
  });
}
