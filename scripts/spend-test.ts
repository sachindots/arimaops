// Spend caps (docs/agent-engine.md section 8): API-key accounts only, one alert at 80%, a pause at 100% that
// stops workers and refuses starts and model runs, lifted by a new period or a raised cap. Run: npx tsx scripts/spend-test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "arima-spend-"));
const { hqDb } = await import("../server/lib/db");
const { capsOf, periods, SpendGuard, spendPaused, spendState } = await import("../server/spendCaps");
const { MeteredRunner } = await import("../server/modelRunner");

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};

const db = hqDb();
const spendRow = (project: string, account: string, usd: number | null, at: Date) =>
  db.prepare(
    `INSERT INTO usage_events (at, project_id, task_id, agent_id, source, account, provider, cli, model, input, cached, output, cost_usd)
     VALUES (?, ?, NULL, 'dev1', 'agent', ?, 'anthropic', 'claude', 'claude-sonnet-5-5', 1, 0, 1, ?)`,
  ).run(at.getTime(), project, account, usd);

const now = new Date(2026, 10, 13, 15, 0, 0); // 13 Nov, 15:00 local
const p = periods(now);
check("periods start at local midnight and the 1st", new Date(p.day).getHours() === 0 && new Date(p.day).getDate() === 13 && new Date(p.month).getDate() === 1 && p.dayKey === "2026-11-13" && p.monthKey === "2026-11");
check("caps default to $5 and $50; zero, negative and junk fall back", JSON.stringify(capsOf(undefined)) === '{"dailyUsd":5,"monthlyUsd":50}' && JSON.stringify(capsOf({ dailyUsd: 0, monthlyUsd: -3 })) === '{"dailyUsd":5,"monthlyUsd":50}' && capsOf({ dailyUsd: 2, monthlyUsd: 20 }).dailyUsd === 2);

// Only API-key accounts count; another project's spend doesn't.
spendRow("shop", "default", 40, now); // the owner's own subscription sign-in
spendRow("shop", "acme-key", 3.5, now);
spendRow("other", "acme-key", 9, now);
spendRow("shop", "acme-key", 10, new Date(2026, 10, 2)); // earlier this month
spendRow("shop", "acme-key", 99, new Date(2026, 9, 30)); // last month
spendRow("shop", "acme-key", null, now); // an unpriced model
let s = spendState(db, "shop", capsOf(undefined), ["acme-key"], now);
check("subscription usage isn't counted", s.day.usd === 3.5, JSON.stringify(s));
check("the month adds earlier days, not last month", s.month.usd === 13.5, JSON.stringify(s));
check("unpriced events are counted apart", s.unpriced === 1);
check("under the caps: not paused", s.paused === null);

// The guard: alert at 80%, pause at 100%.
const log: string[] = [];
let stopped = 0;
let caps = { dailyUsd: 5, monthlyUsd: 50 };
const items = new Set<string>();
const guard = new SpendGuard("shop", db, () => caps, () => ["acme-key"], {
  stopWorkers: async () => void stopped++,
  tellLead: (t) => log.push(`lead: ${t}`),
  alert: (id, title) => {
    if (items.has(id)) return;
    items.add(id);
    log.push(`alert ${id}: ${title}`);
  },
  changed: () => {},
});
await guard.check(now);
check("at 70% nothing happens", !log.length && stopped === 0, log.join(" | "));
spendRow("shop", "acme-key", 0.6, now); // $4.10 of $5
await guard.check(now);
await guard.check(now);
check("at 82% one alert, once", log.filter((l) => l.startsWith("alert spend-80-2026-11-13")).length === 1 && /82% of the daily spend cap/.test(log[0] ?? ""), log.join(" | "));
check("…and nothing stops", stopped === 0 && spendPaused("shop") === null);
spendRow("shop", "acme-key", 1, now); // $5.10: over
s = await guard.check(now);
check("at 100% the project pauses for the day", s.paused === "day" && spendPaused("shop") === "day");
check("…its workers are stopped", stopped === 1);
check("…the lead is told and a pause item is filed", log.some((l) => /^lead: HQ paused this project/.test(l)) && log.some((l) => l.startsWith("alert spend-pause-2026-11-13")), log.join(" | "));
await guard.check(now);
check("while paused, every check stops stragglers but tells the lead once", stopped === 2 && log.filter((l) => /^lead: HQ paused/.test(l)).length === 1);
check("another project isn't paused", spendPaused("other") === null);

// Model runs are refused while paused.
const runs: string[] = [];
const fake = { run: async () => (runs.push("ran"), { text: "ok", tokens: { input: 1, cached: 0, output: 1 } }) };
const runner = new MeteredRunner(db, { provider: () => null }, fake, fake);
let err = "";
try {
  await runner.run({ account: "default", model: "claude-haiku-5-5", prompt: "x", maxTokens: 10, purpose: "helper", projectId: "shop" });
} catch (e) {
  err = (e as Error).message;
}
check("a model run for a paused project is refused", /paused at its daily spend cap/.test(err) && runs.length === 0, err);
await runner.run({ account: "default", model: "claude-haiku-5-5", prompt: "x", maxTokens: 10, purpose: "helper", projectId: "other" });
check("…another project's still runs", runs.length === 1);

// Raising the cap lifts it; so does the next day.
caps = { dailyUsd: 10, monthlyUsd: 50 };
await guard.check(now);
check("a raised cap lifts the pause and tells the lead", spendPaused("shop") === null && log.some((l) => /pause is over/.test(l)));
caps = { dailyUsd: 5, monthlyUsd: 50 };
await guard.check(now);
check("back under a lowered cap: paused again", spendPaused("shop") === "day");
await guard.check(new Date(2026, 10, 14, 0, 5));
check("the next day lifts it", spendPaused("shop") === null);

// The month cap holds across days.
spendRow("shop", "acme-key", 40, new Date(2026, 10, 14, 1, 0)); // month total now over $50
s = await guard.check(new Date(2026, 10, 14, 2, 0));
check("over the monthly cap: paused for the month", s.paused === "month" && log.some((l) => l.startsWith("alert spend-pause-2026-11")), JSON.stringify(s));
s = await guard.check(new Date(2026, 11, 1, 0, 1));
check("…until the 1st", s.paused === null && spendPaused("shop") === null);

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
