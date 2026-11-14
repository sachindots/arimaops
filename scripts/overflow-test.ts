// Codex overflow, ask first (docs/agent-engine.md section 7): a simulated usage limit files an Action item;
// Move restarts the seat on its role's fallback for that task only; Wait changes nothing. Run: npx tsx scripts/overflow-test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "arima-overflow-"));
const { Overflow } = await import("../server/overflow");
const { ActionItems } = await import("../server/actionItems");
const { detectLimit } = await import("../server/limits");
const { DEV_TEMPLATE } = await import("../src/data/templates");

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};

const team = [
  { id: "lea", name: "Lea", roleId: "lead", isLead: true, cli: "claude", model: "claude-opus-5-5" },
  { id: "arul", name: "Arul", roleId: "developer", isLead: false, cli: "claude", model: "claude-sonnet-5-5" },
  { id: "rev", name: "Rev", roleId: "reviewer", isLead: false, cli: "codex", model: "gpt-6.1-sol" },
];
const tasks = [
  { id: "B1-T12", title: "Rate limit the login", ownerId: "arul", status: "in-progress", boardId: "B1", needs: [] },
  { id: "B1-T13", title: "Review", ownerId: "rev", status: "in-progress", boardId: "B1", needs: [] },
];
const statuses = new Map(team.map((a) => [a.id, { agentId: a.id, state: "working", session: { state: "running" }, currentTaskId: tasks.find((t) => t.ownerId === a.id)?.id ?? null } as Record<string, unknown>]));
const snap = { config: { template: DEV_TEMPLATE, team, project: { id: "ovf" } }, tasks, actionItems: [] as { id: string; status: string; kind?: string; title: string; overflow?: unknown }[] };
const hub = {
  slug: "ovf", snap, emit: () => {}, activity: () => {}, configChanged: () => {},
  cfg: (id: string) => team.find((a) => a.id === id),
  name: (id: string) => team.find((a) => a.id === id)?.name ?? id,
  status: (id: string) => statuses.get(id),
  setStatus: (id: string, p: object) => Object.assign(statuses.get(id)!, p),
};
const told: { to: string; text: string }[] = [];
const planner = {
  actions: null as InstanceType<typeof ActionItems> | null,
  currentTask: (id: string) => tasks.find((t) => t.ownerId === id && t.status !== "done") as never,
  task: (id: string) => tasks.find((t) => t.id === id) as never,
  notify: (to: string, text: string) => void told.push({ to, text }),
};
const log: string[] = [];
const sessions = {
  start: async (id: string) => {
    log.push(`start ${id} on ${team.find((a) => a.id === id)!.cli}`);
    statuses.get(id)!.session = { state: "running" };
  },
  stop: async (id: string) => {
    log.push(`stop ${id}`);
    statuses.get(id)!.session = { state: "stopped" };
  },
};
planner.actions = new ActionItems(hub as never, planner as never);
const ovf = new Overflow(hub as never, planner as never, sessions);
planner.actions.onMove = (m) => ovf.move(m);

// A simulated limit screen, as the terminal watcher sees it.
const hit = detectLimit("  ⎿  5-hour limit reached ∙ resets 3pm\n> ", new Date(2026, 10, 13, 12, 0));
check("the limit screen is detected", !!hit);
check("a seat at its limit gets an overflow offer", ovf.offer("arul", hit!.until));
const item = snap.actionItems.find((i) => i.kind === "overflow");
check("…as an Action item that names the fallback and waits on the owner", !!item && /Arul hit the Claude Code limit until .* on B1-T12\. Continue it on Codex \(gpt-6\.1-sol\) now\?/.test(item.title) && (item as { waiting?: boolean }).waiting === true, JSON.stringify(item));
check("asked once per seat and task", !ovf.offer("arul", hit!.until) && snap.actionItems.filter((i) => i.kind === "overflow").length === 1);
check("nothing moved before the owner answers", log.length === 0 && team[1].cli === "claude");
check("a role without a fallback gets no offer", !ovf.offer("rev", hit!.until));
check("the lead gets no offer", !ovf.offer("lea", hit!.until));

// Wait: nothing changes.
planner.actions.resolve(item!.id, "dismissed");
await new Promise((r) => setTimeout(r, 10));
check("Wait changes nothing", log.length === 0 && team[1].cli === "claude");

// Another limit later asks again; Move restarts the seat on Codex for this task.
check("a later limit on the same task asks again", ovf.offer("arul", hit!.until));
const again = snap.actionItems.find((i) => i.kind === "overflow" && i.status === "open")!;
statuses.get("arul")!.limitedUntil = hit!.until.toISOString();
planner.actions.resolve(again.id, "done");
await new Promise((r) => setTimeout(r, 10));
check("Move stops the seat and starts it on Codex", log.join() === "stop arul,start arul on codex", log.join());
check("…with the fallback model, the limit cleared and the task kept", team[1].model === "gpt-6.1-sol" && statuses.get("arul")!.limitedUntil === null && statuses.get("arul")!.currentTaskId === "B1-T12");
check("…and a handoff for the new session", told.some((t) => t.to === "arul" && /taking over B1-T12 .* from a Claude Code session/.test(t.text)), JSON.stringify(told));
check("a seat already on its fallback gets no offer", !ovf.offer("arul", hit!.until));

// Back on the role's CLI once the task is over and the session is down.
ovf.tick();
check("still on Codex while the task is open", team[1].cli === "codex");
tasks[0].status = "done";
ovf.tick();
check("…and while its session runs", team[1].cli === "codex");
statuses.get("arul")!.session = { state: "stopped" };
ovf.tick();
check("task done and session down: back on Claude Code with its role's model", team[1].cli === "claude" && team[1].model === "claude-sonnet-5-5" && ovf.movedSeats().length === 0);

// Alerts always on (3.9): every new kind of item reaches the phone.
{
  const { pushAlert } = await import("../server/push");
  const h = { slug: "ovf", snap: { config: { project: { name: "Shop" } } } } as never;
  const kinds = ["overflow", "spend", "approval"] as const;
  const got = kinds.map((kind) => pushAlert(h, { type: "action.updated", item: { id: `x-${kind}`, kind, status: "open", title: `t ${kind}`, fromId: "hq" } } as never));
  check("overflow, spend and lead-approval items are pushed", got.every((a) => a?.title.includes("Action needed")), JSON.stringify(got));
}

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
