import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// People, roles, sign-in and sessions, end to end against the real HTTP server. Run: npx tsx scripts/users-test.ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDoc, readLines } from "../server/lib/docs";

const HOME = mkdtempSync(join(tmpdir(), "arima-users-"));
process.env.HOME = HOME;
const { Users, Throttle } = await import("../server/users");
const { RemoteGuard, totp, base32Encode } = await import("../server/remote");
const { startHttp } = await import("../server/http");
const { WebSocket } = await import("ws");

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};
const throws = (fn: () => unknown, re: RegExp) => {
  try {
    fn();
    return false;
  } catch (e) {
    return re.test(String(e));
  }
};

// ---------------------------------------------------------------- store
{
  const u = new Users(join(HOME, "u1.json"));
  check("the first person must be the owner", throws(() => u.create({ name: "Sam", role: "operator", password: "long-enough-pw" }), /first person must be the owner/));
  check("short passwords are refused", throws(() => u.create({ name: "Sam", role: "owner", password: "short" }), /at least 10/));
  const { otpauth } = u.create({ name: "Sam", role: "owner", password: "long-enough-pw" });
  check("the authenticator link names the person", otpauth.startsWith("otpauth://totp/") && otpauth.includes("Sam"));
  const raw = JSON.stringify(readDoc(join(HOME, "u1.json")));
  check("the file holds a hash, never the password", !raw.includes("long-enough-pw") && raw.includes('"hash"'));
  check("right password signs in (name is case-insensitive); wrong doesn't", u.verify("sam", "long-enough-pw")?.name === "Sam" && u.verify("Sam", "wrong-password!") === null && u.verify("Nobody", "long-enough-pw") === null);
  check("names are unique", throws(() => u.create({ name: "SAM", role: "viewer", password: "long-enough-pw" }), /already/));
  const sam = u.firstOwner()!;
  check("the last owner can't be demoted, disabled or removed", throws(() => u.update(sam.id, { role: "operator" }), /at least one active owner/) && throws(() => u.update(sam.id, { disabled: true }), /owner/) && throws(() => u.remove(sam.id), /owner/));
  const { user: ana } = u.create({ name: "Ana", role: "operator", password: "another-password" });
  const diskBeforeReset = JSON.stringify(readDoc(join(HOME, "u1.json")));
  check("invalid reset rejects the entire patch", throws(() => u.update(ana.id, { role: "owner", disabled: true, password: "short", resetTotp: true }), /at least 10/));
  check("invalid reset preserves password, role, enabled state and disk", u.verify("Ana", "another-password")?.role === "operator" && JSON.stringify(readDoc(join(HOME, "u1.json"))) === diskBeforeReset);
  u.update(ana.id, { disabled: true });
  check("a disabled person can't sign in and isn't active", u.verify("Ana", "another-password") === null && u.active(ana.id) === null);
  const before = u.active(sam.id)!.totp;
  const r = u.update(sam.id, { resetTotp: true });
  check("a new authenticator replaces the old secret", !!r.otpauth && u.active(sam.id)!.totp !== before);
}

// ---------------------------------------------------------------- throttle and per-person codes
{
  const t = new Throttle(3, 60_000);
  t.fail("ip:1", 0); t.fail("ip:1", 1); t.fail("ip:1", 2);
  check("throttle: blocked after the limit, free again after the window", t.blocked("ip:1", 3) && !t.blocked("ip:1", 70_000) && !t.blocked("ip:2", 3));
  const g = new RemoteGuard(join(HOME, "guard1"));
  const mine = base32Encode(Buffer.alloc(20, 9));
  const step = Math.floor(Date.now() / 30_000);
  const code = totp(Buffer.alloc(20, 9), step);
  check("a person's own code works; the server's secret doesn't accept it", !g.verify(code) && g.verify(code, mine));
  check("a code can't be used twice", !g.verify(code, mine));
}

// ---------------------------------------------------------------- the real server
const PORT = 47000 + Math.floor(Math.random() * 1000);
const LOCAL = "http://localhost:5173";
const guard = new RemoteGuard(join(HOME, "guard"));
const users = new Users(join(HOME, "users.json"));
const calls: string[] = [];
const hub = { snap: { config: { team: [] }, agents: [], environments: [] }, subscribe: () => () => {} };
const rt = { slug: "alpha", hub, commands: { saveAccount: async () => void calls.push("saveAccount"), removeAccount: async () => void calls.push("removeAccount"), setProxy: async () => void calls.push("setProxy"), sendMessage: async () => void calls.push("sendMessage"), startAgent: async () => void calls.push("startAgent") } };
const server = await startHttp({
  projects: new Map([["alpha", rt as never]]), defaultProject: () => "alpha", loadProject: async () => {}, unloadProject: async () => {},
  port: PORT, browserToken: "link-token-123", viewerToken: "viewer-token-456", host: "127.0.0.1",
  sameOrigin: false, localOrigins: [LOCAL], allowedOrigins: [LOCAL], guard, users, distDir: null,
});
const base = `http://127.0.0.1:${PORT}`;
type R = { status: number; body: Record<string, unknown>; cookie: string };
async function call(method: string, path: string, opts: { body?: unknown; cookie?: string; origin?: string | null } = {}): Promise<R> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.origin !== null) headers.Origin = opts.origin ?? LOCAL;
  if (opts.cookie) headers.Cookie = opts.cookie;
  const res = await fetch(base + path, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const set = res.headers.get("set-cookie") ?? "";
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown>, cookie: set.split(";")[0] };
}

