// Team template validation: every rule in templateErrors, and dependency loops.
// Run: npx tsx scripts/model-test.ts
import { needsCycle, type TeamTemplate, templateErrors } from "../src/data/model";

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};

const valid = (): TeamTemplate => ({
  id: "dev",
  version: 1,
  name: "Dev team",
  description: "",
  roles: [
    { id: "lead", title: "Lead", isLead: true, roleMd: "", cli: "claude", model: "", fallback: null, skills: [], onDemand: false, seats: 1, color: "#4f8cff" },
    { id: "developer", title: "Developer", isLead: false, roleMd: "", cli: "claude", model: "", fallback: { cli: "codex", model: "" }, skills: [], onDemand: true, seats: 2, color: "#22aa66" },
  ],
  flow: {
    stages: [
      { id: "implement", name: "Implement", roleIds: ["developer"], gates: [{ id: "tests", kind: "tests-ci" }] },
      { id: "review", name: "Review", roleIds: ["lead"], gates: [{ id: "merged", kind: "pr-merged" }, { id: "review", kind: "reviewer", roleId: "lead" }] },
    ],
  },
  starter: {
    boards: [{ id: "B1", title: "Backlog", status: "active", order: 0 }],
    tasks: [
      { id: "T1", boardId: "B1", stageId: "implement", title: "First", description: "", doneWhen: "", needs: [] },
      { id: "T2", boardId: "B1", stageId: "implement", title: "Second", description: "", doneWhen: "", needs: ["T1"] },
    ],
  },
  rules: { findings: false, plans: false, scopeRequired: false, labMode: false, outbound: "none", egress: [] },
  memoryTypes: ["Asset"],
});

/** Applies a change to a fresh valid template and returns its errors. */
const errorsAfter = (change: (t: TeamTemplate) => void) => {
  const t = valid();
  change(t);
  return templateErrors(t);
};
const rejects = (name: string, change: (t: TeamTemplate) => void, mention: RegExp) => {
  const errs = errorsAfter(change);
  check(name, errs.some((e) => mention.test(e)), errs.join(" | ") || "no errors");
};

check("a valid template has no errors", templateErrors(valid()).length === 0, templateErrors(valid()).join(" | "));

rejects("no lead", (t) => (t.roles[0].isLead = false), /exactly one lead/);
rejects("two leads", (t) => (t.roles[1].isLead = true), /exactly one lead/);
rejects("an on-demand lead", (t) => (t.roles[0].onDemand = true), /can't be on demand/);
rejects("a lead with two seats", (t) => (t.roles[0].seats = 2), /exactly one seat/);
rejects("duplicate role ids", (t) => (t.roles[1].id = "lead"), /Two roles share/);
rejects("an unknown CLI", (t) => ((t.roles[1] as { cli: string }).cli = "cursor"), /not a CLI/);
rejects("an unknown fallback CLI", (t) => (t.roles[1].fallback = { cli: "cursor" as never, model: "" }), /fallback/);
rejects("negative seats", (t) => (t.roles[1].seats = -1), /seats/);
rejects("a bad colour", (t) => (t.roles[1].color = "blue"), /colour/);
rejects("an unknown role in a stage", (t) => t.flow.stages[0].roleIds.push("designer"), /no role "designer"/);
rejects("a stage with no roles", (t) => (t.flow.stages[0].roleIds = []), /name the roles/);
rejects("duplicate stage ids", (t) => (t.flow.stages[1].id = "implement"), /Two stages share/);
rejects("duplicate gate ids across stages", (t) => (t.flow.stages[1].gates[0].id = "tests"), /Two gates share/);
rejects("an unknown gate kind", (t) => t.flow.stages[0].gates.push({ id: "x", kind: "vibes" } as never), /unknown gate kind/);
rejects("a reviewer gate naming no role", (t) => t.flow.stages[1].gates.push({ id: "r2", kind: "reviewer", roleId: "ghost" }), /reviewer gate/);
rejects("an owner approval with no reason", (t) => t.flow.stages[1].gates.push({ id: "ok", kind: "owner-approval" } as never), /needs a reason/);
rejects("a second opinion with a bad when", (t) => t.flow.stages[1].gates.push({ id: "so", kind: "second-opinion", when: "sometimes" } as never), /second opinion/);
rejects("an empty flow", (t) => (t.flow.stages = []), /at least one stage/);
rejects("scope required without a scope gate", (t) => (t.rules.scopeRequired = true), /scope-set gate/);
check("lab mode lifts the scope gate requirement", errorsAfter((t) => Object.assign(t.rules, { scopeRequired: true, labMode: true })).length === 0);
check("a scope gate satisfies scope required", errorsAfter((t) => {
  t.rules.scopeRequired = true;
  t.flow.stages[0].gates.push({ id: "scope", kind: "scope-set" });
}).length === 0);
rejects("an unknown outbound rule", (t) => ((t.rules as { outbound: string }).outbound = "send-all"), /Outbound/);
rejects("a starter task on a missing board", (t) => (t.starter.tasks[0].boardId = "B9"), /no board "B9"/);
rejects("a starter task in a missing stage", (t) => (t.starter.tasks[0].stageId = "ship"), /no stage "ship"/);
rejects("a starter task needing an unknown task", (t) => t.starter.tasks[0].needs.push("T7"), /unknown task "T7"/);
rejects("starter tasks in a loop", (t) => t.starter.tasks[0].needs.push("T2"), /loop: T1 → T2 → T1/);
rejects("a bad template id", (t) => (t.id = "Dev Team"), /Template id/);
rejects("version 0", (t) => (t.version = 0), /version/);
rejects("a duplicate memory type", (t) => t.memoryTypes.push("Asset"), /listed twice/);

check("no loop in a chain", needsCycle([{ id: "a", needs: ["b"] }, { id: "b", needs: [] }]) === null);
check("a task needing itself is a loop", needsCycle([{ id: "a", needs: ["a"] }])?.join(",") === "a,a");
check("a diamond is not a loop", needsCycle([
  { id: "a", needs: ["b", "c"] },
  { id: "b", needs: ["d"] },
  { id: "c", needs: ["d"] },
  { id: "d", needs: [] },
]) === null);

if (fails) {
  console.error(`\n${fails} failed`);
  process.exit(1);
}
console.log("\nall passed");
