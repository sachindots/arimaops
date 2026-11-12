// Regression checks for startup, catalogs and completion gates. No paid requests.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

process.env.HOME = mkdtempSync(join(tmpdir(), "arima-company-"));
const { accounts } = await import("../server/credentials/registry");
const { accountModels, checkAccountModel, modelIds } = await import("../server/models");
const { assertTaskCompletion } = await import("../server/taskCompletion");
const { Sessions } = await import("../server/sessions");
const { adapters } = await import("../server/adapters");
const { newAgent } = await import("../server/store");
const { runArgs, loginCommand, containerLogHome } = await import("../server/containers");
const { UsageMeter, claudeDirKey } = await import("../server/usage");
const { readFacts, factsPath } = await import("../server/facts");
const { mkdirSync, writeFileSync } = await import("node:fs");
const { dirname } = await import("node:path");
const { Planner } = await import("../server/planner");

accounts().save({ id: "openai-test", provider: "openai", secret: "test-openai-not-real" });
accounts().save({ id: "anthropic-test", provider: "anthropic", secret: "test-anthropic-not-real" });

assert.deepEqual(modelIds("openai", { data: [{ id: "gpt-test" }, { id: "text-embedding-test" }] }), ["gpt-test"]);
assert.deepEqual(modelIds("google", { models: [{ name: "models/gemini-test", supportedGenerationMethods: ["generateContent"] }, { name: "models/embed", supportedGenerationMethods: ["embedContent"] }] }), ["gemini-test"]);
await assert.rejects(checkAccountModel("openai-test", "codex", "claude-test"), /another provider/);
await assert.rejects(checkAccountModel("openai-test", "claude", "gpt-test"), /cannot be used/);
assert.deepEqual(await accountModels("openai-test", "codex", async (_url, init) => {
  assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-openai-not-real");
  assert.equal(init?.redirect, "error");
  return Response.json({ data: [{ id: "gpt-test" }] });
}), ["gpt-test"]);
console.log("✓ provider catalogs: authenticated server-side, embedding models excluded, account/model mismatches rejected");

const worker = newAgent("worker", "Kavin", "Developer", "#00ff66", false);
worker.mode = "container"; worker.account = "anthropic-test"; worker.model = "";
worker.workspacePath = mkdtempSync(join(tmpdir(), "arima-start-"));
const status = { agentId: worker.id, state: "idle", session: { state: "stopped", detail: "" } };
const workflow = { mode: "deliverables", review: { enabled: true } };
const hub = {
  slug: "test", repo: { root: worker.workspacePath },
  snap: { config: { team: [worker], workflow }, agents: [status], setup: { containerReady: true, checks: [{ id: "tmux", status: "ok" }, { id: "login-claude", status: "missing" }] } },
  cfg: () => worker, status: () => status,
  setStatus: (_id: string, patch: object) => Object.assign(status, patch),
  setSession: (_id: string, patch: object) => Object.assign(status.session, patch), activity: () => {},
};
const sessions = new Sessions(hub as never, "fixture-token");
const claudeArgs = runArgs(worker, "hq-test-worker", "/work-test", [], null, 7420);
assert.ok(claudeArgs.includes(`${containerLogHome("hq-test-worker")}/projects:/auth/claude/projects`));
const write = adapters.claude.writeFiles;
try {
  adapters.claude.writeFiles = async () => { throw new Error("workspace-prepared-without-subscription-login"); };
  await sessions.start(worker.id);
  assert.equal(status.session.detail, "workspace-prepared-without-subscription-login");
  worker.account = "default";
  await sessions.start(worker.id);
  assert.match(status.session.detail, /isn't signed in for containers/);
} finally { adapters.claude.writeFiles = write; }
worker.cli = "agy";
assert.match(runArgs(worker, "agy-test", "/work-test", [], null, 7420).join(" "), /hq-auth-agy:/);
assert.match(loginCommand("agy", 7420), /arimaops-agent agy$/);
console.log("✓ real Sessions preflight accepts API credentials without OAuth; subscriptions still require login; Antigravity container wiring");
assert.ok(adapters.codex.launch({ ...worker, cli: "codex", model: "gpt-5.4" }).args.includes("gpt-5.4"), "requested models are never silently replaced");

const task = { id: "T1", ownerId: "worker", status: "done", doneWhen: "Tests pass", note: "Tests passed: pnpm build", deliverablePath: "report.md", prNumber: null };
assert.throws(() => assertTaskCompletion(task as never, workflow as never, [], "worker"), /different reviewer/);
assert.doesNotThrow(() => assertTaskCompletion(task as never, workflow as never, [], "lead"));
assert.throws(() => assertTaskCompletion({ ...task, note: "" } as never, workflow as never, [], "lead"), /verification summary/);
assert.throws(() => assertTaskCompletion({ ...task, doneWhen: "" } as never, workflow as never, [], "lead"), /acceptance criteria/);
const code = { ...workflow, mode: "github-pr" };
assert.throws(() => assertTaskCompletion(task as never, code as never, [], "lead"), /merged/);
assert.doesNotThrow(() => assertTaskCompletion({ ...task, prNumber: 1 } as never, code as never, [{ number: 1, taskId: "T1", merged: true }] as never, "github"));
let pushed = 0;
const planHub = { snap: { config: { workflow, team: [{ id: "lead", name: "Arul", isLead: true }, { id: "worker", name: "Kavin" }] }, tasks: [{ ...task, status: "in-review", needs: [] }], messages: [], agents: [], pullRequests: [] }, cfg: (id: string) => ({ id }), name: (id: string) => id, emit: () => {}, planChanged: () => {}, activity: () => {}, status: () => null, repo: { root: worker.workspacePath } };
const planner = new Planner(planHub as never, { push: () => pushed++, save: () => {} } as never);
assert.throws(() => planner.updateTask("T1", { status: "done", note: "" }, "lead"), /verification/);
assert.equal(planHub.snap.tasks[0].status, "in-review", "rejected completion preserves task state and dependencies");
planner.message("lead", "worker", "Review the changed file");
planner.message("lead", "worker", "Review the changed file");
assert.equal(pushed, 1, "identical repeated messages do not wake an agent twice");
console.log("✓ completion requires evidence and separate review; code requires a merged PR; duplicate chatter suppressed");

const factsFile = factsPath(worker.workspacePath);
mkdirSync(dirname(factsFile), { recursive: true });
writeFileSync(factsFile, Array.from({ length: 80 }, (_, i) => `- fact ${i}`).join("\n") + "\n- " + "x".repeat(200));
assert.equal(readFacts(worker.workspacePath).length, 40);
console.log("✓ repo context bounded even when facts.md is edited manually");
const logHome = containerLogHome("hq-test-worker");
const transcript = join(logHome, "projects", claudeDirKey("/work"));
mkdirSync(transcript, { recursive: true });
writeFileSync(join(transcript, "fixture.jsonl"), JSON.stringify({ message: { id: "m1", usage: { input_tokens: 12, output_tokens: 3 } } }));
assert.equal(new UsageMeter().read("claude", "/work", logHome)?.input, 12);
assert.equal(new UsageMeter().read("claude", "/work", containerLogHome("hq-test-other"))?.input, 0);
console.log("✓ container usage reads each agent's own transcripts, without exposing shared sign-in files");
console.log("All company checks passed.");