let r = await call("GET", "/api/auth/me?token=link-token-123");
check("before anyone signs up, the start-up link is the owner", r.status === 200 && r.body.role === "owner" && r.body.people === 0);
r = await call("POST", "/api/users?token=link-token-123", { body: { name: "Sam", password: "sams-password-1", role: "viewer" } });
check("the first person created is made owner, whatever role was asked", r.status === 200 && (r.body.user as { role: string }).role === "owner" && String(r.body.otpauth).startsWith("otpauth://"));
r = await call("GET", "/api/auth/me?token=link-token-123", { origin: "https://phone.example" });
check("after that, the start-up link doesn't work from another device", r.status === 401);
r = await call("GET", "/api/auth/me?token=link-token-123");
check("…but still works on this machine, as the owner", r.status === 200 && (r.body.user as { name: string }).name === "Sam");
// A browser sends no Origin on a same-origin GET: the Host it asked for decides.
const hostGet = (host: string) =>
  new Promise<number>((res) => {
    const { request } = require("node:http") as typeof import("node:http");
    request({ host: "127.0.0.1", port: PORT, path: "/api/auth/me?token=link-token-123", headers: { Host: host } }, (m) => (m.resume(), res(m.statusCode ?? 0))).end();
  });
check("…including a browser's plain GET (no Origin) to a local address", (await hostGet("localhost:5173")) === 200);
check("…but not a plain GET for another host name (a LAN address through a proxy)", (await hostGet("192.168.1.5:5173")) === 401);

const sam = await call("POST", "/api/auth/login", { body: { name: "sam", password: "sams-password-1" } });
check("signing in with name and password sets a session cookie", sam.status === 200 && sam.cookie.startsWith("hq_sid=") && sam.cookie.length > 20);
r = await call("POST", "/api/users", { cookie: sam.cookie, body: { name: "Ana", password: "anas-password-1", role: "operator" } });
check("the owner adds an operator", r.status === 200);
const ana = await call("POST", "/api/auth/login", { body: { name: "Ana", password: "anas-password-1" } });
r = await call("GET", "/api/users", { cookie: ana.cookie });
check("an operator can't see or manage people", r.status === 403);

