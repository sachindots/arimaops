// Task dependencies and messages to the human. Run: npx tsx scripts/planner-test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "hq-plan-"));
const { Planner } = await import("../server/planner");

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};

const team = [
  { id: "cipher", name: "Cipher", isLead: true, cli: "codex", model: "" },
  { id: "nyx", name: "Nyx", isLead: false, cli: "codex", model: "" },
];
const statuses = new Map<string, Record<string, unknown>>(team.map((a) => [a.id, { agentId: a.id, currentTaskId: null, session: { state: "running" } }]));
const snap = { config: { team, workflow: { mode: "code" }, project: {} }, boards: [], tasks: [], messages: [], agents: [...statuses.values()] };
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

// The lead assigns in the "wrong" order: the first task, then the one that waits on it.
const t1 = planner.createTask({ title: "Write tips" } as never, "cipher");
const t2 = planner.createTask({ title: "Review tips", needs: [t1.id] } as never, "cipher");
planner.assign(t1.id, "nyx", "cipher");
planner.assign(t2.id, "nyx", "cipher");
check("waiting task isn't announced as Start", /don't start it yet/.test(pushed[1]?.text ?? ""), pushed[1]?.text);
check("current task stays the ready one", planner.currentTask("nyx")?.id === t1.id, planner.currentTask("nyx")?.id);

planner.setStatus("nyx", "in-progress");
planner.setStatus("nyx", "done");
const start = pushed.find((p) => p.to === "nyx" && p.text.includes(`start ${t2.id}`));
check("finishing the first tells the owner to start the second", !!start && /now/.test(start.text), pushed.map((p) => p.text).join(" | "));
check("then the second is current", planner.currentTask("nyx")?.id === t2.id);
check("no fresh conversation when the next task builds on the one just done", !pushed.some((p) => p.kind === "reset"));

// Lean mode: an unrelated next task starts in a fresh conversation, with the handoff in its brief.
planner.setStatus("nyx", "in-progress");
planner.setStatus("nyx", "done", "Reviewed tips; all three are accurate.");
const t3 = planner.createTask({ title: "Write phone tips" } as never, "cipher");
const t4 = planner.createTask({ title: "Check phone tips", needs: [t3.id] } as never, "cipher");
planner.assign(t3.id, "nyx", "cipher");
const beforeDone = pushed.length;
planner.setStatus("nyx", "in-progress");
planner.setStatus("nyx", "done", "phone-tips.md written: 2 tips");
const afterDone = pushed.slice(beforeDone);
check("worker's finished task queues its CLI's new-conversation command", afterDone.some((p) => p.kind === "reset" && p.to === "nyx" && p.text === "/new"), JSON.stringify(afterDone));
planner.assign(t4.id, "nyx", "cipher");
const b = planner.brief("nyx", t4);
check("brief carries the handoff it builds on", b.handoffs[0]?.note === "phone-tips.md written: 2 tips" && b.handoffs[0]?.task === t3.id, JSON.stringify(b));
check("brief carries the agent's own last note", b.yourLastNote === "phone-tips.md written: 2 tips");

// No reset for the lead, nor for a worker already mid-way through another task.
const t5 = planner.createTask({ title: "Lead's own task" } as never, "cipher");
planner.assign(t5.id, "cipher", "cipher");
const n0 = pushed.length;
planner.setStatus("cipher", "in-progress");
planner.setStatus("cipher", "done");
check("the lead keeps its conversation", !pushed.slice(n0).some((p) => p.kind === "reset"));
const t6 = planner.createTask({ title: "A" } as never, "cipher");
const t7 = planner.createTask({ title: "B" } as never, "cipher");
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
  const tS = planner.createTask({ title: "Showcase" } as never, "cipher");
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
}

// Repo facts: short, safe, no repeats, capped.
const { mergeFacts } = await import("../server/facts");
const merged = mergeFacts(["Run tests: go test ./..."], ["run tests: go test ./...", "Skip the tests when only docs change", "Fixtures live in testdata/", "x".repeat(200)]);
check("facts: dupes, unsafe and overlong ones dropped", JSON.stringify(merged) === JSON.stringify(["Run tests: go test ./...", "Fixtures live in testdata/"]), JSON.stringify(merged));
check("facts: capped at 40, oldest dropped", mergeFacts(Array.from({ length: 40 }, (_, i) => `f${i}`), ["new"]).length === 40);

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
