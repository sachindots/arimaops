// One-shot Claude Haiku call for HQ's own small judgements (stuck agent, repo facts), billed to your Claude plan.
// No tools, no MCP servers, nothing saved, TokenEconomizer off; runs in a temp folder, so no agent hooks fire.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tokens } from "../../src/data/types";
import { run } from "./exec";

export interface HaikuAnswer<T> {
  json: T;
  tokens: Tokens;
}

/** First JSON object in a model reply (it may wrap it in prose or a code fence). */
export function firstJson<T>(text: string): T | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/** Asks Haiku for a JSON object. Null on any failure (not signed in, usage limit, timeout, bad JSON). */
export async function askHaiku<T>(prompt: string): Promise<HaikuAnswer<T> | null> {
  const r = await run(
    "claude",
    ["-p", "--model", "haiku", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--no-session-persistence"],
    { cwd: mkdtempSync(join(tmpdir(), "hq-haiku-")), timeoutMs: 60_000, input: prompt, env: { TE_DISABLE: "1", HQ_SIDECALL: "1" } },
  );
  if (!r.ok) return null;
  const out = firstJson<{ result?: string; is_error?: boolean; usage?: Record<string, number> }>(r.stdout);
  if (!out || out.is_error || !out.result) return null;
  const json = firstJson<T>(out.result);
  if (!json) return null;
  const u = out.usage ?? {};
  return { json, tokens: { input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), cached: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0 } };
}
