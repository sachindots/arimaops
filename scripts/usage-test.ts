// Token usage from the CLIs' own logs. Run: npx tsx scripts/usage-test.ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeDirKey, claudeTokens, codexRollout, diff, UsageMeter } from "../server/usage";

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) fails++;
};

const msg = (id: string, input: number, write: number, read: number, out: number) =>
  JSON.stringify({ type: "assistant", message: { id, usage: { input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: out } } });
const claudeLog = [msg("a", 10, 100, 1000, 5), msg("a", 10, 100, 1000, 5), msg("b", 2, 0, 2000, 7), '{"type":"user"}', "{broken"].join("\n");
const t = claudeTokens(claudeLog);
check("claude: a message logged twice counts once", t.input === 112 && t.cached === 3000 && t.output === 12, JSON.stringify(t));
check("claude: folder key matches Claude Code's naming", claudeDirKey("/home/x/.hq/p/cipher") === "-home-x--hq-p-cipher");

const tc = (input: number, cached: number, out: number) =>
  JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: out } } } });
const codexLog = [JSON.stringify({ type: "session_meta", payload: { cwd: "/w/nyx" } }), tc(100, 60, 5), tc(300, 200, 9)].join("\n");
const r = codexRollout(codexLog);
check("codex: last running total wins, cached split out", r.cwd === "/w/nyx" && r.tokens.input === 100 && r.tokens.cached === 200 && r.tokens.output === 9, JSON.stringify(r));

// UsageMeter against a fake home
const home = mkdtempSync(join(tmpdir(), "hq-usage-"));
const cdir = join(home, ".claude", "projects", claudeDirKey("/w/cipher"));
mkdirSync(cdir, { recursive: true });
writeFileSync(join(cdir, "s1.jsonl"), claudeLog);
const now = new Date();
const day = join(home, ".codex", "sessions", String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));
mkdirSync(day, { recursive: true });
writeFileSync(join(day, "rollout-1.jsonl"), codexLog);
writeFileSync(join(day, "rollout-2.jsonl"), [JSON.stringify({ type: "session_meta", payload: { cwd: "/w/other" } }), tc(999, 0, 9)].join("\n"));
const meter = new UsageMeter(home);
check("meter: claude agent totals", meter.read("claude", "/w/cipher")?.cached === 3000);
check("meter: codex counts only this agent's folder", meter.read("codex", "/w/nyx")?.input === 100);
check("meter: unknown CLI is null, not zero", meter.read("agy", "/w/lyra") === null);
check("diff never goes negative", diff({ input: 1, cached: 1, output: 1 }, { input: 5, cached: 0, output: 0 }).input === 0);


// Per model, prices and usage events.
{
  const { claudeByModel, sumModels } = await import("../server/usage");
  const { estimateCost, priceId } = await import("../server/prices");
  const { hqDb } = await import("../server/lib/db");
  const { recordEvent, recordMeter, spend, taskUsage } = await import("../server/usageEvents");

  const m = (id: string, model: string, input: number, out: number) => JSON.stringify({ type: "assistant", message: { id, model, usage: { input_tokens: input, output_tokens: out } } });
  const split = claudeByModel([m("a", "claude-opus-5-5", 100, 10), m("b", "claude-sonnet-5-5", 50, 5), m("c", "claude-opus-5-5", 1, 1)].join("\n"));
  check("claude: totals split by model", split["claude-opus-5-5"].input === 101 && split["claude-sonnet-5-5"].output === 5 && sumModels(split).input === 151);
  check("codex: the model comes from the rollout", codexRollout([JSON.stringify({ type: "turn_context", payload: { model: "gpt-6.1-sol" } }), tc(10, 0, 1)].join("\n")).model === "gpt-6.1-sol");

  check("aliases and suffixes resolve to a price row", priceId("opus") === "claude-opus-5-5" && priceId("claude-opus-5-5[1m]") === "claude-opus-5-5" && priceId("anthropic/claude-sonnet-4-6") === "claude-sonnet-4-6");
  check("cost: 1M input + 1M cached + 1M output of Opus 5.5 is $24.20", Math.abs((estimateCost("claude-opus-5-5", { input: 1e6, cached: 1e6, output: 1e6 }) ?? 0) - 24.2) < 1e-9);
  check("an unknown model has no cost", estimateCost("gpt-6.1-sol", { input: 1e6, cached: 0, output: 0 }) === null);

  const db = hqDb(mkdtempSync(join(tmpdir(), "hq-usage-db-")));
  const who = { projectId: "p", agentId: "ghost", taskId: "T1", account: "default", provider: "anthropic" as const, cli: "claude" as const };
  const first = recordMeter(db, who, { "claude-opus-5-5": { input: 1000, cached: 0, output: 100 } });
  const second = recordMeter(db, who, { "claude-opus-5-5": { input: 1500, cached: 200, output: 150 } });
  const third = recordMeter(db, who, { "claude-opus-5-5": { input: 1500, cached: 200, output: 150 } });
  check("the first read records what the logs hold", first.length === 1 && first[0].tokens.input === 1000);
  check("two reads write one delta", second.length === 1 && second[0].tokens.input === 500 && second[0].tokens.cached === 200 && second[0].tokens.output === 50);
  check("an unchanged read writes nothing", third.length === 0);
  check("each event carries its estimated cost", Math.abs((second[0].costUsd ?? 0) - (500 * 4 + 200 * 0.2 + 50 * 20) / 1e6) < 1e-12);
  const shrunk = recordMeter(db, { ...who, taskId: "T2" }, { "claude-opus-5-5": { input: 300, cached: 0, output: 30 } });
  const after = recordMeter(db, { ...who, taskId: "T2" }, { "claude-opus-5-5": { input: 400, cached: 0, output: 40 } });
  check("logs that shrink restart the count instead of hiding new work", shrunk.length === 0 && after[0]?.tokens.input === 100);
  const other = recordMeter(db, { ...who, cli: "codex", provider: "openai" }, { "gpt-6.1-sol": { input: 10, cached: 0, output: 1 } });
  check("an unpriced model's event has costUsd null", other[0].costUsd === null);
  check("tokens add up per task", taskUsage(db, "p").get("T1")?.input === 1510 && taskUsage(db, "p").get("T2")?.input === 100);
  const s = spend(db, { projectId: "p" });
  check("spend sums tokens and priced cost, and counts unpriced events", s.input === 1610 && s.unpriced === 1 && s.costUsd > 0);
  recordEvent(db, { projectId: "q", agentId: null, taskId: null, source: "helper", account: "default", provider: "anthropic", cli: null, model: "claude-haiku-5-5", tokens: { input: 1000, cached: 0, output: 100 } });
  check("one-shot runs record directly, and spend reads by account", spend(db, { account: "default" }).input === 2610);
}

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
