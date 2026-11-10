// Isometric office: projection and building layout. Run: npx tsx scripts/office-test.ts
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

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
