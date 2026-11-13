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

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
