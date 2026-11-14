// Per-agent usage for the UI (GET /api/projects/<id>/usage): totals, cost and a sparkline series per agent.
// Run: npx tsx scripts/usage-agents-test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "hq-usage-"));
const { hqDb } = await import("../server/lib/db");
const { recordEvent, agentUsage } = await import("../server/usageEvents");

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};

const db = hqDb();
const now = Date.UTC(2026, 10, 14, 12);
const hour = 3_600_000;
const ev = (agentId: string | null, hoursAgo: number, input: number, projectId = "p") =>
  recordEvent(db, { projectId, taskId: null, agentId, source: "agent", account: "default", provider: "anthropic", cli: "claude", model: "claude-sonnet-5-5", tokens: { input, cached: 0, output: 10 }, at: new Date(now - hoursAgo * hour).toISOString() });

ev("ghost", 1, 100);
ev("ghost", 23, 50);
ev("vortex", 2, 500);
ev("vortex", 30, 9999); // outside the day
ev(null, 1, 777); // a helper run, no agent
ev("ghost", 1, 1, "other"); // another project

const rows = agentUsage(db, "p", now - 24 * hour, now);
check("busiest agent first", rows.map((r) => r.agentId).join() === "vortex,ghost", JSON.stringify(rows.map((r) => r.agentId)));
const ghost = rows.find((r) => r.agentId === "ghost")!;
check("totals only inside the window and project", ghost.input === 150 && ghost.output === 20 && rows.find((r) => r.agentId === "vortex")!.input === 500, JSON.stringify(ghost));
check("series has 24 slices that add up to the total", ghost.series.length === 24 && ghost.series.reduce((a, b) => a + b, 0) === 170, JSON.stringify(ghost.series));
check("recent work lands in the last slices", ghost.series[23] === 110 && ghost.series[1] === 60, JSON.stringify(ghost.series));
check("cost is summed", rows.every((r) => r.costUsd >= 0));

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
