// Auth checks for server/http.ts: per-agent tokens, project routing, projects API, device cookie login, remote step-up.
// Run: npx tsx scripts/auth-test.ts   (uses a temp HOME; no Docker, tmux or network)

import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

process.env.HOME = mkdtempSync(join(tmpdir(), "hq-auth-"));
const { startHttp } = await import("../server/http");
const { RemoteGuard } = await import("../server/remote");
const { agentTokenFor } = await import("../server/paths");
const { migrateLegacy } = await import("../server/project");

const PORT = 7499;
const BASE = `http://127.0.0.1:${PORT}`;
const LOCAL = `http://127.0.0.1:${PORT}`;
const SECRET = "project-secret";
const OP = "operator-token";
const VIEW = "viewer-token";

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};

const ran: string[] = [];
const hooked: string[] = []; // "<project>:<agent>" for each hook that reached a project
// Two projects with the same agent ids, as real projects have ("dwight" everywhere).
function fakeProject(slug: string, secret: string) {
  const hub = {
    slug,
    snap: { config: { project: { id: slug, name: slug }, team: [] }, agents: [], environments: [] },
    cfg: (id: string) => (id === "dwight" || id === "michael" ? { id } : undefined),
    status: (id: string) => void hooked.push(`${slug}:${id}`),
    name: (id: string) => id,
    subscribe: () => () => {},
  };
  const rt = {
    slug,
    root: `/tmp/${slug}`,
    hub,
    inbox: {},
    planner: {},
    agentSecret: secret,
    paused: false,
    commands: { openShell: (...a: unknown[]) => void ran.push(`openShell:${JSON.stringify(a)}`), sendMessage: () => void ran.push(`sendMessage:${slug}`) },
    pause: () => void (rt.paused = true),
    resume: () => void (rt.paused = false),
  };
  return rt;
}
const projects = new Map<string, ReturnType<typeof fakeProject>>([
  ["alpha", fakeProject("alpha", SECRET)],
  ["beta", fakeProject("beta", "beta-secret")],
]);
const guard = new RemoteGuard(join(process.env.HOME, ".hq"));
const server = await startHttp({
  projects: projects as never,
  defaultProject: () => "alpha",
  loadProject: async () => {},
  port: PORT,
  browserToken: OP,
  viewerToken: VIEW,
  host: "127.0.0.1",
  sameOrigin: false,
  localOrigins: [LOCAL],
  guard,
  distDir: null,
  allowedOrigins: [LOCAL],
});

