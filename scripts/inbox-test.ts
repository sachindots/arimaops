// Messages survive an HQ restart and report how they were delivered. Run: npx tsx scripts/inbox-test.ts
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "hq-inbox-"));
const { Inbox } = await import("../server/inbox");
const { projectHome } = await import("../server/paths");

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};

type Msg = { id: string; at: string; fromId: string; toId: string; text: string; delivered?: string };
function fakeHub() {
  const status = { agentId: "dwight", state: "idle", session: { state: "stopped" } };
  const events: Msg[] = [];
  return {
    slug: "inboxtest",
    snap: { messages: [] as Msg[] },
    cfg: (id: string) => (id === "dwight" ? { id } : undefined),
    status: (id: string) => (id === "dwight" ? status : undefined),
    name: (id: string) => id,
    emit: (e: { message: Msg }) => events.push(e.message),
    statusRef: status,
    events,
  };
}
const typed: string[] = [];
const keys = { type: async (_id: string, text: string) => (typed.push(text), true), enter: async () => true };
const file = join(projectHome("inboxtest"), "messages.json");
const saved = () => JSON.parse(readFileSync(file, "utf8")) as { queues: Record<string, { msgId: string }[]>; messages: Msg[] };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The agent is stopped: the message waits, and is saved.
const hub1 = fakeHub();
const inbox1 = new Inbox(hub1 as never, keys);
hub1.snap.messages.unshift({ id: "m1", at: new Date().toISOString(), fromId: "you", toId: "dwight", text: "Please rebase", delivered: "queued" });
inbox1.push("dwight", { fromId: "you", kind: "message", text: "Please rebase", msgId: "m1" });
await wait(400);
check("queued message is saved to disk", existsSync(file) && saved().queues.dwight?.[0]?.msgId === "m1");
check("nothing typed into a stopped agent", typed.length === 0);
inbox1.stop();

// HQ restarts: a new inbox reads the queue and the history back.
const hub2 = fakeHub();
const inbox2 = new Inbox(hub2 as never, keys);
check("history comes back after a restart", hub2.snap.messages[0]?.id === "m1" && hub2.snap.messages[0]?.delivered === "queued");

// The agent comes back and is idle at its prompt: the message is typed and marked delivered.
hub2.statusRef.session.state = "running";
inbox2.sessionReattached("dwight");
await inbox2.tryType("dwight");
check("the kept message is typed once the agent is back", typed.length === 1 && typed[0].includes("Please rebase"), typed.join(" | "));
check("its status becomes typed (UI updated)", hub2.events.some((m) => m.id === "m1" && m.delivered === "typed"));
await wait(400);
check("the queue on disk is empty", !saved().queues.dwight && saved().messages[0]?.delivered === "typed");

// A message that arrives while the agent works is handed over by the Stop hook.
hub2.statusRef.state = "working";
hub2.snap.messages.unshift({ id: "m2", at: new Date().toISOString(), fromId: "you", toId: "dwight", text: "Also add tests", delivered: "queued" });
inbox2.push("dwight", { fromId: "you", kind: "message", text: "Also add tests", msgId: "m2" });
const reason = inbox2.takeForStop("dwight");
check("Stop hook hands it over", !!reason?.includes("Also add tests"));
check("its status becomes on-stop", hub2.snap.messages.find((m) => m.id === "m2")?.delivered === "on-stop");
inbox2.stop();

// A start that waited past a reassignment (e.g. across a reboot) is dropped, not delivered.
const hub3 = fakeHub();
const inbox3 = new Inbox(hub3 as never, keys);
inbox3.isStale = (_agent, taskId) => taskId === "T-OLD";
hub3.snap.messages.unshift({ id: "m3", at: new Date().toISOString(), fromId: "lead", toId: "dwight", text: "Start T-OLD", delivered: "queued" });
inbox3.push("dwight", { fromId: "lead", kind: "assign", text: "Start T-OLD", msgId: "m3", taskId: "T-OLD" });
inbox3.push("dwight", { fromId: "you", kind: "message", text: "hello" });
const handed = inbox3.takeForStop("dwight");
check("stale start isn't handed over", !!handed && !handed.includes("T-OLD") && handed.includes("hello"), String(handed));
check("its status becomes dropped", hub3.snap.messages.find((m) => m.id === "m3")?.delivered === "dropped");
inbox3.stop();

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
