// Task dependencies and messages to the human. Run: npx tsx scripts/planner-test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "hq-plan-"));
const { Planner } = await import("../server/planner");
const { BLANK_TEMPLATE } = await import("../src/data/templates");
const { hqDb } = await import("../server/lib/db");
const { Neo4jMemory } = await import("../server/memory");
// Review off, as this test had it: a task finishes once its file is delivered.
const template = { ...BLANK_TEMPLATE, flow: { stages: [{ ...BLANK_TEMPLATE.flow.stages[0], gates: [{ id: "delivered", kind: "file-delivered" as const }] }] } };

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};

const team = [
  { id: "cipher", name: "Cipher", roleId: "lead", isLead: true, cli: "codex", model: "" },
  { id: "nyx", name: "Nyx", roleId: "lead", isLead: false, cli: "codex", model: "" },
];
const statuses = new Map<string, Record<string, unknown>>(team.map((a) => [a.id, { agentId: a.id, currentTaskId: null, session: { state: "running" } }]));
const snap = { config: { team, template, workflow: { mode: "deliverables", review: { enabled: false } }, project: { id: "plan-test" } }, boards: [], tasks: [], messages: [], agents: [...statuses.values()] };
const hub = {
  slug: "t", repo: { root: "/nonexistent" }, snap,
  cfg: (id: string) => team.find((a) => a.id === id),
  name: (id: string) => team.find((a) => a.id === id)?.name ?? (id === "you" ? "You" : id),
  status: (id: string) => statuses.get(id),
  setStatus: (id: string, patch: Record<string, unknown>) => Object.assign(statuses.get(id)!, patch),
  emit: () => {}, planChanged: () => {}, configChanged: () => {}, activity: () => {},
};
const pushed: { to: string; text: string; kind?: string }[] = [];
const inbox = { push: (to: string, item: { text: string; kind?: string }) => pushed.push({ to, text: item.text, kind: item.kind }), save: () => {} };
const planner = new Planner(hub as never, inbox as never);
planner.ask = async () => null; // no model calls in tests
const memory = new Neo4jMemory(hqDb(), () => null); // no Neo4j: summaries and graph writes stay queued
planner.memory = memory;
const createTask = (input: Parameters<typeof planner.createTask>[0], by: string) => {
  const task = planner.createTask({ doneWhen: "Fixture acceptance verified", ...input }, by);
  task.note = "Fixture checked.";
  task.deliverablePath = "fixture.md";
  return task;
};

