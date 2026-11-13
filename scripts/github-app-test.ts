// GitHub App and webhooks (docs/agent-engine.md section 6): signatures, repeats, the poll's fallback pace, the
// manifest exchange, and stacked PRs. Run: npx tsx scripts/github-app-test.ts
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "arima-ghapp-"));
process.env.ARIMA_MASTER_KEY = "github-app-test-master-key";
const { finishManifest, githubAppState, GitHubAppWebhooks, handleWebhook, HEALTHY_MS, verifySignature, webhookSecret, webhooksHealthy } = await import("../server/githubApp");
const { appManifest, newAppUrl, WEBHOOK_EVENTS } = await import("../src/data/githubApp");
const { credentialsVault } = await import("../server/credentials/registry");

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};

const secret = "whsec-test";
const sign = (body: string, key = secret) => `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;
const body = JSON.stringify({ action: "synchronize", repository: { full_name: "Acme/Shop" } });

check("a correct signature verifies", verifySignature(secret, body, sign(body)));
check("a wrong key, a changed body or no header don't", !verifySignature(secret, body, sign(body, "other")) && !verifySignature(secret, `${body} `, sign(body)) && !verifySignature(secret, body, undefined) && !verifySignature(secret, body, "sha1=abc"));
check("a non-ASCII body verifies over its UTF-8 bytes", verifySignature(secret, '{"t":"café ✓"}', sign('{"t":"café ✓"}')));

const headers = (event: string, id: string, b = body, sig = sign(b)) => ({ "x-github-event": event, "x-github-delivery": id, "x-hub-signature-256": sig });
check("no App here: 503", handleWebhook(headers("pull_request", "d0"), body, null) === 503);
check("a bad signature: 401, and nothing else is read", handleWebhook(headers("pull_request", "d1", body, sign(body, "nope")), body, secret) === 401 && !webhooksHealthy("acme/shop"));
let hits = 0;
const { onDelivery } = await import("../server/githubApp");
const off = onDelivery("acme/shop", () => hits++);
const t0 = Date.now();
check("ping is accepted", handleWebhook(headers("ping", "d2"), body, secret, t0) === 202 && hits === 0);
check("a pull_request delivery is accepted and reaches the repo's sync", handleWebhook(headers("pull_request", "d3"), body, secret, t0) === 202 && hits === 1);
check("…which is now healthy (repo names compared case-insensitively)", webhooksHealthy("ACME/shop", t0 + 1000));
check("a redelivery is answered but not passed on", handleWebhook(headers("pull_request", "d3"), body, secret, t0) === 202 && hits === 1);
check("events HQ doesn't use: 204", handleWebhook(headers("issues", "d4"), body, secret, t0) === 204 && hits === 1);
check("broken JSON with a good signature: 400", handleWebhook(headers("check_run", "d5", "{oops"), "{oops", secret, t0) === 400);
check("10 quiet minutes: back to polling", !webhooksHealthy("acme/shop", t0 + HEALTHY_MS + 1));
off();
handleWebhook(headers("check_run", "d6"), body, secret, t0);
check("an unsubscribed sync isn't called", hits === 1);

// Webhooks nudge the poll; the poll is the fallback.
{
  const nudges: number[] = [];
  let stopped = false;
  const poll = { watch: () => ({ nudge: (ms?: number) => nudges.push(ms ?? 0), stop: () => void (stopped = true) }) };
  const w = new GitHubAppWebhooks(poll as never).watch("acme/shop", () => {});
  handleWebhook(headers("pull_request_review", "d7"), body, secret);
  check("a delivery makes the poll fetch at once", nudges.length === 1 && nudges[0] <= 2000, JSON.stringify(nudges));
  w.stop();
  handleWebhook(headers("pull_request_review", "d8"), body, secret);
  check("after stop, deliveries don't reach it", nudges.length === 1 && stopped);
}
{
  const { GhPolling } = await import("../server/githubEvents");
  let fetches = 0;
  const realSetTimeout = globalThis.setTimeout;
  const delays: number[] = [];
  globalThis.setTimeout = ((fn: () => void, ms: number) => (delays.push(ms), realSetTimeout(() => {}, 0))) as never;
  const fake = async () => (fetches++, { open: [], merged: [], closed: [], rate: { cost: 1, remaining: 4000, resetAt: "" } });
  const slow = new GhPolling(() => true, fake as never, () => true).watch("acme/shop", () => {});
  const fast = new GhPolling(() => true, fake as never, () => false).watch("acme/other", () => {});
  await new Promise((r) => realSetTimeout(r, 20));
  globalThis.setTimeout = realSetTimeout;
  slow.stop();
  fast.stop();
  check("with webhooks the poll waits 5 minutes; without, its normal pace", fetches === 2 && delays.includes(5 * 60_000) && delays.some((d) => d < 60_000), JSON.stringify(delays));
}

// The manifest and its exchange.
const m = appManifest("ArimaOps HQ", "https://hq.tail.ts.net:8443/api/github/webhook", "https://hq.tail.ts.net/api/github/app/callback");
check("the manifest asks for read-only access and the PR events", Object.values(m.default_permissions).every((v) => v === "read") && m.default_events === WEBHOOK_EVENTS && m.hook_attributes.url.endsWith(":8443/api/github/webhook") && m.public === false);
check("personal and organization forms", newAppUrl("s1") === "https://github.com/settings/apps/new?state=s1" && newAppUrl("s2", "acme") === "https://github.com/organizations/acme/settings/apps/new?state=s2");
let err = "";
try {
  await finishManifest("bad code!");
} catch (e) {
  err = (e as Error).message;
}
check("a malformed code is refused before any request", /isn't a GitHub manifest code/.test(err));
let asked = "";
const fakeGitHub = (async (url: string) => {
  asked = url;
  return new Response(JSON.stringify({ id: 42, slug: "arimaops-hq", html_url: "https://github.com/apps/arimaops-hq", owner: { login: "sachindots" }, pem: "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----", webhook_secret: "s3cret" }), { status: 201 });
}) as typeof fetch;
const st = await finishManifest("abc123", fakeGitHub);
check("the code is traded at GitHub's conversion endpoint", asked === "https://api.github.com/app-manifests/abc123/conversions");
check("the App is saved: id and slug in state, install link", st.app?.id === 42 && st.app.slug === "arimaops-hq" && st.app.installUrl === "https://github.com/apps/arimaops-hq/installations/new" && githubAppState().app?.id === 42);
check("its secrets go to the vault, not the state", webhookSecret() === "s3cret" && !!credentialsVault().get("github-app:private-key") && !JSON.stringify(githubAppState()).includes("s3cret"));
check("then deliveries signed with that secret are accepted", handleWebhook(headers("pull_request", "d9", body, sign(body, "s3cret")), body) === 202);

// Stacked PRs: a task waiting on one open PR starts on its branch, and is told to rebase once it merges.
{
  const { Planner } = await import("../server/planner");
  const { DEV_TEMPLATE } = await import("../src/data/templates");
  const team = [
    { id: "lea", name: "Lea", roleId: "lead", isLead: true, cli: "claude", model: "" },
    { id: "d1", name: "D1", roleId: "developer", isLead: false, cli: "claude", model: "" },
    { id: "d2", name: "D2", roleId: "developer", isLead: false, cli: "claude", model: "" },
  ];
  const st2 = new Map(team.map((a) => [a.id, { agentId: a.id, currentTaskId: null, session: { state: "running" } } as Record<string, unknown>]));
  const snap = { config: { team, template: DEV_TEMPLATE, workflow: { mode: "github-pr", review: { enabled: false } }, project: { id: "stack" } }, boards: [{ id: "B1", title: "B", status: "active", order: 0 }], tasks: [] as never[], messages: [], agents: [...st2.values()], pullRequests: [] as Record<string, unknown>[] };
  const hub = { slug: "stack", repo: { root: "/nonexistent" }, snap, emit: () => {}, planChanged: () => {}, configChanged: () => {}, activity: () => {}, cfg: (id: string) => team.find((a) => a.id === id), name: (id: string) => team.find((a) => a.id === id)?.name ?? id, status: (id: string) => st2.get(id), setStatus: (id: string, p: object) => Object.assign(st2.get(id)!, p) };
  const pushed: { to: string; text: string }[] = [];
  const planner = new Planner(hub as never, { push: (to: string, i: { text: string }) => pushed.push({ to, text: i.text }), save: () => {} } as never);
  const parent = planner.createTask({ title: "Auth API", doneWhen: "x" } as never, "lea");
  const child = planner.createTask({ title: "Auth UI", doneWhen: "x", needs: [parent.id] } as never, "lea");
  planner.assign(parent.id, "d1", "lea");
  planner.assign(child.id, "d2", "lea");
  check("before the parent's PR, the child waits", /don't start it yet/.test(pushed.at(-1)?.text ?? ""));
  planner.setStatus("d1", "in-progress");
  snap.pullRequests.push({ number: 11, taskId: parent.id, branch: "d1/B1-T01-auth-api", merged: false, closed: false, authorId: "d1", title: "x", review: "pending", openComments: 0, mergeable: true, openedAt: "" });
  planner.setStatus("d1", "in-review", "PR open", 11);
  const start = pushed.filter((p) => p.to === "d2").at(-1)?.text ?? "";
  check("once the parent's PR is open, the child starts on its branch", /PR is open, so start/.test(start) && /branch from origin\/d1\/B1-T01-auth-api/.test(start) && /--base d1\/B1-T01-auth-api/.test(start), start);
  check("…and it no longer waits", planner.waitingOn(child as never).length === 0);
  planner.setStatus("d2", "in-progress");
  snap.pullRequests[0].merged = true;
  planner.updateTask(parent.id, { status: "done", prNumber: 11 }, "github");
  const rebase = pushed.filter((p) => p.to === "d2").at(-1)?.text ?? "";
  check("when the parent merges, the child is told to rebase onto main", /is merged/.test(rebase) && /git rebase --onto origin\/main origin\/d1\/B1-T01-auth-api/.test(rebase), rebase);
  const other = planner.createTask({ title: "Two parents", doneWhen: "x", needs: [parent.id, child.id] } as never, "lea");
  check("a task on two unfinished tasks never stacks", planner.stackBase(other as never) === null);
}

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
