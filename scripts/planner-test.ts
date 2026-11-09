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
const pushed: { to: string; text: string }[] = [];
const inbox = { push: (to: string, item: { text: string }) => pushed.push({ to, text: item.text }), save: () => {} };
const planner = new Planner(hub as never, inbox as never);

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

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
