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
const { DEV_TEMPLATE } = await import("../src/data/templates");
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

for (const kind of ["tests-ci", "analyze", "second-opinion", "findings-report"] as const) {
  const g = { id: "g", kind } as Gate;
  check(`${kind}: fails without evidence`, !met(g));
  check(`${kind}: passes with a recorded pass`, met(g, ctx({ events: [ev("g", "passed", agent("rev"))] })));
  check(`${kind}: a later failure wins`, !met(g, ctx({ events: [ev("g", "passed", agent("rev")), ev("g", "failed", agent("rev"))] })));
  check(`${kind}: a reset undoes a pass`, !met(g, ctx({ events: [ev("g", "passed", agent("rev")), ev("g", "reset", you)] })));
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
check("a move lists every unmet gate it needs", throws(() => assertGates(flow, null, ctx()), /tests and CI.*merged/));
check("a move with its gates met goes through", !throws(() => assertGates(flow, "review", ctx({ events: [ev("tests", "passed", agent("rev"))] })), /./));

// Storage and who may record evidence.
const db = hqDb();
const plan = { boards: [{ id: "B1", title: "Backlog", status: "active" as const, order: 0 }], tasks: [{ ...task, stageId: "build" }] };
savePlanTables(db, "p", plan, "build");
const loaded = loadPlanTables(db, "p");
check("a plan round-trips through the tables", loaded?.tasks[0].stageId === "build" && loaded.tasks[0].prNumber === 7 && loaded.tasks[0].deliverablePath === "out.md");
const t: TeamTemplate = { ...structuredClone(DEV_TEMPLATE), flow };
recordGate(db, t, task, { projectId: "p", gateId: "tests", state: "passed", by: agent("rev"), proof: { note: "CI green" } });
check("recorded evidence is read back", gateEvents(db, "p", "T1").at(-1)?.proof.note === "CI green");
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
    config: { template: DEV_TEMPLATE, project: { id: "plan" }, workflow: { mode: "github-pr", review: { enabled: true } }, team: [{ id: "lead", roleId: "lead", isLead: true }, { id: "dev1", roleId: "developer" }] },
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
  const lt: TeamTemplate = { ...structuredClone(DEV_TEMPLATE), flow: { stages: [
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
  check("the gate waits for the owner again", throws(() => planner.updateTask("T8", { stageId: "build" }, "lead"), /approve the spec/));
}

if (fails) {
  console.error(`\n${fails} failed`);
  process.exit(1);
}
console.log("\nall passed");
