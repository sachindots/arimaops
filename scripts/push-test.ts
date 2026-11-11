// Run: npx tsx scripts/push-test.ts
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FcmSender, parseServiceAccount, PushDevices, pushAlert, type PushAlert } from "../server/push";
import { Users } from "../server/users";
import { RemoteGuard } from "../server/remote";
import { startHttp } from "../server/http";
import { World } from "../src/data/mock/world";
import { presets } from "../src/data/mock/presets";
import type { OfficeEvent } from "../src/data/source";

const dir = mkdtempSync(join(tmpdir(), "arima-push-"));
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const credential = JSON.stringify({ type: "service_account", project_id: "test-project", client_email: "sender@test-project.iam.gserviceaccount.com", private_key: keys.privateKey.export({ type: "pkcs8", format: "pem" }) });
assert.equal(parseServiceAccount(credential).project_id, "test-project");
assert.throws(() => parseServiceAccount('not-json-private-secret'), /^Error: Invalid Firebase service-account/);
const deliveries: { token: string; data: { server: string; path: string } }[] = [];
let oauthCalls = 0;
let status = 200;
const sender = new FcmSender(() => credential, async (url, options) => {
  if (String(url).includes("oauth2.googleapis.com")) {
    oauthCalls++;
    assert.ok(options?.body instanceof URLSearchParams);
    const assertion = options.body.get("assertion")!;
    const [header, payload, signature] = assertion.split(".");
    assert.ok(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), keys.publicKey, Buffer.from(signature, "base64url")));
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
    assert.equal(claims.scope, "https://www.googleapis.com/auth/firebase.messaging");
    assert.equal(claims.exp - claims.iat, 3600);
    return Response.json({ access_token: "fixture-access-token", expires_in: 3600 });
  }
  assert.equal(String(url), "https://fcm.googleapis.com/v1/projects/test-project/messages:send");
  assert.equal(new Headers(options?.headers).get("authorization"), "Bearer fixture-access-token");
  const body = JSON.parse(String(options?.body));
  assert.equal(body.message.android.priority, "high");
  assert.equal(body.message.android.ttl, "3600s");
  deliveries.push(body.message);
  return status === 200 ? Response.json({ name: "projects/test-project/messages/test" }) : Response.json({ error: { details: [{ errorCode: status === 404 ? "UNREGISTERED" : "INTERNAL" }] } }, { status });
});
const alert: PushAlert = { key: "fixture", title: "ArimaOps test", body: "Open HQ", path: "/?open=board", operatorsOnly: false };
const users = new Users(join(dir, "users.json"));
const owner = users.create({ name: "Test owner", role: "owner", password: "test-password-only" }).user;
const viewer = users.create({ name: "Test viewer", role: "viewer", password: "test-viewer-password" }).user;
const guard = new RemoteGuard(join(dir, "guard"));
const ownerDevice = guard.addDevice("owner", "fixture", owner.id);
const viewerDevice = guard.addDevice("viewer", "fixture", viewer.id);
const file = join(dir, "push.json");
const devices = new PushDevices((deviceId, userId) => guard.device(deviceId, false)?.userId === userId ? users.active(userId)?.role ?? null : null, sender, file);
const token = (name: string) => `${name}-fixture-token-long-enough`;
devices.register({ deviceId: ownerDevice, userId: owner.id, token: token("owner"), server: "https://hq.example" });
devices.register({ deviceId: viewerDevice, userId: viewer.id, token: token("viewer"), server: "https://hq.example" });
assert.equal(statSync(file).mode & 0o777, 0o600);
assert.throws(() => devices.register({ deviceId: "bad", userId: owner.id, token: token("bad"), server: "http://remote.example" }));
await devices.notify({ ...alert, operatorsOnly: true });
assert.deepEqual(deliveries.map(d => d.token), [token("owner")]);
await devices.notify(alert);
assert.equal(deliveries.length, 3);
assert.equal(oauthCalls, 1, "OAuth token is reused");
const reopened = new PushDevices(() => "owner", sender, file);
await reopened.notify(alert);
assert.equal(deliveries.length, 5, "registrations survive restart");
users.update(viewer.id, { disabled: true });
await devices.notify(alert);
assert.equal(deliveries.length, 6, "disabled user receives nothing");
guard.removeDevice(ownerDevice);
await devices.notify(alert);
assert.equal(deliveries.length, 6, "revoked device receives nothing");
assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), []);

