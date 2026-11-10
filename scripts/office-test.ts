// Isometric office: projection, building layout and robot behaviour. Run: npx tsx scripts/office-test.ts
import type { AgentStatus } from "../src/data/types";
import { besideSeat, IsoBot, modeOf, seatOf, targetFor, update, type Mode } from "../src/office/iso/behaviour";
import { EventDiff } from "../src/office/iso/events";
import { generateIsoLayout, hasSoc, type TeamMember } from "../src/office/iso/layout";
import { depth, toScreen, toTile } from "../src/office/iso/proj";

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};

// ---------------------------------------------------------------- projection
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
let roundTrips = true;
for (const [x, y] of [[0, 0], [3, 7], [12.5, 4.25], [-2, 9], [40, 40]]) {
  const s = toScreen(x, y);
  const t = toTile(s.x, s.y);
  if (!near(t.x, x) || !near(t.y, y)) roundTrips = false;
}
check("tile → screen → tile round-trips", roundTrips);
check("+x goes down-right, +y goes down-left", toScreen(1, 0).x > 0 && toScreen(1, 0).y > 0 && toScreen(0, 1).x < 0 && toScreen(0, 1).y > 0);
check("height moves straight up", toScreen(2, 3, 10).x === toScreen(2, 3).x && toScreen(2, 3, 10).y === toScreen(2, 3).y - 10);
check("depth: nearer tiles sort later, height breaks ties", depth(3, 4) < depth(4, 4) && depth(3, 4) < depth(3, 4, 5) && depth(3, 4, 5) < depth(3, 5));

// ---------------------------------------------------------------- layouts
const dev: TeamMember[] = [
  { id: "cipher", role: "Tech Lead", isLead: true, department: "exec" },
  { id: "nyx", role: "Go Developer", isLead: false, department: "eng" },
  { id: "lyra", role: "Docs Writer", isLead: false, department: "eng" },
  { id: "ghost", role: "Go Developer", isLead: false, department: "eng" },
];
const sec: TeamMember[] = [
  { id: "vega", role: "Red Team Commander", isLead: true, department: "exec" },
  { id: "rook", role: "Red Teamer", isLead: false, department: "red-team" },
  { id: "ada", role: "Blue Team", isLead: false, department: "qa-ops" },
];
const big: TeamMember[] = [
  { id: "l1", role: "CTO", isLead: true },
  { id: "l2", role: "VP Product", isLead: true },
  ...Array.from({ length: 9 }, (_, i) => ({ id: `w${i}`, role: "Developer", isLead: false })),
];

