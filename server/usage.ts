// Token usage per agent, read from the CLIs' own session logs (no API, nothing estimated).
// Claude Code: ~/.claude/projects/<folder key>/*.jsonl, one `usage` block per assistant message.
// Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, running totals in `token_count` events.
// Other CLIs: null (shown as "n/a").

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { BRAND } from "../src/data/brand";

const LEGACY_HOMES: readonly string[] = BRAND.legacyHomeDirs;
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentCli, Tokens } from "../src/data/types";

export type { Tokens };

export const ZERO: Tokens = { input: 0, cached: 0, output: 0 };
export const add = (a: Tokens, b: Tokens): Tokens => ({ input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output });
export const diff = (now: Tokens, before: Tokens): Tokens => ({
  input: Math.max(0, now.input - before.input),
  cached: Math.max(0, now.cached - before.cached),
  output: Math.max(0, now.output - before.output),
});

/** Claude Code names a project's log folder after its path, every non-alphanumeric character as "-". */
export const claudeDirKey = (path: string) => path.replace(/[^a-zA-Z0-9]/g, "-");

/** Totals per model, and the sum of several. */
export type ByModel = Record<string, Tokens>;
export const sumModels = (m: ByModel): Tokens => Object.values(m).reduce(add, ZERO);
const addTo = (m: ByModel, model: string, t: Tokens) => void (m[model] = add(m[model] ?? ZERO, t));

/** A Claude Code transcript per model. A message can be logged more than once while it streams: count each id once. */
export function claudeByModel(jsonl: string): ByModel {
  const seen = new Map<string, { model: string; t: Tokens }>();
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"usage"')) continue;
    try {
      const m = (JSON.parse(line) as { message?: { id?: string; model?: string; usage?: Record<string, number> } }).message;
      const u = m?.usage;
      if (!u) continue;
      seen.set(m.id ?? `line${seen.size}`, {
        model: m.model || "unknown",
        t: { input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), cached: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0 },
      });
    } catch {
      /* a line still being written */
    }
  }
  const out: ByModel = {};
  for (const { model, t } of seen.values()) addTo(out, model, t);
  return out;
}

/** Sum of a Claude Code transcript. */
export const claudeTokens = (jsonl: string): Tokens => sumModels(claudeByModel(jsonl));

/** A Codex rollout's folder (from session_meta) and its final running total. */
export function codexRollout(jsonl: string): { cwd: string | null; model: string | null; tokens: Tokens } {
  let cwd: string | null = null;
  let model: string | null = null;
  let tokens = ZERO;
  for (const line of jsonl.split("\n")) {
    if (!model && line.includes('"model"') && (line.includes('"turn_context"') || line.includes('"session_meta"'))) {
      try {
        model = (JSON.parse(line) as { payload?: { model?: string } }).payload?.model || null;
      } catch {
        /* ignore */
      }
    }
    if (!cwd && line.includes('"session_meta"')) {
      try {
        cwd = (JSON.parse(line) as { payload?: { cwd?: string } }).payload?.cwd ?? null;
      } catch {
        /* ignore */
      }
    }
    if (!line.includes('"total_token_usage"')) continue;
    try {
      const t = (JSON.parse(line) as { payload?: { info?: { total_token_usage?: Record<string, number> } } }).payload?.info?.total_token_usage;
      if (!t) continue;
      const cachedIn = t.cached_input_tokens ?? 0;
      tokens = { input: Math.max(0, (t.input_tokens ?? 0) - cachedIn), cached: cachedIn, output: t.output_tokens ?? 0 };
    } catch {
      /* ignore */
    }
  }
  return { cwd, model, tokens };
}

const jsonlIn = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f)) : [];

/** Reads each log once per change (mtime + size), so polling stays cheap. */
export class UsageMeter {
  private cache = new Map<string, { stamp: string; value: unknown }>();
  constructor(private home = homedir()) {}

  private cached<T>(file: string, parse: (text: string) => T): T {
    const st = statSync(file);
    const stamp = `${st.mtimeMs}:${st.size}`;
    const hit = this.cache.get(file);
    if (hit?.stamp === stamp) return hit.value as T;
    const value = parse(readFileSync(file, "utf8"));
    this.cache.set(file, { stamp, value });
    return value;
  }

  /** Total tokens an agent's CLI has used in `dir` (its workspace), or null when HQ can't read that CLI's logs. */
  /** `cliHome`: another account's config folder (CLAUDE_CONFIG_DIR / CODEX_HOME); null = the CLI's usual one. */
  read(cli: AgentCli, dir: string, cliHome: string | null = null): Tokens | null {
    const m = this.readByModel(cli, dir, cliHome);
    return m && sumModels(m);
  }

  /** The same totals per model. Codex logs without a model name count under `fallbackModel`. */
  readByModel(cli: AgentCli, dir: string, cliHome: string | null = null, fallbackModel = "unknown"): ByModel | null {
    // The same folder under its earlier paths (~/.hq before the move to ~/.arima): the CLIs filed those logs by path.
    const dirs = [dir, ...LEGACY_HOMES.map((h) => dir.replace(`/${BRAND.homeDir}/`, `/${h}/`)).filter((d) => d !== dir)];
    try {
      const out: ByModel = {};
      if (cli === "claude") {
        for (const f of dirs.flatMap((d) => jsonlIn(join(cliHome ?? join(this.home, ".claude"), "projects", claudeDirKey(d)))))
          for (const [model, t] of Object.entries(this.cached(f, claudeByModel))) addTo(out, model, t);
        return out;
      }
      if (cli === "codex") {
        for (const r of this.codexFiles(cliHome).map((f) => this.cached(f, codexRollout)))
          if (r.cwd && dirs.includes(r.cwd)) addTo(out, r.model ?? fallbackModel, r.tokens);
        return out;
      }
    } catch {
      /* unreadable log: treat as unknown */
    }
    return null;
  }

  // shortcut: scans the last 14 days of Codex sessions; older work isn't counted. Fine for a running team.
  private codexFiles(cliHome: string | null): string[] {
    const root = join(cliHome ?? join(this.home, ".codex"), "sessions");
    const files: string[] = [];
    for (let d = 0; d < 14; d++) {
      const day = new Date(Date.now() - d * 86_400_000);
      const p = join(root, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
      files.push(...jsonlIn(p));
    }
    return files;
  }
}
