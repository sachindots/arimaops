// Token usage per agent, read from the CLIs' own session logs (no API, nothing estimated).
// Claude Code: ~/.claude/projects/<folder key>/*.jsonl, one `usage` block per assistant message.
// Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, running totals in `token_count` events.
// Other CLIs: null (shown as "n/a").

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

/** Sum of a Claude Code transcript. A message can be logged more than once while it streams: count each id once. */
export function claudeTokens(jsonl: string): Tokens {
  const seen = new Map<string, Tokens>();
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"usage"')) continue;
    try {
      const m = (JSON.parse(line) as { message?: { id?: string; usage?: Record<string, number> } }).message;
      const u = m?.usage;
      if (!u) continue;
      seen.set(m.id ?? `line${seen.size}`, {
        input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        cached: u.cache_read_input_tokens ?? 0,
        output: u.output_tokens ?? 0,
      });
    } catch {
      /* a line still being written */
    }
  }
  return [...seen.values()].reduce(add, ZERO);
}

/** A Codex rollout's folder (from session_meta) and its final running total. */
export function codexRollout(jsonl: string): { cwd: string | null; tokens: Tokens } {
  let cwd: string | null = null;
  let tokens = ZERO;
  for (const line of jsonl.split("\n")) {
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
  return { cwd, tokens };
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
  read(cli: AgentCli, dir: string): Tokens | null {
    try {
      if (cli === "claude") return jsonlIn(join(this.home, ".claude", "projects", claudeDirKey(dir))).map((f) => this.cached(f, claudeTokens)).reduce(add, ZERO);
      if (cli === "codex") return this.codexFiles().map((f) => this.cached(f, codexRollout)).filter((r) => r.cwd === dir).map((r) => r.tokens).reduce(add, ZERO);
    } catch {
      /* unreadable log: treat as unknown */
    }
    return null;
  }

  // shortcut: scans the last 14 days of Codex sessions; older work isn't counted. Fine for a running team.
  private codexFiles(): string[] {
    const root = join(this.home, ".codex", "sessions");
    const files: string[] = [];
    for (let d = 0; d < 14; d++) {
      const day = new Date(Date.now() - d * 86_400_000);
      const p = join(root, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
      files.push(...jsonlIn(p));
    }
    return files;
  }
}
