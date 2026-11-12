// SPDX-License-Identifier: AGPL-3.0-or-later
// Estimated cost of model runs. Estimates only: the provider's bill is the truth, a subscription
// is billed flat, and HQ's meters count cache writes at the plain input rate.
// A model without a row gets no estimate (null), never a guess.

import type { Tokens } from "../src/data/types";

/** USD per million tokens. */
interface Price {
  input: number;
  cached: number;
  output: number;
}

/** Anthropic's first-party API prices as of 2026-11-03. Cache reads are 0.1× input where Anthropic lists none. */
export const PRICES_AS_OF = "2026-11-03";
const CLAUDE: Record<string, Price> = {
  "claude-fable-5-2": { input: 8, cached: 0.2, output: 40 },
  "claude-opus-5-5": { input: 4, cached: 0.2, output: 20 },
  "claude-opus-5": { input: 5, cached: 0.5, output: 25 },
  "claude-opus-4-8": { input: 5, cached: 0.5, output: 25 },
  "claude-opus-4-7": { input: 5, cached: 0.5, output: 25 },
  "claude-opus-4-6": { input: 5, cached: 0.5, output: 25 },
  "claude-sonnet-5-5": { input: 2, cached: 0.1, output: 10 },
  "claude-sonnet-5": { input: 2, cached: 0.2, output: 10 },
  "claude-sonnet-4-6": { input: 3, cached: 0.3, output: 15 },
  // shortcut: Haiku 5.5 doubles past 100K-token prompts; per-message prompt sizes aren't metered, so this is a floor.
  "claude-haiku-5-5": { input: 0.1, cached: 0.01, output: 0.5 },
  "claude-haiku-4-5": { input: 1, cached: 0.1, output: 5 },
};
/** Claude Code's model aliases mean the current model of each family. */
const ALIASES: Record<string, string> = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5", fable: "claude-fable-5-2" };

/** "claude-opus-5-5[1m]", "anthropic/claude-sonnet-4-6" or "opus" → the price table's id. */
export function priceId(model: string): string {
  const bare = model.trim().toLowerCase().replace(/\[.*\]$/, "").replace(/^.*\//, "");
  return ALIASES[bare] ?? bare;
}

export function estimateCost(model: string, t: Tokens): number | null {
  const p = CLAUDE[priceId(model)];
  if (!p) return null;
  return (t.input * p.input + t.cached * p.cached + t.output * p.output) / 1_000_000;
}
