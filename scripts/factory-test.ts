// The factory's data (docs/factory.md sections 2-3): template version on tasks, task status history, the owner's answers.
// Run: npx tsx scripts/factory-test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "hq-factory-"));
const { Planner } = await import("../server/planner");
const { ActionItems } = await import("../server/actionItems");
const { BLANK_TEMPLATE } = await import("../src/data/templates");
const { hqDb } = await import("../server/lib/db");
const { loadPlanTables, savePlanTables } = await import("../server/planStore");

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};

const db = hqDb();
const project = "factory-test";
const team = [{ id: "lea", name: "Lea", roleId: "lead", isLead: true, cli: "codex", model: "" }];
const snap = { config: { team, template: { ...BLANK_TEMPLATE, version: 3 }, workflow: { mode: "deliverables", review: { enabled: false } }, project: { id: project } }, boards: [], tasks: [], messages: [], agents: [] } as never as { config: { template: typeof BLANK_TEMPLATE }; tasks: { id: string; status: string }[]; boards: never[] };
const hub = {
  slug: project, repo: { root: "/nonexistent" }, snap,
  cfg: (id: string) => team.find((a) => a.id === id),
  name: (id: string) => team.find((a) => a.id === id)?.name ?? id,
  status: () => undefined, setStatus: () => {},
  emit: () => {}, planChanged: () => {}, configChanged: () => {}, activity: () => {},
};
const planner = new Planner(hub as never, { push: () => {}, save: () => {} } as never);
const first = BLANK_TEMPLATE.flow.stages[0].id;
const save = () => savePlanTables(db, project, snap as never, first);
const events = (id: string) => db.prepare("SELECT status, stage_id FROM task_events WHERE project_id = ? AND task_id = ? ORDER BY rowid").all(project, id) as { status: string; stage_id: string }[];

// Template version on every new task; a re-sync changes later tasks only.
const a = planner.createTask({ title: "Before the re-sync", doneWhen: "x" } as never, "lea");
check("a new task records its template and version", a.templateId === BLANK_TEMPLATE.id && a.templateVersion === 3);
save();
snap.config.template = { ...BLANK_TEMPLATE, version: 4 }; // what resyncTemplate leaves in the snapshot
const b = planner.createTask({ title: "After the re-sync", doneWhen: "x" } as never, "lea");
a.templateVersion = 99; // a task's version is set once, never rewritten by a later save
save();
const loaded = loadPlanTables(db, project)!;
check("a re-sync shows two versions on one board", loaded.tasks.map((t) => t.templateVersion).join() === "3,4" && new Set(loaded.tasks.map((t) => t.boardId)).size === 1, JSON.stringify(loaded.tasks.map((t) => [t.id, t.templateVersion])));
check("older tasks keep an empty version", (() => {
  db.prepare("UPDATE tasks SET template_id = NULL, template_version = NULL WHERE project_id = ? AND id = ?").run(project, b.id);
  const t = loadPlanTables(db, project)!.tasks.find((x) => x.id === b.id)!;
  return t.templateId === undefined && t.templateVersion === undefined;
})());

// Status history: one row when a task first appears, one per status or stage change, none for other edits.
check("a new task gets one history row", events(a.id).length === 1 && events(a.id)[0].status === "todo");
a.status = "in-progress";
save();
(a as { title: string }).title = "Renamed";
save();
a.status = "done";
save();
check("each status change is recorded once, other edits aren't", events(a.id).map((e) => e.status).join() === "todo,in-progress,done", JSON.stringify(events(a.id)));

// The owner's answers to Action items land in SQLite; the items stay in their JSON document.
const items = new ActionItems(hub as never, { currentTask: () => null, notify: () => {} } as never);
const ask = items.add("lea", "Create the database", "", true);
items.resolve(ask.id, "dismissed");
items.resolve(ask.id, "done"); // already closed: ignored
const answers = db.prepare("SELECT kind, decision FROM action_answers WHERE project_id = ?").all(project) as { kind: string; decision: string }[];
check("an answer is kept with its kind and decision, once", answers.length === 1 && answers[0].kind === "request" && answers[0].decision === "dismissed", JSON.stringify(answers));