// ---------------------------------------------------------------- agents
const dwight = agentTokenFor(SECRET, "dwight");
const hook = (agent: string, tok: string) => fetch(`${BASE}/hook/${agent}/Stop`, { method: "POST", headers: { Authorization: `Bearer ${tok}` }, body: "{" });
check("agent hook with its own token passes auth", (await hook("dwight", dwight)).status !== 401);
check("agent can't use its token as another agent", (await hook("michael", dwight)).status === 401);
check("old shared token is rejected on hooks", (await hook("dwight", SECRET)).status === 401);
const mcp = (agent: string, tok: string) => fetch(`${BASE}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "X-HQ-Agent": agent }, body: "{" });
check("MCP with own token passes auth", (await mcp("dwight", dwight)).status !== 401);
check("MCP impersonating the lead is rejected", (await mcp("michael", dwight)).status === 401);

// ---------------------------------------------------------------- routing (same agent id in two projects)
hooked.length = 0;
const okHook = (tok: string) => fetch(`${BASE}/hook/dwight/Stop`, { method: "POST", headers: { Authorization: `Bearer ${tok}` }, body: "{}" });
await okHook(agentTokenFor("beta-secret", "dwight"));
await okHook(dwight);
check("hooks reach the project whose secret signed the token", hooked.join(",") === "beta:dwight,alpha:dwight", hooked.join(","));
check("agent token can't read the projects API", (await fetch(`${BASE}/api/projects`, { headers: { Authorization: `Bearer ${dwight}` } })).status === 401);
check("shared secret can't read the projects API", (await fetch(`${BASE}/api/projects?token=${SECRET}`)).status === 401);

// ---------------------------------------------------------------- projects API
const reg = (headers: Record<string, string>) => fetch(`${BASE}/api/projects/register`, { method: "POST", headers, body: JSON.stringify({ path: "/" }) });
check("projects write with no Origin counts as remote → step-up", (await reg({ Authorization: `Bearer ${OP}` })).status === 403);
check("projects write from a foreign Origin is refused", (await reg({ Authorization: `Bearer ${OP}`, Origin: "https://evil.example" })).status === 403);
check("viewer can't write projects", (await reg({ Authorization: `Bearer ${VIEW}`, Origin: LOCAL })).status === 403);

// ---------------------------------------------------------------- device login
const bad = await fetch(`${BASE}/api/login`, { method: "POST", headers: { Origin: LOCAL }, body: JSON.stringify({ token: "nope" }) });
check("login with a wrong token fails", bad.status === 401);
const login = await fetch(`${BASE}/api/login`, { method: "POST", headers: { Origin: LOCAL }, body: JSON.stringify({ token: OP }) });
const setCookie = login.headers.get("set-cookie") ?? "";
const sid = /hq_sid=([0-9a-f]+)/.exec(setCookie)?.[1] ?? "";
check("login sets an HttpOnly SameSite=Strict cookie", login.status === 200 && !!sid && /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie), setCookie);
check("device is persisted to devices.json", readFileSync(join(process.env.HOME, ".hq", "devices.json"), "utf8").includes(sid));

// ---------------------------------------------------------------- WebSocket
type Ev = { type: string; status?: string };
function connect(q: string, headers: Record<string, string>) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws${q}`, { headers });
  const events: Ev[] = [];
  ws.on("message", (m) => events.push(JSON.parse(String(m)) as Ev));
  const opened = new Promise<boolean>((res) => {
    ws.on("open", () => res(true));
    ws.on("error", () => res(false));
  });
  const send = (cmd: string, ...args: unknown[]) => ws.send(JSON.stringify({ cmd, args }));
  const settle = () => new Promise((r) => setTimeout(r, 150));
  return { ws, events, opened, send, settle };
}

const noAuth = connect("", { Origin: LOCAL });
check("WS without token or cookie is refused", !(await noAuth.opened));

const viaCookie = connect("", { Origin: "https://hq.tailnet.ts.net", Cookie: `hq_sid=${sid}` });
check("WS with only the device cookie is refused from an origin not allowed", !(await viaCookie.opened));

const local = connect(`?token=${OP}`, { Origin: LOCAL });
check("local browser connects", await local.opened);
local.send("openShell", "a");
await local.settle();
check("local browser runs risky command without a code", ran.includes('openShell:["a"]'));

const script = connect(`?token=${OP}`, {});
await script.opened;
script.send("openShell", "b");
await script.settle();
check("no-Origin client can't skip step-up", !ran.includes('openShell:["b"]') && script.events.some((e) => e.type === "remote.stepup" && e.status === "required"));

const proxied = connect(`?token=${OP}`, { Origin: LOCAL, "X-Forwarded-For": "100.64.0.9" });
await proxied.opened;
proxied.send("openShell", "c");
await proxied.settle();
check("proxied (tailscale serve) client needs step-up", !ran.includes('openShell:["c"]'));

