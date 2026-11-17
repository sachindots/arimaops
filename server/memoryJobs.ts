// SPDX-License-Identifier: AGPL-3.0-or-later
// The machine's memory worker: extraction and consolidation through the metered model runner, on the
// account chosen in Settings → Memory. Built once, like the memory store.

import type { Provider } from "../src/data/providers";
import { accounts } from "./credentials/registry";
import { hqDb } from "./lib/db";
import { extractionSettings, memoryStore } from "./memory";
import { MemoryWorker } from "./memoryExtract";
import { AnthropicKeyRunner, ClaudeCliRunner, MeteredRunner } from "./modelRunner";
import { projectTemplate } from "./templates";

let shared: MemoryWorker | null = null;

const providerOf = (id: string): Provider | null => {
  try {
    return accounts().get(id)?.provider ?? null;
  } catch {
    return null; // no vault: only the CLI sign-in
  }
};

let runner: MeteredRunner | null = null;

/** The metered runner HQ's own helper calls use (extraction, lesson promotion): usage counts toward spend caps. */
export function helperRunner(): MeteredRunner {
  return (runner ??= new MeteredRunner(hqDb(), { provider: providerOf }, new ClaudeCliRunner(), new AnthropicKeyRunner((id) => accounts().keyFor(id, "anthropic"))));
}

export function memoryWorker(): MemoryWorker {
  if (!shared) {
    const db = hqDb();
    shared = new MemoryWorker(memoryStore(), helperRunner(), extractionSettings, (p) => projectTemplate(db, p)?.memoryTypes ?? []);
  }
  return shared;
}