// Metrics (section 3): a seeded project, every number checked against a hand count.
{
  const { factoryMetrics, metricsReport } = await import("../server/metrics");
  const P = "metrics-test";
  const H = 3_600_000;
  const T0 = Date.UTC(2026, 10, 10);
  db.prepare("INSERT INTO boards (project_id, id, title, status, ord) VALUES (?, 'B', 'Board', 'active', 0)").run(P);
  const task = (id: string, status: string, pr: number | null, version: number | null) =>
    db.prepare("INSERT INTO tasks (project_id, id, board_id, stage_id, title, status, updated_at, pr_number, template_id, template_version) VALUES (?, ?, 'B', 'build', ?, ?, 0, ?, ?, ?)").run(P, id, id, status, pr, version === null ? null : "dev", version);
  const ev = (id: string, status: string, at: number) => db.prepare("INSERT INTO task_events (project_id, task_id, at, status, stage_id, owner_id) VALUES (?, ?, ?, ?, 'build', NULL)").run(P, id, at, status);
  const use = (id: string | null, tokens: number, usd: number | null) =>
    db.prepare("INSERT INTO usage_events (at, project_id, task_id, agent_id, source, account, provider, cli, model, input, cached, output, cost_usd) VALUES (?, ?, ?, 'lea', 'agent', 'a', 'anthropic', 'claude', 'm', ?, 50, ?, ?)").run(T0, P, id, tokens / 2, tokens / 2, usd);
  const gate = (id: string, state: string, by: "agent" | "user", at: number) =>
    db.prepare("INSERT INTO gate_events (project_id, task_id, gate_id, state, by_kind, by_id, proof, at) VALUES (?, ?, 'g', ?, ?, ?, '{}', ?)").run(P, id, state, by, by === "user" ? "you" : "lea", at);
  const led = (kind: string, at: number) => db.prepare("INSERT INTO ledger (project_id, task_id, ledger, kind, text, by, at) VALUES (?, NULL, 'progress', ?, 'x', 'lea', ?)").run(P, kind, at);

  // A: v1, created T0, started +2h, done +10h, a PR, 1000 tokens $2, two failed gates.
  task("A", "done", 7, 1); ev("A", "todo", T0); ev("A", "in-progress", T0 + 2 * H); ev("A", "done", T0 + 10 * H);
  use("A", 600, 1.5); use("A", 400, 0.5); gate("A", "failed", "agent", T0 + 5 * H); gate("A", "failed", "agent", T0 + 6 * H); gate("A", "passed", "user", T0 + 9 * H);
  // B: v2, created T0, started +1h, done +5h, no PR, 3000 tokens unpriced.
  task("B", "done", null, 2); ev("B", "todo", T0); ev("B", "in-progress", T0 + H); ev("B", "done", T0 + 5 * H); use("B", 3000, null);
  // C: older than the history (no version): finished, but its cycle time is unknown. 2000 tokens $1.
  task("C", "done", 9, null); ev("C", "done", T0 + 3 * H); use("C", 2000, 1);
  // D: done before the window; E: still in progress. Neither counts.
  task("D", "done", null, 1); ev("D", "todo", T0 - 50 * H); ev("D", "done", T0 - 40 * H); use("D", 99999, 50);
  task("E", "in-progress", null, 2); ev("E", "todo", T0); ev("E", "in-progress", T0 + H); gate("E", "failed", "agent", T0 + 2 * H);
  use(null, 777, 3); // helper runs with no task
  led("stall", T0 + H); led("stall", T0 + 2 * H); led("replan", T0 + 3 * H); led("stall", T0 - 30 * H);
  db.prepare("INSERT INTO action_answers (project_id, id, kind, decision, at) VALUES (?, 'x1', 'gate', 'done', ?), (?, 'x2', 'plan', 'dismissed', ?)").run(P, T0 + H, P, T0 - 30 * H);

  const w = { since: T0 - 24 * H + 1, until: T0 + 24 * H };
  const m = factoryMetrics(db, P, w, [T0 + 4 * H, T0 - 40 * H]);
  check("finished tasks and merged PRs in the window", m.finished === 3 && m.merged === 2, JSON.stringify(m));
  check("cost per finished task: tokens always, dollars where priced", m.costPerTask!.tokens === 2000 && m.costPerTask!.usd === 1, JSON.stringify(m.costPerTask));
  check("cost per merged PR", m.costPerPr!.tokens === 1500 && m.costPerPr!.usd === 1.5, JSON.stringify(m.costPerPr));
  check("cycle time: medians, and tasks without history are unknown, not guessed", m.cycle.created === 7.5 * H && m.cycle.started === 6 * H && m.cycle.unknown === 1, JSON.stringify(m.cycle));
  check("rework: failed gates on the finished tasks", m.rework.failed === 2 && m.rework.perTask === 2 / 3, JSON.stringify(m.rework));
  check("stalls and replans in the window", m.stalls === 2 && m.replans === 1);
  check("owner interventions: gates, answers and messages in the window", JSON.stringify(m.interventions) === JSON.stringify({ gates: 1, answers: 1, messages: 1, total: 3 }), JSON.stringify(m.interventions));
  const r = metricsReport(db, P, 2, [], T0 + 24 * H);
  check("the report compares with the window before it", r.now.finished === 3 && r.before.finished === 1 && r.before.stalls === 1, JSON.stringify([r.now.finished, r.before.finished, r.before.stalls]));
  check("versions are compared side by side", JSON.stringify(r.versions.map((v) => [v.version, v.finished, v.costPerTask?.tokens, v.cycleCreated, v.reworkPerTask])) === JSON.stringify([[1, 2, 50499.5, 10 * H, 1], [2, 1, 3000, 5 * H, 0]]), JSON.stringify(r.versions));
  const empty = factoryMetrics(db, "nothing-here", w);
  check("an empty project has nothing, not zeros pretending to be numbers", empty.finished === 0 && empty.costPerTask === null && empty.cycle.created === null && empty.rework.perTask === null);
}

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
