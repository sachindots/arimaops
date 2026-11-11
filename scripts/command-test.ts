// Command center: what shows first, filters, search. Run: npx tsx scripts/command-test.ts
import { FILTERS, matches, rowsOf, sortRows } from "../src/ui/command/rank";

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};

const t = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const agent = (id: string, name: string) => ({ id, name, role: "Developer", cli: "claude", model: "sonnet", color: "#fff", isLead: false }) as never;
const status = (agentId: string, state: string, session: string, since: number, extra = {}) =>
  ({ agentId, state, currentTaskId: null, stateSince: t(since), note: null, session: { state: session }, ...extra }) as never;
const snap = (team: unknown[], agents: unknown[], tasks: unknown[] = []) => ({ config: { team }, agents, tasks }) as never;

const a = rowsOf("alpha", "Alpha", true, snap(
  [agent("kavin", "Kavin"), agent("nila", "Nila"), agent("arul", "Arul"), agent("zero", "Zero"), agent("yaz", "Yaazhini")],
  [
    status("kavin", "working", "running", 3),
    status("nila", "needs-input", "running", 1),
    status("arul", "idle", "running", 30),
    status("zero", "idle", "stopped", 60),
    status("yaz", "working", "running", 9, { limitedUntil: new Date(Date.now() + 600_000).toISOString() }),
  ],
  [{ id: "T1", title: "Socket parser", ownerId: "kavin", status: "in-progress" }],
));
const b = rowsOf("beta", "Beta", false, snap([agent("kavin", "Kavin")], [status("kavin", "needs-input", "running", 5)]));

const sorted = sortRows([...a, ...b], new Set());
check("needs-you first, longest waiting first", sorted[0].key === "beta/kavin" && sorted[1].key === "alpha/nila", sorted.map((r) => r.key).join(" "));
check("then stuck (usage-limited), then working, idle, stopped", sorted.slice(2).map((r) => r.agent.id).join() === "yaz,kavin,arul,zero", sorted.map((r) => r.key).join(" "));
check("agent ids repeat across projects: keys don't", new Set(sorted.map((r) => r.key)).size === sorted.length);
check("pinned goes first", sortRows([...a, ...b], new Set(["alpha/zero"]))[0].key === "alpha/zero");
check("the current task comes from the owner's in-progress task", a.find((r) => r.agent.id === "kavin")?.task?.id === "T1");
check("filter: needs you = asking + stuck", sorted.filter((r) => FILTERS.attention(r.mode)).length === 3);
check("filter: working / idle / stopped", sorted.filter((r) => FILTERS.working(r.mode)).length === 1 && sorted.filter((r) => FILTERS.idle(r.mode)).length === 1 && sorted.filter((r) => FILTERS.stopped(r.mode)).length === 1);
check("search finds by task and project", matches(a[0], "socket") && matches(b[0], "beta") && !matches(a[1], "socket"));

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
