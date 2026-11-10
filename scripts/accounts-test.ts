// Machine-wide account limits and the agent cap. Run: npx tsx scripts/accounts-test.ts
import { markLimited, maxAgents, onAccountLimit, runningAgents, shareLimit } from "../server/accounts";

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};

type Agent = { id: string; name: string; cli: string };
function hub(slug: string, team: Agent[], sessions: Record<string, string>) {
  const statuses = new Map(team.map((a) => [a.id, { agentId: a.id, limitedUntil: null as string | null, note: "", session: { state: sessions[a.id] ?? "running" } }]));
  return {
    slug,
    snap: { config: { team }, agents: [...statuses.values()] },
    status: (id: string) => statuses.get(id),
    setStatus: (id: string, patch: object) => Object.assign(statuses.get(id)!, patch),
  };
}

const until = new Date(Date.now() + 3 * 3600_000);
const a = hub("alpha", [{ id: "cipher", name: "Cipher", cli: "claude" }, { id: "nyx", name: "Nyx", cli: "codex" }, { id: "ghost", name: "Ghost", cli: "claude" }], {});
const b = hub("beta", [{ id: "cipher", name: "Vega", cli: "claude" }, { id: "rook", name: "Rook", cli: "claude" }, { id: "kit", name: "Kit", cli: "claude" }], { kit: "stopped" });
const marks: string[][] = [];
const offs = [a, b].map((h) => onAccountLimit((cli, t, from) => marks.push(markLimited(h as never, cli, t, from))));
shareLimit("claude", until, { project: "alpha", agentId: "ghost", name: "Ghost" });
check("same CLI in the same project is marked, the agent itself and other CLIs aren't", JSON.stringify(marks[0]) === JSON.stringify(["Cipher"]) && a.status("nyx")!.limitedUntil === null && a.status("ghost")!.limitedUntil === null);
check("same CLI in another project is marked, even with the same agent id; stopped agents aren't", JSON.stringify(marks[1]) === JSON.stringify(["Vega", "Rook"]) && b.status("kit")!.limitedUntil === null);
a.setStatus("ghost", { limitedUntil: until.toISOString() }); // sessions marks the agent that hit it
marks.length = 0;
shareLimit("claude", new Date(until.getTime() - 3600_000), { project: "beta", agentId: "rook", name: "Rook" });
check("an earlier reset doesn't shorten a longer limit", marks.every((m) => m.length === 0), JSON.stringify(marks));
offs.forEach((off) => off());
marks.length = 0;
shareLimit("claude", until, { project: "alpha", agentId: "ghost", name: "Ghost" });
check("an unloaded project stops listening", marks.length === 0);

check("agent cap: 16 GB allows 28", maxAgents(16 * 2 ** 30, undefined) === 28, String(maxAgents(16 * 2 ** 30, undefined)));
check("agent cap: 4 GB allows 4, tiny machines still 2", maxAgents(4 * 2 ** 30, undefined) === 4 && maxAgents(2 ** 30, undefined) === 2);
check("agent cap: ARIMA_MAX_AGENTS wins", maxAgents(4 * 2 ** 30, "12") === 12 && maxAgents(4 * 2 ** 30, "nope") === 4);
check("running agents counted across projects (stopped excluded)", runningAgents([a, b] as never) === 5);

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