for (const [name, team, type] of [["dev team", dev, "software"], ["security team", sec, "security"], ["big team, two leads", big, "software"]] as const) {
  const l = generateIsoLayout(team, type);
  const nbrs = ([x, y]: [number, number]) => [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as [number, number][];
  const workers = team.filter((a) => !a.isLead);
  const leads = team.filter((a) => a.isLead);
  const seatOf = (id: string) => l.seats.find((s) => s.agentId === id);
  const deskAbove = (t: [number, number]) => l.items.some((it) => it.kind === "desk" && it.x === t[0] && it.y === t[1] - 1);

  check(`${name}: every worker has a seat at a desk next to a walkable tile`, workers.every((a) => {
    const s = seatOf(a.id);
    return !!s && !l.grid.ok(...s.tile) && deskAbove(s.tile) && nbrs(s.tile).some(([x, y]) => l.grid.ok(x, y));
  }));
  check(`${name}: every lead has a seat in the lead office`, leads.every((a) => seatOf(a.id)?.zone === "lead"));
  check(`${name}: no two agents share a seat`, new Set(l.seats.map((s) => s.tile.join())).size === team.length);
  const soc = l.zones.find((z) => z.kind === "soc");
  check(`${name}: SOC room iff security work or a red team`, !!soc === hasSoc(team, type) && !!soc === (type === "security"));
  if (soc) check(`${name}: red-team workers sit in the SOC`, workers.filter((a) => a.department === "red-team").every((a) => seatOf(a.id)?.zone === "soc"));
  const reach = (t: [number, number]) => (t[0] === l.door[0] && t[1] === l.door[1]) || l.grid.find(l.door[0], l.door[1], t[0], t[1]).length > 0;
  check(`${name}: every zone is reachable from the door`, l.zones.every((z) => l.grid.ok(...z.anchor) && reach(z.anchor)), l.zones.filter((z) => !reach(z.anchor)).map((z) => z.kind).join());
  check(`${name}: every seat is reachable from the door`, l.seats.every((s) => reach(s.tile)));
  check(`${name}: items stay inside the building`, l.items.every((it) => it.x >= 0 && it.y >= 0 && it.x < l.W && it.y < l.H));
  const again = generateIsoLayout(team, type);
  check(`${name}: deterministic`, JSON.stringify({ ...l, grid: [...l.grid.cells] }) === JSON.stringify({ ...again, grid: [...again.grid.cells] }));
}

// ---------------------------------------------------------------- behaviour
const status = (state: AgentStatus["state"], session: AgentStatus["session"]["state"], extra: Partial<AgentStatus> = {}): AgentStatus =>
  ({ agentId: "x", state, currentTaskId: null, stateSince: "", note: null, session: { state: session, detail: null, workspace: null, sandbox: null }, ...extra });
check("mode: session state wins over agent state", modeOf(status("working", "stopped")) === "stopped" && modeOf(status("idle", "starting")) === "starting" && modeOf(status("working", "failed")) === "alert");
check("mode: running agents map by state", modeOf(status("working", "running")) === "working" && modeOf(status("idle", "running")) === "idle" && modeOf(status("needs-input", "running")) === "needs-input" && modeOf(status("review-passed", "running")) === "cheer" && modeOf(status("in-review", "running")) === "working");
check("mode: a usage-limited agent is stuck", modeOf(status("working", "running", { limitedUntil: new Date(Date.now() + 60_000).toISOString() })) === "alert" && modeOf(status("working", "running", { limitedUntil: new Date(Date.now() - 1).toISOString() })) === "working");
check("mode: no status means stopped", modeOf(undefined) === "stopped");

{
  const l = generateIsoLayout(dev, "software");
  const seat = seatOf(l, "nyx") as [number, number];
  const rand = (() => {
    let n = 7;
    return () => ((n = (n * 48271) % 2147483647) / 2147483647);
  })();
  const walkable = (t: [number, number]) => l.grid.ok(...t);
  const reach = (from: [number, number], to: [number, number]) => (from[0] === to[0] && from[1] === to[1]) || l.grid.find(from[0], from[1], to[0], to[1]).length > 0;
  const bot = new IsoBot("nyx", false, seat);
  const targets = (mode: Mode) => Array.from({ length: 12 }, () => targetFor(bot, l, mode, rand) as { tile: [number, number]; errand: string });
  const seated: Mode[] = ["working", "cheer", "needs-input", "alert", "stopped", "starting"];
  check("target: every non-idle state heads for the seat", seated.every((m) => targets(m).every((t) => t.errand === "seat" && t.tile.join() === seat.join())));
  const idle = targets("idle");
  check("target: idle picks break spots (coffee and wander), never the seat", idle.every((t) => t.errand === "coffee" || t.errand === "wander") && idle.some((t) => t.errand === "coffee") && idle.some((t) => t.errand === "wander"));
  check("target: every idle spot is walkable and reachable from the seat", idle.every((t) => walkable(t.tile) && reach(seat, t.tile)));
  check("target: every coffee, wander and scrum spot is walkable", [...l.spots.coffee, ...l.spots.wander, ...l.spots.scrum].every(walkable));
  const lead = new IsoBot("cipher", true, seatOf(l, "cipher") as [number, number]);
  check("target: idle lead stays in its office", targetFor(lead, l, "idle", rand)?.errand === "seat");

  // Simulate at 60 fps.
  const run = (b: IsoBot, mode: Mode, seconds: number, still = false) => {
    for (let i = 0; i < seconds * 60; i++) update(b, l, mode, 1 / 60, rand, still);
  };
  const stopped = new IsoBot("nyx", false, seat);
  stopped.facing = "ne";
  run(stopped, "stopped", 20);
  check("stopped: a seated agent never moves", stopped.at(seat) && stopped.facing === "ne" && !stopped.moving);

  const idler = new IsoBot("lyra", false, seatOf(l, "lyra") as [number, number]);
  const seen = new Set<string>();
  for (let i = 0; i < 90 * 60; i++) {
    update(idler, l, "idle", 1 / 60, rand);
    if (!idler.moving && idler.pause > 0) seen.add(idler.tile().join());
  }
  check("idle: wanders between several spots and pauses at each", seen.size >= 3 && [...seen].every((k) => [...l.spots.coffee, ...l.spots.wander].some((t) => t.join() === k)), [...seen].join(" "));
  run(idler, "working", 30);
  check("working: an idle wanderer returns to its desk and faces it", idler.at(seatOf(l, "lyra") as [number, number]) && idler.facing === "ne");

  const starter = new IsoBot("ghost", false, seatOf(l, "ghost") as [number, number]);
  run(starter, "stopped", 1);
  update(starter, l, "starting", 1 / 60, rand);
  const atDoor = starter.tile().join() === l.door.join() || starter.moving;
  run(starter, "starting", 30);
  check("starting: comes in through the door and sits down", atDoor && starter.at(seatOf(l, "ghost") as [number, number]));

  // The lead walks to an alerted agent, waits, and comes back.
  const home = seatOf(l, "cipher") as [number, number];
  lead.facing = "ne";
  lead.visit = "ghost";
  const beside = besideSeat(l, "ghost") as [number, number];
  let arrived = false;
  let left = false;
  for (let i = 0; i < 40 * 60; i++) {
    update(lead, l, "working", 1 / 60, rand);
    if (lead.at(beside) && lead.errand === "visit") arrived = true;
    if (arrived && !lead.at(beside)) left = true;
  }
  check("lead: walks to the alerted agent's desk, then home", arrived && left && lead.at(home) && lead.visit === null && lead.facing === "ne");

  // Huddle: an up agent walks to its scrum spot, stays a while, then returns; a stopped one never joins.
  {
    const spot = l.spots.scrum[0];
    const h = new IsoBot("nyx", false, seat);
    run(h, "working", 1);
    h.huddle = spot;
    h.huddleFor = 3;
    let reached = false;
    for (let i = 0; i < 30 * 60; i++) {
      update(h, l, "working", 1 / 60, rand);
      if (h.at(spot) && h.errand === "huddle") reached = true;
    }
    check("huddle: goes to the scrum board, then back to its desk", reached && h.at(seat) && h.huddle === null);
    const s2 = new IsoBot("lyra", false, seatOf(l, "lyra") as [number, number]);
    run(s2, "stopped", 1);
    s2.huddle = spot;
    run(s2, "stopped", 5);
    check("huddle: a stopped agent stays put and drops the huddle", s2.at(seatOf(l, "lyra") as [number, number]) && s2.huddle === null);
  }

  const still = new IsoBot("nyx", false, seat);
  run(still, "idle", 5, true);
  check("reduced motion: idle agents stay seated", still.at(seat) && !still.moving);
}

// ---------------------------------------------------------------- events
{
  const base = {
    config: { team: [{ id: "cipher", isLead: true }, { id: "nyx", isLead: false }, { id: "lyra", isLead: false }], project: { type: "security" } },
    activity: [{ id: "a1", type: "pr.merged", agentId: "nyx", at: "", text: "" }],
    messages: [{ id: "m1", fromId: "cipher", toId: "nyx" }],
    pullRequests: [{ number: 3, authorId: "nyx", merged: false }],
    findings: [{ id: "F-001", severity: "high", reporterId: "nyx" }],
    tasks: [{ id: "t1", title: "Write report", status: "done" }],
  };
  const d = new EventDiff();
  check("events: the first snapshot replays no history", d.next(base as never).length === 0);
  const next = {
    ...base,
    activity: [
      { id: "a4", type: "scope.refused", agentId: "nyx", at: "", text: "" },
      { id: "a3", type: "task.created", agentId: "cipher", at: "", text: "" },
      { id: "a2", type: "task.created", agentId: "cipher", at: "", text: "" },
      { id: "a5", type: "pr.merged", agentId: "lyra", at: "", text: "" },
      ...base.activity,
    ],
    messages: [{ id: "m3", fromId: "nyx", toId: "nyx" }, { id: "m2", fromId: "nyx", toId: "lyra" }, ...base.messages],
    pullRequests: [{ number: 4, authorId: "lyra", merged: false }, { number: 5, authorId: "cipher", merged: false }, ...base.pullRequests],
    findings: [...base.findings, { id: "F-002", severity: "critical", reporterId: "lyra" }],
    tasks: [...base.tasks, { id: "t2", title: "Final report", status: "done" }, { id: "t3", title: "Recon", status: "done" }],
  };
  const evs = d.next(next as never);
  const kinds = evs.map((e) => e.kind).join(",");
  check("events: two new tasks are one huddle, first", evs[0]?.kind === "huddle" && evs.filter((e) => e.kind === "huddle").length === 1, kinds);
  check("events: merge cheers, refusal flashes", evs.some((e) => e.kind === "cheer" && e.agentId === "lyra") && evs.some((e) => e.kind === "refused"), kinds);
  check("events: worker-to-worker message is a chat plane; self-messages ignored", evs.filter((e) => e.kind === "plane").length === 1 && evs.some((e) => e.kind === "plane" && e.chat), kinds);
  check("events: a worker's new PR flies to the lead; the lead's own doesn't", evs.filter((e) => e.kind === "parcel").length === 1 && evs.some((e) => e.kind === "parcel" && e.num === 4), kinds);
  check("events: new finding and finished report", evs.some((e) => e.kind === "finding" && e.id === "F-002" && e.severity === "critical") && evs.filter((e) => e.kind === "report").length === 1, kinds);
  check("events: nothing repeats", d.next(next as never).length === 0);
}

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