// WebSocket: owner-only commands, viewers, live role changes.
async function ws(cookie: string, cmds: string[]) {
  const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws?project=alpha`, { headers: { Cookie: cookie, Origin: LOCAL } });
  await new Promise((res, rej) => (sock.once("open", res), sock.once("error", rej)));
  for (const c of cmds) sock.send(JSON.stringify({ cmd: c, args: [] }));
  await new Promise((res) => setTimeout(res, 300));
  sock.close();
}
calls.length = 0;
await ws(ana.cookie, ["saveAccount", "startAgent"]);
check("an operator runs agents but can't change API keys", JSON.stringify(calls) === JSON.stringify(["startAgent"]), JSON.stringify(calls));
calls.length = 0;
await ws(sam.cookie, ["saveAccount"]);
check("the owner can change API keys", JSON.stringify(calls) === JSON.stringify(["saveAccount"]));
// Each pending command must pass the same authorization as a direct command.
for (const pending of ["saveAccount", "removeAccount", "setProxy"]) {
  const person = users.create({ name: `Operator-${pending}`, role: "operator", password: "operator-test-password" }).user;
  const cookie = `hq_sid=${guard.addDevice("operator", "test", person.id)}`;
  const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Cookie: cookie, Origin: LOCAL } });
  await new Promise((res, rej) => (sock.once("open", res), sock.once("error", rej)));
  const secret = users.active(person.id)!.totp;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secret) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const code = totp(key, Math.floor(Date.now() / 30_000));
  calls.length = 0;
  sock.send(JSON.stringify({ cmd: "elevate", args: [code, pending, []] }));
  sock.send(JSON.stringify({ cmd: "startAgent", args: [] }));
  await new Promise((res) => setTimeout(res, 150));
  check(`operator TOTP cannot resume ${pending}; ordinary operator work still works`, JSON.stringify(calls) === JSON.stringify(["startAgent"]));
  const audit = readLines(join(HOME, "guard", "audit.log")).join("\n");
  check(`denied continuation ${pending} is audited`, audit.split("\n").some((line) => line.includes(`Operator-${pending}/operator`) && line.includes(pending) && line.includes("blocked")));
  sock.close();
}
const anaId = ((await call("GET", "/api/users", { cookie: sam.cookie })).body.users as { id: string; name: string }[]).find((u) => u.name === "Ana")!.id;
await call("PATCH", `/api/users/${anaId}`, { cookie: sam.cookie, body: { role: "viewer" } });
calls.length = 0;
await ws(ana.cookie, ["startAgent", "sendMessage"]);
check("a demotion applies at once: Ana (now viewer) can chat but not start agents", JSON.stringify(calls) === JSON.stringify(["sendMessage"]), JSON.stringify(calls));
r = await call("GET", "/api/auth/me", { cookie: ana.cookie });
check("her session reports the new role", r.body.role === "viewer");
await call("DELETE", `/api/users/${anaId}`, { cookie: sam.cookie });
r = await call("GET", "/api/auth/me", { cookie: ana.cookie });
check("removing a person signs their devices out", r.status === 401);
r = await call("PATCH", `/api/users/${(await call("GET", "/api/auth/me", { cookie: sam.cookie })).body.user && ((await call("GET", "/api/users", { cookie: sam.cookie })).body.users as { id: string }[])[0].id}`, { cookie: sam.cookie, body: { role: "operator" } });
check("the last owner can't demote themself", r.status === 400 && /owner/.test(String(r.body.error)));
r = await call("POST", "/api/users", { cookie: sam.cookie, origin: "https://evil.example", body: { name: "Eve", password: "eves-password-1" } });
check("another website can't manage people (origin refused)", r.status === 403);
r = await call("POST", "/api/users", { cookie: sam.cookie, origin: null, body: { name: "Eve", password: "eves-password-1" } });
check("managing people from another device needs the authenticator step-up", r.status === 403 && /authenticator/.test(String(r.body.error)), JSON.stringify(r));

for (let i = 0; i < 5; i++) await call("POST", "/api/auth/login", { body: { name: "sam", password: "wrong-password" } });
r = await call("POST", "/api/auth/login", { body: { name: "sam", password: "sams-password-1" } });
check("after 5 wrong passwords, even the right one waits (throttled)", r.status === 429);
await call("POST", "/api/auth/logout", { cookie: sam.cookie });
r = await call("GET", "/api/auth/me", { cookie: sam.cookie });
check("signing out ends the session", r.status === 401);

// A person changes their own password from a remote app, using the current password instead of admin step-up.
const mobile = users.create({ name: "Mobile", role: "viewer", password: "old-mobile-password" }).user;
const mobileCookie = `hq_sid=${guard.addDevice("viewer", "mobile", mobile.id)}`;
const otherCookie = `hq_sid=${guard.addDevice("viewer", "other phone", mobile.id)}`;
const idleSeen = guard.device(otherCookie.slice(7), false)?.lastSeen;
await new Promise((res) => setTimeout(res, 10));
check("background checks do not extend a device session", guard.device(otherCookie.slice(7), false)?.lastSeen === idleSeen);
const change = (cookie: string, currentPassword: string, newPassword: string, origin: string | null = LOCAL) =>
  call("POST", "/api/auth/password", { cookie, origin, body: { currentPassword, newPassword } });
check("password change requires a signed-in account", (await change("", "old-mobile-password", "new-mobile-password")).status === 401);
check("another origin cannot change a password", (await change(mobileCookie, "old-mobile-password", "new-mobile-password", "https://evil.example")).status === 403);
check("wrong current password is refused", (await change(mobileCookie, "wrong", "new-mobile-password")).status === 403);
check("short new passwords are refused", (await change(mobileCookie, "old-mobile-password", "short")).status === 400);
const oldSocket = new WebSocket(`ws://127.0.0.1:${PORT}/ws?project=alpha`, { headers: { Cookie: otherCookie, Origin: LOCAL } });
await new Promise((res, rej) => (oldSocket.once("open", res), oldSocket.once("error", rej)));
r = await change(mobileCookie, "old-mobile-password", "new-mobile-password", null);
const changedCookie = r.cookie;
check("a viewer can change their own password remotely without admin access", r.status === 200 && !!changedCookie);
check("only the new password signs in", !users.verify("Mobile", "old-mobile-password") && !!users.verify("Mobile", "new-mobile-password"));
check("password change rotates the current cookie", changedCookie !== mobileCookie && (await call("GET", "/api/auth/me", { cookie: changedCookie })).status === 200);
check("password change revokes other sessions", (await call("GET", "/api/auth/me", { cookie: otherCookie })).status === 401 && (await call("GET", "/api/auth/me", { cookie: mobileCookie })).status === 401);
calls.length = 0;
const closed = new Promise((res) => oldSocket.once("close", res));
oldSocket.send(JSON.stringify({ cmd: "sendMessage", args: [] }));
await closed;
check("a revoked open socket cannot run commands", calls.length === 0);
check("passwords stay out of the user file", !/old-mobile-password|new-mobile-password/.test(JSON.stringify(readDoc(join(HOME, "users.json")))));
for (let i = 0; i < 5; i++) await change(changedCookie, "wrong", "next-mobile-password");
check("guessing a current password is throttled", (await change(changedCookie, "new-mobile-password", "next-mobile-password")).status === 429);

const log = readLines(join(HOME, "guard", "audit.log")).join("\n");
check("the audit log names the person and never holds a password", /\tSam\/owner\t/.test(log) && /bad-password/.test(log) && !/sams-password|anas-password|wrong-password|old-mobile-password|new-mobile-password/.test(log), log.slice(-400));

server.close();
console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