// The lead assigns in the "wrong" order: the first task, then the one that waits on it.
const t1 = createTask({ title: "Write tips" } as never, "cipher");
const t2 = createTask({ title: "Review tips", needs: [t1.id] } as never, "cipher");
planner.assign(t1.id, "nyx", "cipher");
planner.assign(t2.id, "nyx", "cipher");
check("waiting task isn't announced as Start", /don't start it yet/.test(pushed[1]?.text ?? ""), pushed[1]?.text);
check("current task stays the ready one", planner.currentTask("nyx")?.id === t1.id, planner.currentTask("nyx")?.id);

planner.setStatus("nyx", "in-progress");
planner.setStatus("nyx", "done", "Fixture acceptance checked.");
const start = pushed.find((p) => p.to === "nyx" && p.text.includes(`start ${t2.id}`));
check("finishing the first tells the owner to start the second", !!start && /now/.test(start.text), pushed.map((p) => p.text).join(" | "));
check("then the second is current", planner.currentTask("nyx")?.id === t2.id);
check("no fresh conversation when the next task builds on the one just done", !pushed.some((p) => p.kind === "reset"));

// Lean mode: an unrelated next task starts in a fresh conversation, with the handoff in its brief.
planner.setStatus("nyx", "in-progress");
planner.setStatus("nyx", "done", "Reviewed tips; all three are accurate.");
const t3 = createTask({ title: "Write phone tips" } as never, "cipher");
const t4 = createTask({ title: "Check phone tips", needs: [t3.id] } as never, "cipher");
planner.assign(t3.id, "nyx", "cipher");
const beforeDone = pushed.length;
planner.setStatus("nyx", "in-progress");
planner.setStatus("nyx", "done", "phone-tips.md written: 2 tips");
const afterDone = pushed.slice(beforeDone);
check("worker's finished task queues its CLI's new-conversation command", afterDone.some((p) => p.kind === "reset" && p.to === "nyx" && p.text === "/new"), JSON.stringify(afterDone));
planner.assign(t4.id, "nyx", "cipher");
const b = planner.brief("nyx", t4);
check("brief carries the handoff it builds on", b.text.includes(`- ${t3.id} (`) && b.text.includes("phone-tips.md written: 2 tips"), b.text);
check("brief carries the agent's own last note", b.text.includes("(your last task): phone-tips.md written: 2 tips"), b.text);

// No reset for the lead, nor for a worker already mid-way through another task.
const t5 = createTask({ title: "Lead's own task" } as never, "cipher");
planner.assign(t5.id, "cipher", "cipher");
const n0 = pushed.length;
planner.setStatus("cipher", "in-progress");
planner.setStatus("cipher", "done", "Fixture acceptance checked.");
check("the lead keeps its conversation", !pushed.slice(n0).some((p) => p.kind === "reset"));
const t6 = createTask({ title: "A" } as never, "cipher");
const t7 = createTask({ title: "B" } as never, "cipher");
planner.assign(t6.id, "nyx", "cipher");
planner.assign(t7.id, "nyx", "cipher");
planner.updateTask(t7.id, { status: "in-progress" });
const n1 = pushed.length;
planner.updateTask(t6.id, { status: "done" });
check("no reset while another task is in progress", !pushed.slice(n1).some((p) => p.kind === "reset"));
const n2 = pushed.length;
planner.updateTask(t6.id, { title: "A (renamed)" });
check("editing a finished task doesn't re-run the done steps", pushed.length === n2);

// Messages to the human: recorded for the UI, nothing typed anywhere.
const before = pushed.length;
check("agent can message you", planner.message("nyx", "you", "Done") === "you" && snap.messages.some((m: { toId: string; text: string }) => m.toId === "you" && m.text === "Done"));
check("nothing delivered to an inbox", pushed.length === before);
let threw = false;
try {
  planner.message("nyx", "nyx", "hi");
} catch {
  threw = true;
}
check("messaging yourself is refused", threw);

// No review tool: the lead must review, not be told the PR "passed review".
const { unreviewedNotice } = await import("../server/githubSync");
const note = unreviewedNotice({ number: 1, title: "x" }, "Nyx", "human");
const { mergeByNotice } = await import("../server/githubSync");
check("handing merges to the lead without a review tool doesn't claim PRs passed review", !/passed review/.test(mergeByNotice("lead", [1], false)) && /Review each/.test(mergeByNotice("lead", [1], false)));
check("unreviewed PR asks the lead to review, not merge", /review it yourself/.test(note) && !/passed review/.test(note) && /Don't merge/.test(note), note);

// Stall: a worker idle with its task in progress is nudged once, and the lead told.
{
  const tS = createTask({ title: "Showcase" } as never, "cipher");
  planner.assign(tS.id, "nyx", "cipher");
  planner.setStatus("nyx", "in-progress");
  Object.assign(statuses.get("nyx")!, { state: "idle", stateSince: new Date(Date.now() - 10 * 60_000).toISOString() });
  (inbox as unknown as { pending: () => number }).pending = () => 0;
  const n = pushed.length;
  planner.checkStalls(Date.now());
  planner.checkStalls(Date.now());
  const got = pushed.slice(n);
  check("stalled worker nudged once", got.filter((p) => p.to === "nyx" && /still in progress/.test(p.text)).length === 1, JSON.stringify(got));
  check("lead told about the stall", got.some((p) => p.to === "cipher" && /idle 10 min/.test(p.text)));
  Object.assign(statuses.get("nyx")!, { state: "idle", stateSince: new Date().toISOString() });

  // "Working" with no hooks for 20 min: lead is told, the busy agent isn't typed into.
  const tW = createTask({ title: "Hangs" } as never, "cipher");
  planner.assign(tW.id, "nyx", "cipher");
  planner.setStatus("nyx", "in-progress");
  Object.assign(statuses.get("nyx")!, { state: "working", stateSince: new Date(Date.now() - 20 * 60_000).toISOString() });
  const m = pushed.length;
  planner.checkStalls(Date.now());
  const got2 = pushed.slice(m);
  check("silent working agent reported to the lead only", got2.length === 1 && got2[0].to === "cipher" && /nothing visible for 20 min/.test(got2[0].text), JSON.stringify(got2));
  Object.assign(statuses.get("nyx")!, { state: "idle", stateSince: new Date().toISOString() });
}

// The user is away: their unanswered question goes to the lead after 30 min; plans keep waiting for the user.
{
  const old = new Date(Date.now() - 40 * 60_000).toISOString();
  (snap as unknown as { actionItems: unknown[] }).actionItems = [
    { id: "a1", fromId: "nyx", title: "Which port for the demo?", status: "open", kind: "request", at: old },
    { id: "a2", fromId: "nyx", title: "Rotate certs", status: "open", kind: "plan", at: old },
  ];
  const k = pushed.length;
  planner.checkStalls(Date.now());
  planner.checkStalls(Date.now());
  const got3 = pushed.slice(k).filter((p) => p.to === "cipher");
  check("unanswered question handed to the lead once", got3.length === 1 && /Which port/.test(got3[0].text) && /reversible decision/.test(got3[0].text), JSON.stringify(got3));
  (snap as unknown as { actionItems: unknown[] }).actionItems = [];
}

// ---------------------------------------------------------------- task summaries (2.3)
{
  const done = snap.tasks.filter((t: { status: string }) => t.status === "done") as { id: string; title: string; note: string | null; needs: string[] }[];
  const missing = done.filter((t) => !memory.summary("plan-test", t.id));
  check("every finished task leaves a summary", done.length >= 5 && missing.length === 0, `${done.length} done, missing ${missing.map((t) => t.id)}`);
  const s2 = memory.summary("plan-test", t2.id);
  check("a summary carries the handoff note and what the task built on", s2?.title === "Review tips" && s2.note === "Reviewed tips; all three are accurate." && s2.needs.join() === t1.id && s2.ownerId === "nyx", JSON.stringify(s2));
  const open = snap.tasks.find((t: { status: string }) => t.status !== "done") as { id: string } | undefined;
  check("an unfinished task has none", !open || memory.summary("plan-test", open.id) === null);
  const queued = hqDb().prepare("SELECT count(*) AS n FROM memory_outbox WHERE op LIKE '%\"op\":\"task\"%'").get() as { n: number };
  check("each summary queues the task for the graph", queued.n >= done.length, String(queued.n));
}

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
