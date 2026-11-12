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

export function memoryWorker(): MemoryWorker {
  if (!shared) {
    const db = hqDb();
    const runner = new MeteredRunner(db, { provider: providerOf }, new ClaudeCliRunner(), new AnthropicKeyRunner((id) => accounts().keyFor(id, "anthropic")));
    shared = new MemoryWorker(memoryStore(), runner, extractionSettings, (p) => projectTemplate(db, p)?.memoryTypes ?? []);
  }
  return shared;
}
