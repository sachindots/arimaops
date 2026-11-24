// Goals that tasks roll up to: progress and spend per goal, the lead links only to active goals, and a task's
// goal survives a save and load of the plan.
//
//   npx tsx scripts/goals-test.ts

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = process.env.USERPROFILE = mkdtempSync(join(tmpdir(), "arima-goals-"));
const { hqDb } = await import("../server/lib/db");
const { addGoal, assertGoal, goalLines, goalsOf, updateGoal } = await import("../server/goals");
const { loadPlanTables, savePlanTables } = await import("../server/planStore");

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};
const throws = (f: () => unknown, re: RegExp) => {
  try {
    f();
    return false;
  } catch (e) {
    return re.test((e as Error).message);
  }
};

const db = hqDb();
const g1 = addGoal(db, "p", { title: "  Launch the beta ", metric: "signups", target: "200" });
const g2 = addGoal(db, "p", { title: "Cut support load" });
check("goals get G1, G2 and trimmed titles", g1 === "G1" && g2 === "G2");
check("a goal needs a title", throws(() => addGoal(db, "p", { title: "  " }), /needs a title/));

const usage = db.prepare(
  `INSERT INTO usage_events (at, project_id, task_id, agent_id, source, account, provider, cli, model, input, cached, output, cost_usd)
   VALUES (0, 'p', ?, 'a', 'agent', 'k', 'anthropic', 'claude', 'm', 1, 0, 1, ?)`,
);
usage.run("T1", 1.25);
usage.run("T2", 0.5);
usage.run("T3", 9); // a task with no goal
usage.run("T2", null); // unpriced
const tasks = [
  { id: "T1", status: "done" as const, goalId: "G1" },
  { id: "T2", status: "in-progress" as const, goalId: "G1" },
  { id: "T3", status: "done" as const, goalId: null },
];
let goals = goalsOf(db, "p", tasks);
const beta = goals.find((g) => g.id === "G1")!;
check("progress counts the goal's tasks", beta.done === 1 && beta.total === 2, JSON.stringify(beta));
check("spend adds its tasks' priced usage only", Math.abs(beta.usd - 1.75) < 1e-9, String(beta.usd));
check("another project sees none", goalsOf(db, "q", tasks).length === 0);

updateGoal(db, "p", "G1", { current: "142" });
updateGoal(db, "p", "G2", { status: "dropped" });
goals = goalsOf(db, "p", tasks);
check("the lead's number is kept", goals[0].current === "142" && goalLines(goals)[0].includes("now 142"), goalLines(goals).join("|"));
check("dropped goals aren't listed for the lead", goalLines(goals).length === 1);
check("a bad status is refused", throws(() => updateGoal(db, "p", "G1", { status: "won" as never }), /Status is one of/));
check("tasks link only to an active goal", throws(() => assertGoal(db, "p", "G2"), /is dropped/) && throws(() => assertGoal(db, "p", "G9"), /No goal G9. Goals: G1/) && !throws(() => assertGoal(db, "p", "G1"), /./));

// A task's goal survives the plan's round trip through the database.
const board = { id: "B1", title: "Beta", status: "active" as const, order: 0 };
const task = { id: "B1-T01", boardId: "B1", title: "Signup page", ownerId: null, status: "todo" as const, needs: [], prNumber: null, goalId: "G1" };
savePlanTables(db, "p", { boards: [board], tasks: [task, { ...task, id: "B1-T02", goalId: null }] }, "build");
const loaded = loadPlanTables(db, "p")!;
check("goalId is saved and loaded", loaded.tasks[0].goalId === "G1" && loaded.tasks[1].goalId === undefined, JSON.stringify(loaded.tasks.map((t) => t.goalId)));

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
