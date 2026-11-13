// Flow gates: every gate kind passes and fails, stage moves, who may record evidence, and the
// planner finishing tasks only through gates. Run: npx tsx scripts/gates-test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor, Flow, Gate, GateEvent, TeamTemplate } from "../src/data/model";
import type { PullRequest, Task } from "../src/data/types";

process.env.HOME = mkdtempSync(join(tmpdir(), "arima-gates-"));
const { assertGates, gateProblem, stagesLeft } = await import("../server/gates");
const { hqDb } = await import("../server/lib/db");
const { gateEvents, loadPlanTables, recordGate, savePlanTables } = await import("../server/planStore");
const { DEV_TEMPLATE_V1 } = await import("../src/data/templates");
const { Planner } = await import("../server/planner");

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};
const throws = (fn: () => unknown, mention: RegExp) => {
  try {
    fn();
    return false;
  } catch (e) {
    return mention.test((e as Error).message);
  }
};

const you: Actor = { kind: "user", id: "you" };
const agent = (id: string): Actor => ({ kind: "agent", id });
const task: Task = { id: "T1", boardId: "B1", stageId: "build", title: "x", ownerId: "dev1", status: "in-review", needs: [], prNumber: 7, doneWhen: "works", note: "checked", deliverablePath: "out.md" };
const ev = (gateId: string, state: GateEvent["state"], by: Actor): GateEvent => ({ projectId: "p", taskId: "T1", gateId, state, by, proof: {}, at: "" });
const ctx = (over: Partial<Parameters<typeof gateProblem>[1]> = {}) => ({
  task,
  actor: agent("lead"),
  roleOf: (id: string) => ({ dev1: "developer", dev2: "developer", rev: "reviewer", lead: "lead" })[id] ?? null,
  prs: [] as PullRequest[],
  scopeSet: false,
  events: [] as GateEvent[],
  ...over,
});
const met = (g: Gate, c = ctx()) => gateProblem(g, c) === null;

// Every gate kind, passing and failing.
const merged = { number: 7, taskId: "T1", merged: true } as PullRequest;
check("pr-merged: fails without a merged PR", !met({ id: "g", kind: "pr-merged" }, ctx({ prs: [{ ...merged, merged: false }] })));
check("pr-merged: fails when the PR belongs to another task", !met({ id: "g", kind: "pr-merged" }, ctx({ prs: [{ ...merged, taskId: "T9" }] })));
check("pr-merged: passes with the task's merged PR", met({ id: "g", kind: "pr-merged" }, ctx({ prs: [merged] })));

check("file-delivered: fails without a deliverable path", !met({ id: "g", kind: "file-delivered" }, ctx({ task: { ...task, deliverablePath: null } })));
check("file-delivered: fails without acceptance criteria", /acceptance/.test(gateProblem({ id: "g", kind: "file-delivered" }, ctx({ task: { ...task, doneWhen: "" } })) ?? ""));
check("file-delivered: passes with path, note and criteria", met({ id: "g", kind: "file-delivered" }));

check("scope-set: fails without a scope", !met({ id: "g", kind: "scope-set" }));
check("scope-set: passes with a scope", met({ id: "g", kind: "scope-set" }, ctx({ scopeSet: true })));

const rev: Gate = { id: "rev", kind: "reviewer" };
check("reviewer: fails when the owner finishes alone", !met(rev, ctx({ actor: agent("dev1") })));
check("reviewer: passes when someone else finishes", met(rev, ctx({ actor: agent("lead") })));
check("reviewer: passes on a recorded review by someone else", met(rev, ctx({ actor: agent("dev1"), events: [ev("rev", "passed", agent("dev2"))] })));
const revRole: Gate = { id: "rev", kind: "reviewer", roleId: "reviewer" };
check("reviewer with a role: fails for another role", !met(revRole, ctx({ actor: agent("dev2") })));
check("reviewer with a role: passes for that role", met(revRole, ctx({ actor: agent("rev") })));
check("reviewer with a role: a person always fits", met(revRole, ctx({ actor: you })));