// TOTP for the guard's secret
const b32 = readFileSync(join(process.env.HOME, ".hq", "totp-secret"), "utf8").trim();
const keyFrom = (b32: string) => {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, v = 0;
  const out: number[] = [];
  for (const c of b32) {
    v = (v << 5) | A.indexOf(c);
    bits += 5;
    if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
};
const key = keyFrom(b32);
const code = (step = Math.floor(Date.now() / 30_000), k = key) => {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", k).update(msg).digest();
  return String((h.readUInt32BE(h[h.length - 1] & 15) & 0x7fffffff) % 1_000_000).padStart(6, "0");
};

// Device on the phone: cookie, allowed origin, remote (no local origin match via proxy header).
const phone = connect("", { Origin: LOCAL, Cookie: `hq_sid=${sid}`, "X-Forwarded-For": "100.64.0.9" });
check("phone connects with only the device cookie", await phone.opened);
phone.send("elevate", code(), "openShell", ["d"]);
await phone.settle();
check("correct code elevates and runs the pending command", ran.includes('openShell:["d"]'));

const phone2 = connect("", { Origin: LOCAL, Cookie: `hq_sid=${sid}`, "X-Forwarded-For": "100.64.0.9" });
await phone2.opened;
phone2.send("openShell", "e");
await phone2.settle();
check("same device stays elevated on a new connection (once a day)", ran.includes('openShell:["e"]'));

// Brute force lockout on a fresh guard (codes are one-time per step, so use another guard instance).
const g2 = new RemoteGuard(join(process.env.HOME, "g2"));
for (let i = 0; i < 5; i++) g2.verify("000000");
const b32b = readFileSync(join(process.env.HOME, "g2", "totp-secret"), "utf8").trim();
check("each server home gets its own totp secret", b32b !== b32);
check("after 5 wrong codes even the right one is refused", g2.verify(code(undefined, keyFrom(b32b))) === false);
const g3 = new RemoteGuard(join(process.env.HOME, "g3"));
const k3 = keyFrom(readFileSync(join(process.env.HOME, "g3", "totp-secret"), "utf8").trim());
for (let i = 0; i < 4; i++) g3.verify("000000");
check("4 wrong codes don't lock out", g3.verify(code(undefined, k3)) === true);

// ---------------------------------------------------------------- projects in the UI
const beta = connect(`?token=${OP}&project=beta`, { Origin: LOCAL });
await beta.opened;
await beta.settle();
check("?project= picks the project's snapshot", (beta.events[0] as unknown as { snapshot: { config: { project: { id: string } } } })?.snapshot?.config.project.id === "beta");
beta.send("sendMessage");
await beta.settle();
check("commands go to that project", ran.includes("sendMessage:beta"));
const stale = connect(`?token=${OP}&project=gone`, { Origin: LOCAL });
await stale.opened;
await stale.settle();
check("an unknown project falls back to the default", (stale.events[0] as unknown as { snapshot: { config: { project: { id: string } } } })?.snapshot?.config.project.id === "alpha");
const pause = await fetch(`${BASE}/api/projects/beta/pause`, { method: "POST", headers: { Authorization: `Bearer ${OP}` } });
check("pause without Origin (a script) needs step-up", pause.status === 403 && !projects.get("beta")!.paused);
const pauseLocal = await fetch(`${BASE}/api/projects/beta/pause`, { method: "POST", headers: { Authorization: `Bearer ${OP}`, Origin: LOCAL } });
check("local browser can pause", pauseLocal.status === 200 && projects.get("beta")!.paused);
await fetch(`${BASE}/api/projects/beta/resume`, { method: "POST", headers: { Authorization: `Bearer ${OP}`, Origin: LOCAL } });
check("and resume", !projects.get("beta")!.paused);
const viaDevice = await fetch(`${BASE}/api/projects/beta/pause`, { method: "POST", headers: { Cookie: `hq_sid=${sid}`, Origin: LOCAL, "X-Forwarded-For": "100.64.0.9" } });
check("a step-up'd device can pause a project", viaDevice.status === 200 && projects.get("beta")!.paused);
for (const c of [beta, stale]) c.ws.close();

// ---------------------------------------------------------------- legacy migration
const repo = join(process.env.HOME, "repo");
mkdirSync(join(repo, ".jsmhq"), { recursive: true });
writeFileSync(join(repo, ".jsmhq", "config.json"), "{}");
mkdirSync(join(process.env.HOME, ".jsmhq", "legacyproj", "dwight"), { recursive: true });
await migrateLegacy(repo, "legacyproj");
check("repo .jsmhq (untracked) moves to .arima", existsSync(join(repo, ".arima", "config.json")) && !existsSync(join(repo, ".jsmhq")));
check("~/.jsmhq/<project> moves to ~/.arima/<project>", existsSync(join(process.env.HOME, ".arima", "legacyproj", "dwight")) && !existsSync(join(process.env.HOME, ".jsmhq", "legacyproj")));

for (const c of [local, script, proxied, phone, phone2]) c.ws.close();
server.close();
console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
