// Free models an agent can run through the OpenCode CLI, read from models.dev's public catalog (the same catalog
// OpenCode uses). A model counts as free when its listed price is 0 in and out, it can call tools and it writes
// text. The lists rotate, so HQ re-reads them daily (server/freeModels.ts). Shared by server and UI.

import type { Provider } from "./providers";

/** Where a free model comes from: the models.dev provider id, which is also OpenCode's provider prefix. */
export const FREE_SOURCES = ["opencode", "openrouter", "nvidia", "amd"] as const;
export type FreeSource = (typeof FREE_SOURCES)[number];

export const FREE_SOURCE_INFO: Record<FreeSource, { label: string; account: Provider | null; signup: string; limits: string }> = {
  opencode: { label: "OpenCode Zen", account: null, signup: "https://opencode.ai/zen", limits: "No key. Free for a limited time; the list rotates." },
  openrouter: { label: "OpenRouter", account: "openrouter", signup: "https://openrouter.ai/keys", limits: "About 50 requests a day, 20 a minute (1,000 a day after a $10 top-up)." },
  nvidia: { label: "NVIDIA NIM", account: "nvidia", signup: "https://build.nvidia.com", limits: "About 40 requests a minute across the account. For development, not production." },
  amd: { label: "AMD Token Lab", account: "amd", signup: "https://notebooks.amd.com/tokenlab", limits: "AMD AI Developer Program points, about 20 requests a minute, valid 30 days." },
};

/** models.dev lists AMD's China-region endpoint; Token Lab (global) serves the same models here. */
export const AMD_TOKENLAB_URL = "https://api.tokenlab.amd.com/v1";

export interface FreeModel {
  /** OpenCode model id: "<source>/<model>", e.g. "opencode/glm-5.3-flash-free". */
  id: string;
  source: FreeSource;
  name: string;
  family: string;
  context: number;
  reasoning: boolean;
  released: string;
}

export interface FreeModelsState {
  models: FreeModel[];
  checkedAt: string;
  error: string | null;
}

/** Below this context a model can't hold a coding agent's working set. */
const MIN_CONTEXT = 64_000;

interface DevModel {
  id?: string;
  name?: string;
  family?: string;
  status?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  release_date?: string;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number };
  cost?: { input?: number; output?: number };
}

/** The free, tool-calling text models in a models.dev api.json body, best first per source. */
export function parseFreeModels(body: unknown): FreeModel[] {
  const out: FreeModel[] = [];
  const providers = (body && typeof body === "object" ? body : {}) as Record<string, { models?: Record<string, DevModel> }>;
  for (const source of FREE_SOURCES) {
    for (const [key, m] of Object.entries(providers[source]?.models ?? {})) {
      if (m.cost?.input !== 0 || m.cost?.output !== 0 || !m.tool_call || m.status === "deprecated") continue;
      if (!m.modalities?.output?.includes("text") || !m.modalities?.input?.includes("text")) continue;
      if ((m.limit?.context ?? 0) < MIN_CONTEXT || key === "free") continue; // "openrouter/free" is a router, not a model
      out.push({ id: `${source}/${key}`, source, name: m.name ?? key, family: m.family ?? "", context: m.limit?.context ?? 0, reasoning: !!m.reasoning, released: m.release_date ?? "" });
    }
  }
  return out.sort((a, b) => FREE_SOURCES.indexOf(a.source) - FREE_SOURCES.indexOf(b.source) || rank(b) - rank(a));
}

/** Newer, reasoning, longer context ranks higher. */
function rank(m: FreeModel): number {
  return (Date.parse(m.released) || 0) / 8.64e7 + (m.reasoning ? 120 : 0) + Math.min(m.context, 1_000_000) / 10_000;
}

export const freeSourceOf = (modelId: string): FreeSource | null => FREE_SOURCES.find((s) => modelId.startsWith(`${s}/`)) ?? null;

const tokens = (id: string) => new Set(id.toLowerCase().split(/[^a-z0-9.]+/).filter((t) => t && t !== "free"));

/**
 * The free model to use in place of `oldId` when it left the free list: same source and family first, then the
 * most shared name parts, then the best ranked. Sources the owner has no key for are skipped (`usable`).
 */
export function closestFree(oldId: string, list: FreeModel[], usable: (s: FreeSource) => boolean = () => true): FreeModel | null {
  const src = freeSourceOf(oldId);
  const old = tokens(oldId.slice((src?.length ?? -1) + 1));
  const score = (m: FreeModel) => (m.source === src ? 1000 : 0) + [...tokens(m.id.slice(m.source.length + 1))].filter((t) => old.has(t)).length * 100 + rank(m) / 1000;
  return list.filter((m) => m.id !== oldId && usable(m.source)).sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** The best free model for coding from the sources the owner can use, or null. */
export function bestFree(list: FreeModel[], usable: (s: FreeSource) => boolean = () => true): FreeModel | null {
  return list.find((m) => usable(m.source)) ?? null;
}