const active = new PushDevices(() => "owner", sender, file);
active.register({ deviceId: "rotation", userId: owner.id, token: token("old"), server: "https://hq.example" });
active.register({ deviceId: "rotation", userId: owner.id, token: token("new"), server: "https://hq.example" });
active.register({ deviceId: "new-session", userId: viewer.id, token: token("new"), server: "https://hq.example" });
assert.equal(JSON.parse(readFileSync(file, "utf8")).length, 1, "one token belongs to the latest signed-in device");
status = 503;
await active.notify(alert);
assert.equal(JSON.parse(readFileSync(file, "utf8")).length, 1, "temporary errors retain tokens");
status = 404;
await active.notify(alert);
assert.equal(JSON.parse(readFileSync(file, "utf8")).length, 0, "UNREGISTERED tokens are removed");
status = 200;
assert.equal(await new FcmSender(() => null).send(token("none"), "https://hq.example", alert), "unconfigured");
const deliveryCount = deliveries.length;
assert.equal(await sender.send(token("revoked-during-auth"), "https://hq.example", alert, () => false), "skipped");
assert.equal(deliveries.length, deliveryCount, "authorization is rechecked immediately before delivery");

const listeners = new Set<(e: OfficeEvent) => void>();
const snap = World.initialSnapshot(presets[0]);
const hub = { slug: "fixture", snap, subscribe: (fn: (e: OfficeEvent) => void) => { listeners.add(fn); return () => listeners.delete(fn); } };
const event = (type: "agent.needs-input" | "pr.merged" | "deploy"): OfficeEvent => ({ type: "activity", event: { id: type, type, at: new Date().toISOString(), text: type, agentId: "test-agent" } });
for (const type of ["agent.needs-input", "pr.merged", "deploy"] as const) {
  const result = pushAlert(hub, event(type));
  assert.ok(result);
  assert.ok(result.path.includes("project=fixture"));
  assert.equal(result.operatorsOnly, type === "agent.needs-input");
}
const finding: Extract<OfficeEvent, { type: "finding.updated" }> = { type: "finding.updated", finding: { id: "F-1", title: "Fixture", severity: "high", target: "hq.example", description: "", evidence: "", remediation: "", status: "open", reporterId: "test-agent", taskId: null, at: "now", updatedAt: "now" } };
assert.ok(pushAlert(hub, finding));
assert.ok(pushAlert(hub, { ...finding, finding: { ...finding.finding, severity: "critical" } }));
assert.equal(pushAlert(hub, { ...finding, finding: { ...finding.finding, severity: "low" } }), null);
assert.equal(pushAlert(hub, { ...finding, finding: { ...finding.finding, status: "false-positive" } }), null);
active.register({ deviceId: "watcher", userId: owner.id, token: token("watcher"), server: "https://hq.example" });
const stop = active.watch(hub);
const merged = event("pr.merged");
const before = deliveries.length;
listeners.forEach(fn => fn(merged)); listeners.forEach(fn => fn(merged));
await new Promise(resolve => setImmediate(resolve));
assert.equal(deliveries.length, before + 1, "duplicate events are delivered once");
stop();
assert.equal(listeners.size, 0);

const server = await startHttp({ projects: new Map(), defaultProject: () => "fixture", loadProject: async () => {}, unloadProject: async () => {}, port: 0, browserToken: "link-fixture", viewerToken: "viewer-fixture", host: "127.0.0.1", sameOrigin: true, localOrigins: [], allowedOrigins: ["https://hq.example"], guard, users, push: devices, distDir: null });
try {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const session = guard.addDevice("owner", "route-test", owner.id);
  async function register(opts: { cookie?: string; origin?: string; body?: unknown } = {}) {
    return fetch(`${base}/api/push/register`, { method: "POST", headers: { "Content-Type": "application/json", ...(opts.cookie ? { Cookie: `hq_sid=${opts.cookie}` } : {}), ...(opts.origin ? { Origin: opts.origin } : {}) }, body: JSON.stringify(opts.body ?? { token: token("route") }) });
  }
  assert.equal((await register({ origin: "https://hq.example" })).status, 401);
  assert.equal((await register({ cookie: session, origin: "https://evil.example" })).status, 403);
  assert.equal((await register({ cookie: session })).status, 403);
  assert.equal((await register({ cookie: session, origin: "https://hq.example", body: { token: "short" } })).status, 400);
  assert.equal((await register({ cookie: session, origin: "https://hq.example" })).status, 200);
  assert.equal((await register({ cookie: guard.addDevice("viewer", "link only"), origin: "https://hq.example" })).status, 401);
  const logout = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { Cookie: `hq_sid=${session}`, Origin: "https://hq.example" } });
  assert.equal(logout.status, 200);
  assert.equal((await register({ cookie: session, origin: "https://hq.example" })).status, 401);
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
}
console.log("Push checks passed: JWT signing, OAuth cache, delivery, roles, revocation, rotation, expiry, triggers, deduplication, and HTTP authentication.");