// tests-ci (observed): the task's PR changes a test and every check is green.
{
  const g: Gate = { id: "g", kind: "tests-ci" };
  const pr = { number: 7, taskId: "T1", merged: false } as PullRequest;
  check("tests-ci: fails without the task's PR", /Open the task's PR/.test(gateProblem(g, ctx()) ?? ""));
  check("tests-ci: waits until GitHub sends the PR's files", /Waiting for GitHub/.test(gateProblem(g, ctx({ prs: [pr] })) ?? ""));
  check("tests-ci: fails when no test file changed", /changes no test file/.test(gateProblem(g, ctx({ prs: [{ ...pr, testsChanged: false, ciGreen: true }] })) ?? ""));
  check("tests-ci: fails while CI isn't green", /isn't green/.test(gateProblem(g, ctx({ prs: [{ ...pr, testsChanged: true, ciGreen: false }] })) ?? ""));
  check("tests-ci: passes with a test changed and CI green", met(g, ctx({ prs: [{ ...pr, testsChanged: true, ciGreen: true }] })));
  const { TEST_FILE } = await import("../server/gates");
  const tests = ["src/auth.test.ts", "tests/login.py", "pkg/__tests__/a.js", "server/x_test.go", "spec/models/user_spec.rb", "a/b.spec.tsx"];
  const notTests = ["src/testing-utils.ts", "docs/latest.md", "src/contest.ts"];
  check("test files are recognised by name and folder", tests.every((f) => TEST_FILE.test(f)) && !notTests.some((f) => TEST_FILE.test(f)), JSON.stringify([...tests.filter((f) => !TEST_FILE.test(f)), ...notTests.filter((f) => TEST_FILE.test(f))]));
  const { ciGreen } = await import("../server/github");
  const ghWith = (nodes: unknown[]) => ({ commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes } } } }] } }) as never;
  check("CI green: every check succeeded, neutral or skipped", ciGreen(ghWith([{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }, { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SKIPPED" }, { __typename: "StatusContext", context: "ci", state: "SUCCESS" }])));
  check("CI not green: one still running, one failed, or none at all", !ciGreen(ghWith([{ __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: null }])) && !ciGreen(ghWith([{ __typename: "StatusContext", context: "ci", state: "FAILURE" }])) && !ciGreen(ghWith([])));
}

// analyze (observed): every numbered spec item has a task.
{
  const g: Gate = { id: "g", kind: "analyze" };
  check("analyze: fails without a spec", /no spec/.test(gateProblem(g, ctx()) ?? ""));
  check("analyze: names the uncovered items", /No task covers S3 of the spec/.test(gateProblem(g, ctx({ spec: { items: ["S1", "S2", "S3"], covered: ["S1", "S2"] } })) ?? ""));
  check("analyze: passes when every item is covered", met(g, ctx({ spec: { items: ["S1", "S2"], covered: ["S2", "S1", "S9"] } })));
  const { specItemsOf } = await import("../server/planStore");
  check("spec items are the lines that start with S<n>", specItemsOf("# Login\nS1. Email sign-in\n- S2: rate limit\n  S3) lockout\nNot S4. here\nS1. again").join() === "S1,S2,S3");
}

// second-opinion: from another provider than the task's owner; "high-stakes" only on high-stakes tasks.
{
  const vendorOf = (id: string) => ({ dev1: "anthropic", dev2: "anthropic", gem: "google" })[id] ?? null;
  const always: Gate = { id: "g", kind: "second-opinion", when: "always" };
  const hs: Gate = { id: "g", kind: "second-opinion", when: "high-stakes" };
  check("second opinion: fails without one", !met(always, ctx({ vendorOf })));
  check("second opinion: the same provider doesn't count", /another provider/.test(gateProblem(always, ctx({ vendorOf, events: [ev("g", "passed", agent("dev2"))] })) ?? ""));
  check("second opinion: another provider does", met(always, ctx({ vendorOf, events: [ev("g", "passed", agent("gem"))] })));
  check("second opinion: a later failure wins", !met(always, ctx({ vendorOf, events: [ev("g", "passed", agent("gem")), ev("g", "failed", agent("gem"))] })));
  check("second opinion: a reset undoes a pass", !met(always, ctx({ vendorOf, events: [ev("g", "passed", agent("gem")), ev("g", "reset", you)] })));
  check("high-stakes: an ordinary task doesn't need one", met(hs, ctx({ vendorOf, task: { ...task, files: ["src/ui/Button.tsx"] } })));
  check("high-stakes: the lead's mark makes it needed", !met(hs, ctx({ vendorOf, task: { ...task, highStakes: true } })));
  const { isHighStakes } = await import("../server/gates");
  const sensitive = ["server/auth.ts", "app/login/page.tsx", "lib/crypto/keys.ts", "db/migrations/0003.sql", ".github/workflows/ci.yml", "src/billing.ts", "server/session-store.ts"];
  const plain = ["src/author.ts", "docs/tokenomics.md", "src/ui/Button.tsx"];
  check("sensitive files make a task high-stakes", sensitive.every((f) => isHighStakes({ files: [f] })) && !plain.some((f) => isHighStakes({ files: [f] })), JSON.stringify([...sensitive.filter((f) => !isHighStakes({ files: [f] })), ...plain.filter((f) => isHighStakes({ files: [f] }))]));
}

// findings-report (observed): written, and not older than the task's findings.
{
  const g: Gate = { id: "g", kind: "findings-report" };
  check("findings report: fails before it's written", !met(g));
  check("findings report: fails when older than the task's findings", !met(g, ctx({ reportAt: 1000, findingsAt: 2000 })));
  check("findings report: passes when current", met(g, ctx({ reportAt: 3000, findingsAt: 2000 })));
}

for (const g of [{ id: "g", kind: "owner-approval", reason: "outbound" }, { id: "g", kind: "spec-approved" }] as Gate[]) {
  check(`${g.kind}: an agent's pass doesn't count`, !met(g, ctx({ events: [ev("g", "passed", agent("lead"))] })));
  check(`${g.kind}: the owner's pass does`, met(g, ctx({ events: [ev("g", "passed", you)] })));
}
check("any gate: the owner can waive it", met({ id: "g", kind: "pr-merged" }, ctx({ events: [ev("g", "waived", you)] })));
check("any gate: an agent's waiver doesn't count", !met({ id: "g", kind: "pr-merged" }, ctx({ events: [ev("g", "waived", agent("lead"))] })));

// Stage moves.
const flow: Flow = {
  stages: [
    { id: "spec", name: "Spec", roleIds: ["lead"], gates: [{ id: "spec-ok", kind: "spec-approved" }] },
    { id: "build", name: "Build", roleIds: ["developer"], gates: [{ id: "tests", kind: "tests-ci" }] },
    { id: "review", name: "Review", roleIds: ["reviewer"], gates: [{ id: "merged", kind: "pr-merged" }] },
  ],
};
check("finishing leaves the current stage and every one after it", stagesLeft(flow, "build", null).map((s) => s.id).join() === "build,review");
check("moving one stage on leaves only the current one", stagesLeft(flow, "spec", "build").map((s) => s.id).join() === "spec");
check("an unknown stage is refused", throws(() => stagesLeft(flow, "spec", "ship"), /No stage "ship"/));
check("a move lists every unmet gate it needs", throws(() => assertGates(flow, null, ctx()), /task's PR.*merged/));
check("a move with its gates met goes through", !throws(() => assertGates(flow, "review", ctx({ prs: [{ number: 7, taskId: "T1", merged: false, testsChanged: true, ciGreen: true } as PullRequest] })), /./));

// Storage and who may record evidence.
const db = hqDb();
const plan = { boards: [{ id: "B1", title: "Backlog", status: "active" as const, order: 0 }], tasks: [{ ...task, stageId: "build" }] };
savePlanTables(db, "p", plan, "build");
const loaded = loadPlanTables(db, "p");
check("a plan round-trips through the tables", loaded?.tasks[0].stageId === "build" && loaded.tasks[0].prNumber === 7 && loaded.tasks[0].deliverablePath === "out.md");
const t: TeamTemplate = { ...structuredClone(DEV_TEMPLATE_V1), flow };
recordGate(db, t, task, { projectId: "p", gateId: "spec-ok", state: "passed", by: you, proof: { note: "Spec read" } });
check("recorded evidence is read back", gateEvents(db, "p", "T1").at(-1)?.proof.note === "Spec read");
check("nobody records tests and CI: HQ reads them from the PR", throws(() => recordGate(db, t, task, { projectId: "p", gateId: "tests", state: "passed", by: agent("rev"), proof: {} }), /checks tests/));
check("an unknown gate is refused", throws(() => recordGate(db, t, task, { projectId: "p", gateId: "nope", state: "passed", by: agent("rev"), proof: {} }), /No gate/));
check("an agent can't pass the spec", throws(() => recordGate(db, t, task, { projectId: "p", gateId: "spec-ok", state: "passed", by: agent("lead"), proof: {} }), /Only a person/));
check("an agent can't waive", throws(() => recordGate(db, t, task, { projectId: "p", gateId: "tests", state: "waived", by: agent("lead"), proof: {} }), /Only a person can waive/));
check("nobody records what HQ sees itself", throws(() => recordGate(db, t, task, { projectId: "p", gateId: "merged", state: "passed", by: agent("lead"), proof: {} }), /checks merged/));
const rt: TeamTemplate = { ...t, flow: { stages: [{ id: "build", name: "B", roleIds: ["developer"], gates: [rev] }] } };
check("an owner can't review their own task", throws(() => recordGate(db, rt, task, { projectId: "p", gateId: "rev", state: "passed", by: agent("dev1"), proof: {} }), /own task/));
savePlanTables(db, "p", { ...plan, tasks: [] }, "build");
check("removing a task removes its gate evidence", gateEvents(db, "p", "T1").length === 0);

// The planner finishes tasks only through gates.
{
  const devTask: Task = { ...task, stageId: "build", prNumber: 3 };
  const snap = {
    config: { template: DEV_TEMPLATE_V1, project: { id: "plan" }, workflow: { mode: "github-pr", review: { enabled: true } }, team: [{ id: "lead", roleId: "lead", isLead: true }, { id: "dev1", roleId: "developer" }] },
    boards: plan.boards,
    tasks: [devTask],
    agents: [],
    messages: [],
    pullRequests: [] as PullRequest[],
  };
  const hub = { snap, emit: () => {}, planChanged: () => {}, activity: () => {}, name: (id: string) => id, setStatus: () => {}, status: () => null, cfg: () => null, repo: { root: process.env.HOME } };
  const planner = new Planner(hub as never, { push: () => {} } as never);
  check("the planner refuses done before the PR is merged", throws(() => planner.updateTask("T1", { status: "done" }, "you"), /merged/) && devTask.status === "in-review");
  snap.pullRequests.push({ number: 3, taskId: "T1", merged: true } as PullRequest);
  planner.updateTask("T1", { status: "done" }, "github");
  check("…and finishes it after, in the last stage", devTask.status === "done" && devTask.stageId === "review");
  const made = planner.createTask({ title: "Next" }, "lead");
  check("a new task starts in the first stage", made.stageId === "build");
  check("moving to an unknown stage is refused", throws(() => planner.updateTask(made.id, { stageId: "ship" }), /No stage/));

  const old = new Planner({ ...hub, snap: { ...snap, config: { ...snap.config, template: null } } } as never, { push: () => {} } as never);
  check("a read-only project's plan never changes", throws(() => old.createTask({ title: "x" }, "lead"), /read-only/));
}

// The lead approves for the away owner (3.3): reversible gates only, logged and undoable.
{
  const away = { leadId: "lead", ownerAway: true };
  const here = { leadId: "lead", ownerAway: false };
  const lt: TeamTemplate = { ...t, flow: { stages: [
    { id: "spec", name: "Spec", roleIds: ["lead"], gates: [{ id: "spec-ok", kind: "spec-approved" }, { id: "contain", kind: "owner-approval", reason: "containment" }] },
    { id: "build", name: "Build", roleIds: ["developer"], gates: [{ id: "ship", kind: "owner-approval", reason: "merge" }] },
  ] } };
  const lt1: Task = { ...task, id: "T7", stageId: "spec" };
  savePlanTables(db, "p", { ...plan, tasks: [lt1] }, "spec");
  check("the lead can't pass the spec while the owner is around", throws(() => recordGate(db, lt, lt1, { projectId: "p", gateId: "spec-ok", state: "passed", by: agent("lead"), proof: {} }, here), /after 2 h/));
  check("a worker can't, even with the owner away", throws(() => recordGate(db, lt, lt1, { projectId: "p", gateId: "spec-ok", state: "passed", by: agent("dev1"), proof: {} }, away), /Only a person/));
  check("the lead can't approve containment, away or not", throws(() => recordGate(db, lt, lt1, { projectId: "p", gateId: "contain", state: "passed", by: agent("lead"), proof: {} }, away), /always wait for the owner/));
  check("…nor a merge", throws(() => recordGate(db, lt, lt1, { projectId: "p", gateId: "ship", state: "passed", by: agent("lead"), proof: {} }, away), /always wait for the owner/));
  recordGate(db, lt, lt1, { projectId: "p", gateId: "spec-ok", state: "passed", by: agent("lead"), proof: { note: "matches the brief" } }, away);
  const evs = gateEvents(db, "p", "T7");
  check("with the owner away the lead passes the spec, marked on their behalf", evs.at(-1)?.proof.onBehalf === true && evs.at(-1)?.by.id === "lead");
  check("…and the spec gate counts as met", gateProblem({ id: "spec-ok", kind: "spec-approved" }, ctx({ task: lt1, events: evs })) === null);
  check("a hand-made onBehalf row on a containment gate still doesn't count", gateProblem({ id: "contain", kind: "owner-approval", reason: "containment" }, ctx({ events: [{ ...ev("contain", "passed", agent("lead")), proof: { onBehalf: true } }] })) !== null);
}

// Undo through the planner: a reset row, the task back in the spec stage, lead and owner told.
{
  const { ActionItems } = await import("../server/actionItems");
  const presence = await import("../server/presence");
  const lt: TeamTemplate = { ...structuredClone(DEV_TEMPLATE_V1), flow: { stages: [
    { id: "spec", name: "Spec", roleIds: ["lead", "developer"], gates: [{ id: "spec-ok", kind: "spec-approved" }] },
    { id: "build", name: "Build", roleIds: ["developer"], gates: [] },
  ] } };
  const t8: Task = { ...task, id: "T8", stageId: "spec", status: "in-progress", ownerId: "dev1" };
  savePlanTables(db, "p", { ...plan, tasks: [t8] }, "spec");
  const snap = { config: { template: lt, project: { id: "p" }, workflow: { mode: "deliverables", review: { enabled: false } }, team: [{ id: "lead", name: "Lea", roleId: "lead", isLead: true }, { id: "dev1", name: "Dev", roleId: "developer" }] }, boards: plan.boards, tasks: [t8], agents: [], messages: [], pullRequests: [], actionItems: [] };
  const told: { to: string; text: string }[] = [];
  const hub = { slug: "gates-undo", snap, emit: () => {}, planChanged: () => {}, activity: () => {}, name: (id: string) => snap.config.team.find((a) => a.id === id)?.name ?? id, setStatus: () => {}, status: () => null, cfg: (id: string) => snap.config.team.find((a) => a.id === id), repo: { root: process.env.HOME } };
  const planner = new Planner(hub as never, { push: (to: string, i: { text: string }) => told.push({ to, text: i.text }), save: () => {} } as never);
  const items = new ActionItems(hub as never, planner);
  planner.onLeadApproval = (task, gateId, stageId, note) => items.addApproval("lead", task.id, task.title, gateId, stageId, note);
  check("the lead can't approve with the owner just seen", throws(() => planner.recordGate("T8", "spec-ok", "passed", "lead"), /after 2 h/));
  presence.ownerSeen(0); // no-op: seen can only move forward
  const realNow = Date.now;
  Date.now = () => realNow() + presence.AWAY_MS + 1000; // 2 h later, no owner action
  planner.recordGate("T8", "spec-ok", "passed", "lead", { note: "spec is complete" });
  const item = snap.actionItems.find((i: { kind?: string }) => i.kind === "approval") as { id: string; title: string; approval: { stageId: string } } | undefined;
  check("a lead approval files a Keep / Undo item", !!item && /approved spec-ok on T8 while you were away/.test(item.title) && item.approval.stageId === "spec", JSON.stringify(item));
  planner.updateTask("T8", { stageId: "build" }, "lead");
  check("the approved spec lets the task move on", t8.stageId === "build");
  Date.now = realNow;
  items.resolve(item!.id, "dismissed", "the spec misses the rate limit");
  const evs = gateEvents(db, "p", "T8");
  check("Undo keeps the history and adds a reset row", evs.length === 2 && evs[0].state === "passed" && evs[1].state === "reset" && evs[1].by.kind === "user");
  check("…the task is back in the spec stage", t8.stageId === "spec");
  check("…and the lead and the task's owner are told", told.some((m) => m.to === "lead" && /undid your approval/.test(m.text) && /rate limit/.test(m.text)) && told.some((m) => m.to === "dev1" && /undid the lead's approval/.test(m.text)), JSON.stringify(told));
  check("the gate waits for the owner again", throws(() => planner.updateTask("T8", { stageId: "build" }, "lead"), /spec/));
}

// Specs through the planner: write_spec, analyze over the board's tasks, the brief's spec, and a rewrite resets approval.
{
  const st: TeamTemplate = { ...structuredClone(DEV_TEMPLATE_V1), flow: { stages: [
    { id: "plan", name: "Plan", roleIds: ["lead", "developer"], gates: [{ id: "spec-ok", kind: "spec-approved" }, { id: "covered", kind: "analyze" }] },
    { id: "build", name: "Build", roleIds: ["developer"], gates: [] },
  ] } };
  const snap = { config: { template: st, project: { id: "spec-p" }, workflow: { mode: "deliverables", review: { enabled: false } }, team: [{ id: "lead", name: "Lea", roleId: "lead", isLead: true, cli: "claude" }, { id: "dev1", name: "Dev", roleId: "developer", cli: "claude" }] }, boards: [{ id: "B1", title: "Backlog", status: "active" as const, order: 0 }], tasks: [] as Task[], agents: [], messages: [], pullRequests: [] };
  const hub = { slug: "spec-p", snap, emit: () => {}, planChanged: () => {}, activity: () => {}, name: (id: string) => id, setStatus: () => {}, status: () => null, cfg: (id: string) => snap.config.team.find((a) => a.id === id), repo: { root: process.env.HOME } };
  const planner = new Planner(hub as never, { push: () => {}, save: () => {} } as never);
  const spec = planner.writeSpec(undefined, "# Sign-in\nS1. Email and password sign-in.\nS2. Lock the account after 5 failed tries.\nS3. Rate limit by IP.", "lead");
  check("write_spec saves a version with its items", spec.version === 1 && spec.items.join() === "S1,S2,S3");
  const a = planner.createTask({ title: "Sign-in form", specItems: ["s1", "S2", "bogus"] } as never, "lead");
  check("a task's spec items are cleaned", a.specItems?.join() === "S1,S2", JSON.stringify(a.specItems));
  const sync = () => savePlanTables(hqDb(), "spec-p", { boards: snap.boards, tasks: snap.tasks }, "plan");
  sync();
  planner.recordGate(a.id, "spec-ok", "passed", "you");
  check("analyze names what no task covers", throws(() => planner.updateTask(a.id, { stageId: "build" }, "lead"), /No task covers S3/));
  const b = planner.createTask({ title: "Rate limit", specItems: ["S3"] } as never, "lead");
  sync();
  planner.updateTask(a.id, { stageId: "build" }, "lead");
  check("with every item covered and the spec approved, the task moves on", a.stageId === "build");
  const brief = planner.specFor(b);
  check("the brief carries the items the task covers", /S3\. Rate limit by IP/.test(brief) && !/S1\./.test(brief), brief);
  planner.writeSpec("B1", "S1. Email sign-in.\nS2. Lockout.\nS3. Rate limit.\nS4. Audit log.", "lead");
  const evs = gateEvents(hqDb(), "spec-p", a.id);
  check("a new spec version resets the approval of open tasks", evs.at(-1)?.state === "reset" && evs.at(-1)?.gateId === "spec-ok", JSON.stringify(evs.map((e) => e.state)));
  check("…and nobody else's", gateEvents(hqDb(), "spec-p", b.id).length === 0);
}

// Scope before start (3.4): an unscoped red seat can't start; the lead can; lab mode lifts it.
{
  const { scopeBlocksStart } = await import("../server/scope");
  const red = { rules: { scopeRequired: true, labMode: false }, project: { scope: { inScope: [], outOfScope: [], rules: "" } } };
  check("an unscoped red agent can't start", /Set the engagement scope first/.test(scopeBlocksStart(red, { isLead: false }) ?? ""));
  check("the lead can, to plan the scope", scopeBlocksStart(red, { isLead: true }) === null);
  check("lab mode lifts it", scopeBlocksStart({ ...red, rules: { scopeRequired: true, labMode: true } }, { isLead: false }) === null);
  check("a scope lifts it", scopeBlocksStart({ ...red, project: { scope: { inScope: ["10.0.0.0/24"], outOfScope: [], rules: "" } } }, { isLead: false }) === null);
  check("dev projects never need one", scopeBlocksStart({ ...red, rules: { scopeRequired: false, labMode: false } }, { isLead: false }) === null);
}

// Dev v2 (Phase 4 step 3): spec → plan → build, the board's spec approved once, the second opinion asked for.
{
  const { DEV_TEMPLATE } = await import("../src/data/templates");
  const { ActionItems } = await import("../server/actionItems");
  const { vendorOf } = await import("../server/planStore");
  const { securityReviewWorkflow } = await import("../src/data/githubApp");
  const t = structuredClone(DEV_TEMPLATE);
  check("Dev v2 runs spec → plan → build → review → merge", t.version === 2 && t.flow.stages.map((x) => x.id).join() === "spec,plan,build,review,merge");
  const team = [
    { id: "lea", name: "Lea", roleId: "lead", isLead: true, cli: "claude", model: "claude-opus-5-5" },
    { id: "d1", name: "Dev", roleId: "developer", isLead: false, cli: "claude", model: "claude-sonnet-5-5" },
    { id: "nyx", name: "Nyx", roleId: "reviewer", isLead: false, cli: "codex", model: "gpt-6.1-sol" },
    { id: "gem", name: "Gem", roleId: "second-opinion", isLead: false, cli: "agy", model: "gemini-4-argon-high" },
  ];
  const st = new Map(team.map((a) => [a.id, { agentId: a.id, currentTaskId: null, session: { state: "stopped" } } as Record<string, unknown>]));
  const snap = { config: { template: t, project: { id: "dev2" }, workflow: { mode: "github-pr", review: { enabled: true } }, team }, boards: [{ id: "B1", title: "Backlog", status: "active" as const, order: 0 }], tasks: [] as Task[], agents: [], messages: [], pullRequests: [] as PullRequest[], actionItems: [] };
  const hub = { slug: "dev2", snap, emit: () => {}, planChanged: () => {}, activity: () => {}, configChanged: () => {}, name: (id: string) => team.find((a) => a.id === id)?.name ?? id, setStatus: (id: string, p: object) => Object.assign(st.get(id)!, p), status: (id: string) => st.get(id), cfg: (id: string) => team.find((a) => a.id === id), repo: { root: process.env.HOME } };
  const told: { to: string; text: string }[] = [];
  const planner = new Planner(hub as never, { push: (to: string, i: { text: string }) => told.push({ to, text: i.text }), save: () => {} } as never);
  const items = new ActionItems(hub as never, planner);
  planner.actions = items;
  const ready: string[] = [];
  planner.onReady = (id) => ready.push(id);
  const sync = () => savePlanTables(hqDb(), "dev2", { boards: snap.boards, tasks: snap.tasks }, "spec");

  const a = planner.createTask({ title: "Checkout", doneWhen: "x", files: ["app/checkout.ts"] } as never, "lea");
  sync();
  check("a new task starts in Spec", a.stageId === "spec");
  check("without a spec, the developer can't take it", throws(() => planner.assign(a.id, "developer", "lea"), /reach the Build stage.*no spec yet/));
  planner.writeSpec("B1", "S1. Card checkout.\nS2. Receipt email.", "lea");
  const specItem = snap.actionItems.find((i: { kind?: string }) => i.kind === "spec") as { id: string; title: string; spec: { version: number } } | undefined;
  check("writing the spec asks the owner to approve it, once for the board", !!specItem && /Approve the spec for Backlog \(v1\)/.test(specItem.title));
  check("before approval, still no", throws(() => planner.assign(a.id, "developer", "lea"), /approve the board's spec/));
  items.resolve(specItem!.id, "done");
  check("approved: the lead is told", told.some((m) => m.to === "lea" && /approved the spec for B1 \(v1\)/.test(m.text)));
  check("…but a task can't reach Build until every spec item has a task", throws(() => planner.assign(a.id, "developer", "lea"), /No task covers S1, S2/));
  planner.updateTask(a.id, { specItems: ["S1", "S2"] }, "lea");
  sync();
  planner.assign(a.id, "developer", "lea");
  check("covered and approved: assigning moves it through Plan into Build", a.stageId === "build" && a.ownerId === "d1" && ready.includes("d1"), `${a.stageId} ${a.ownerId}`);
  check("the reviewer can't take a task in Build", throws(() => planner.assign(a.id, "nyx", "lea"), /Build stage, where only developer seats work/));

  planner.writeSpec("B1", "S1. Card checkout.\nS2. Receipt email.\nS3. Refunds?", "lea");
  planner.writeSpec("B1", "S1. Card checkout.\nS2. Receipt email.\nS3. Refunds.", "lea");
  const specs = snap.actionItems.filter((i: { kind?: string }) => i.kind === "spec") as { status: string; note: string | null }[];
  check("a new spec version needs its own approval, and replaces a request still open", specs.length === 3 && specs.filter((i) => i.status === "open").length === 1 && specs.some((i) => i.status === "dismissed" && /Replaced by v3/.test(i.note ?? "")), JSON.stringify(specs.map((i) => [i.status, i.note])));
  const b = planner.createTask({ title: "Refunds", doneWhen: "x", specItems: ["S3"] } as never, "lea");
  sync();
  check("…so new tasks wait for it", throws(() => planner.assign(b.id, "developer", "lea"), /approve the board's spec/));
  check("an old version can't be approved any more", planner.approveBoardSpec("B1", 2, "you") === false);

  // The second opinion, from another maker's model.
  check("a seat's maker comes from its model first", vendorOf("agy", "gemini-4-argon-high") === "google" && vendorOf("agy", "claude-sonnet-5-5-high") === "anthropic" && vendorOf("opencode", "openai/gpt-5.4") === "openai" && vendorOf("codex", "") === "openai");
  st.get("d1")!.currentTaskId = a.id;
  const n = told.length;
  planner.setStatus("d1", "in-review", "PR open", 5);
  check("an ordinary task in review gets no second-opinion request", !told.slice(n).some((m) => m.to === "gem"));
  const c = planner.createTask({ title: "Login rate limit", doneWhen: "x", files: ["server/auth.ts"], specItems: ["S3"] } as never, "lea");
  c.stageId = "build";
  c.ownerId = "d1";
  c.status = "in-progress";
  sync();
  st.get("d1")!.currentTaskId = c.id;
  ready.length = 0;
  planner.setStatus("d1", "in-review", "PR open", 6);
  const ask = told.filter((m) => m.to === "gem");
  check("a high-stakes task in review: HQ asks the Gemini seat and starts it", ask.length === 1 && new RegExp(`second opinion on ${c.id} \\(PR #6\\)`).test(ask[0].text) && ready.includes("gem"), JSON.stringify(ask));
  planner.updateTask(c.id, { status: "in-review" }, "lea");
  check("…once per task", told.filter((m) => m.to === "gem").length === 1);

  const yaml = securityReviewWorkflow();
  const { vettedPacks } = await import("../server/skillPacks");
  check("the offered security-review workflow is pinned to the vetted commit", yaml.includes(`anthropics/claude-code-security-review@${vettedPacks()["anthropics/claude-code-security-review"].commit}`) && /actions\/checkout@[0-9a-f]{40}/.test(yaml) && /CLAUDE_API_KEY/.test(yaml));
}

// Security templates (Phase 4 step 4): Red, Purple, Blue.
{
  const { SECURITY_RED_TEMPLATE: red, SECURITY_PURPLE_TEMPLATE: purple, SECURITY_BLUE_TEMPLATE: blue } = await import("../src/data/securityTemplates");
  const { templateErrors } = await import("../src/data/model");
  const { vettedPacks } = await import("../server/skillPacks");
  const { findBuiltinSkill } = await import("../src/data/skillCatalog");
  const all = [red, purple, blue];
  check("the three security templates are valid", all.every((t) => templateErrors(t).length === 0), JSON.stringify(all.map((t) => templateErrors(t))));
  check("all need a scope, plans before changes, findings, and no outbound", all.every((t) => t.rules.scopeRequired && t.rules.plans && t.rules.findings && !t.rules.labMode && t.rules.outbound === "none"));
  check("PTES stages for Red; Purple adds Detect after Exploitation; Blue follows NIST 800-61", red.flow.stages.map((x) => x.id).join() === "scope,recon,threat,vuln,exploit,post,report" && purple.flow.stages.map((x) => x.id).join() === "scope,recon,threat,vuln,exploit,detect,post,report" && blue.flow.stages.map((x) => x.id).join() === "prepare,analyse,contain,recover,lessons");
  const skills = all.flatMap((t) => t.roles.flatMap((r) => r.skills.map((sk) => ({ t: t.id, sk }))));
  const missing = skills.filter(({ sk }) => {
    const m = sk.match(/^([^@]+)@(.+)$/);
    return m ? !vettedPacks()[m[1]]?.skills[m[2]] : !findBuiltinSkill(sk);
  });
  check("every skill they name is a built-in or pinned in a vetted pack", missing.length === 0, JSON.stringify(missing));
  check("offensive BugHunter skills only in Red and Purple", !blue.roles.some((r) => r.skills.some((sk) => sk.startsWith("elementalsouls/"))) && red.roles.some((r) => r.skills.some((sk) => sk.startsWith("elementalsouls/"))));
  check("the report needs a second opinion from a Gemini seat", all.every((t) => t.flow.stages.at(-1)!.gates.some((g) => g.kind === "second-opinion" && g.when === "always") && t.roles.some((r) => r.id === "second-opinion" && r.cli === "agy")));
  check("Blue's containment waits for the owner", blue.flow.stages.find((x) => x.id === "contain")!.gates.some((g) => g.kind === "owner-approval" && g.reason === "containment"));
  check("memory types", red.memoryTypes.join() === "Asset,Finding,Technique" && purple.memoryTypes.includes("Detection") && blue.memoryTypes.join() === "Incident,Asset");

  // In the planner: a Red task in its phase needs the scope; Purple's Detect needs the defender.
  const team = [
    { id: "lea", name: "Lea", roleId: "lead", isLead: true, cli: "claude", model: "claude-opus-5-5" },
    { id: "rec", name: "Rec", roleId: "recon", isLead: false, cli: "agy", model: "gemini-4-argon-high" },
    { id: "x1", name: "X1", roleId: "exploit", isLead: false, cli: "claude", model: "claude-sonnet-5-5" },
    { id: "def", name: "Def", roleId: "defender", isLead: false, cli: "claude", model: "claude-sonnet-5-5" },
    { id: "gem", name: "Gem", roleId: "second-opinion", isLead: false, cli: "agy", model: "gemini-4-argon-high" },
  ];
  const project = { id: "purple", scope: { inScope: [] as string[], outOfScope: [], rules: "" } };
  const snap = { config: { template: structuredClone(purple), project, workflow: { mode: "deliverables", review: { enabled: false } }, team, rules: purple.rules }, boards: [{ id: "B1", title: "Engagement", status: "active" as const, order: 0 }], tasks: [] as Task[], agents: [], messages: [], pullRequests: [], actionItems: [] };
  const hub = { slug: "purple", snap, emit: () => {}, planChanged: () => {}, activity: () => {}, configChanged: () => {}, name: (id: string) => id, setStatus: () => {}, status: () => ({ session: { state: "stopped" } }), cfg: (id: string) => team.find((a) => a.id === id), repo: { root: process.env.HOME } };
  const planner = new Planner(hub as never, { push: () => {}, save: () => {} } as never);
  check("without a scope, a task can't start in Recon", throws(() => planner.createTask({ title: "Map hosts", stageId: "recon" } as never, "lea"), /scope/i) && snap.tasks.length === 0);
  project.scope.inScope.push("10.20.0.0/24");
  const r = planner.createTask({ title: "Map hosts", stageId: "recon", doneWhen: "x" } as never, "lea");
  check("with a scope, it starts in its phase", r.stageId === "recon");
  const e = planner.createTask({ title: "Exploit the login", stageId: "exploit", doneWhen: "x" } as never, "lea");
  savePlanTables(hqDb(), "purple", { boards: snap.boards, tasks: snap.tasks }, "scope");
  planner.assign(e.id, "exploit", "lea");
  check("an exploit task goes to an exploit seat", e.ownerId === "x1");
  check("leaving Exploitation needs the defender's check (Detect)", throws(() => planner.updateTask(e.id, { stageId: "post" }, "lea"), /defender must accept/));

  // The report: critical and high findings verified by a person or another maker's model.
  const severeGate: Gate = { id: "report", kind: "findings-report" };
  const vendorOf = (id: string) => ({ x1: "anthropic", def: "anthropic", gem: "google" })[id] ?? null;
  const roleOf = (id: string) => ({ x1: "exploit", def: "defender", gem: "second-opinion" })[id] ?? null;
  const base = { reportAt: 2000, findingsAt: 1000, vendorOf, roleOf };
  check("an unverified high finding holds the report", /F-1/.test(gateProblem(severeGate, ctx({ ...base, severe: [{ id: "F-1", reporterId: "x1", verifiedBy: null }] })) ?? ""));
  check("…so does one its own reporter verified", !met(severeGate, ctx({ ...base, severe: [{ id: "F-1", reporterId: "x1", verifiedBy: "x1" }] })));
  check("…or one a model from the same maker verified", !met(severeGate, ctx({ ...base, severe: [{ id: "F-1", reporterId: "x1", verifiedBy: "def" }] })));
  check("verified by the Gemini seat or a person, it passes", met(severeGate, ctx({ ...base, severe: [{ id: "F-1", reporterId: "x1", verifiedBy: "gem" }, { id: "F-2", reporterId: "x1", verifiedBy: "you" }] })));
}

// Research template (Phase 4 step 5).
{
  const { RESEARCH_TEMPLATE: res } = await import("../src/data/researchTemplate");
  const { BUILTIN_TEMPLATES } = await import("../src/data/templates");
  const { templateErrors } = await import("../src/data/model");
  const { vendorOf: makerOf } = await import("../server/planStore");
  const { findBuiltinSkill } = await import("../src/data/skillCatalog");
  const { hostAllowed } = await import("../server/containers");
  check("the Research template is valid and offered", templateErrors(res).length === 0 && BUILTIN_TEMPLATES.some((t) => t.id === "research"), JSON.stringify(templateErrors(res)));
  check("Sources → Claims → Fact-check → Report, files not PRs", res.flow.stages.map((x) => x.id).join() === "sources,claims,factcheck,report" && !res.flow.stages.some((x) => x.gates.some((g) => g.kind === "pr-merged")));
  check("every skill it names is a built-in, paper-search among them", res.roles.every((r) => r.skills.every((sk) => !!findBuiltinSkill(sk))) && !!findBuiltinSkill("paper-search"));
  const maker = (id: string) => { const r = res.roles.find((x) => x.id === id)!; return makerOf(r.cli, r.model); };
  check("researchers, fact-checker and second opinion are three makers", new Set([maker("researcher"), maker("fact-checker"), maker("second-opinion")]).size === 3, [maker("researcher"), maker("fact-checker"), maker("second-opinion")].join());
  check("the paper APIs are on the egress allowlist, other hosts aren't", ["export.arxiv.org", "api.openalex.org", "api.crossref.org", "doi.org"].every((h) => hostAllowed(res.rules.egress, h, 443)) && !hostAllowed(res.rules.egress, "example.com", 443));
  check("no findings, plans, scope or outbound", !res.rules.findings && !res.rules.plans && !res.rules.scopeRequired && res.rules.outbound === "none" && res.memoryTypes.join() === "Source,Claim");

  const fc = res.flow.stages.find((x) => x.id === "factcheck")!.gates[0];
  const roleOf = (id: string) => ({ r1: "researcher", r2: "researcher", fc: "fact-checker", lead: "lead", so: "second-opinion" })[id] ?? null;
  const t = { ...task, ownerId: "r1" };
  check("a claims task leaves Fact-check only when the fact-checker accepts it", !met(fc, ctx({ task: t, roleOf, actor: agent("r2") })) && !met(fc, ctx({ task: t, roleOf, actor: agent("lead") })) && met(fc, ctx({ task: t, roleOf, actor: agent("fc") })));
  const so = res.flow.stages.at(-1)!.gates.find((g) => g.kind === "second-opinion")!;
  const vendorOf = (id: string) => ({ lead: "anthropic", fc: "anthropic", so: "openai" })[id] ?? null;
  const signed = (by: string) => [{ taskId: t.id, gateId: so.id, state: "passed", by: agent(by), at: "" }] as never;
  const lt = { ...task, ownerId: "lead" };
  check("the lead's report needs the second opinion from another maker", !met(so, ctx({ task: lt, roleOf, vendorOf, events: [] })) && !met(so, ctx({ task: lt, roleOf, vendorOf, events: signed("fc") })) && met(so, ctx({ task: lt, roleOf, vendorOf, events: signed("so") })));
}

if (fails) {
  console.error(`\n${fails} failed`);
  process.exit(1);
}
console.log("\nall passed");
