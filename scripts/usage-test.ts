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

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
