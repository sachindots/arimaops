// SPDX-License-Identifier: AGPL-3.0-or-later
// The live list of free models (src/data/freeModels.ts), read from models.dev once a day and kept in
// ~/.arima/free-models.json so a restart without network still has it. When a role's free model leaves the list,
// HQ moves the role to the closest free model it can use and tells the owner in the Inbox (an FYI, nothing to approve).

import { join } from "node:path";
import { closestFree, freeSourceOf, FREE_SOURCE_INFO, parseFreeModels, type FreeModel, type FreeModelsState, type FreeSource } from "../src/data/freeModels";
import { accounts } from "./credentials/registry";
import type { Hub } from "./hub";
import type { RolePatch } from "../src/data/types";
import { readDoc, writeDoc } from "./lib/docs";
import { log } from "./lib/log";
import { homeRoot } from "./paths";

const CATALOG = "https://models.dev/api.json";
export const DAY_MS = 24 * 3600_000;
const file = () => join(homeRoot(), "free-models.json");

let state: FreeModelsState = readDoc<FreeModelsState>(file()) ?? { models: [], checkedAt: "", error: null };
const listeners = new Set<(s: FreeModelsState) => void>();

export const freeModelsState = () => state;

/** Called with every new list; returns the unsubscribe. */
export function onFreeModels(fn: (s: FreeModelsState) => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Re-reads the catalog. A failed read keeps the last good list (and says why), so seats are never swapped on an outage. */
export async function refreshFreeModels(fetcher: typeof fetch = fetch): Promise<FreeModelsState> {
  try {
    const r = await fetcher(CATALOG, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`models.dev returned HTTP ${r.status}`);
    const models = parseFreeModels(await r.json());
    if (!models.length) throw new Error("models.dev listed no free models");
    state = { models, checkedAt: new Date().toISOString(), error: null };
    writeDoc(file(), state);
  } catch (err) {
    state = { ...state, error: err instanceof Error ? err.message : String(err) };
    log.warn(`free models: ${state.error}`);
  }
  for (const fn of listeners) fn(state);
  return state;
}

/** Sources this machine can use now: Zen needs no key; the others need an account with a saved key. */
export function usableSources(): (s: FreeSource) => boolean {
  const withKey = new Set(accounts().views().filter((v) => v.secret).map((v) => v.provider));
  return (s) => {
    const need = FREE_SOURCE_INFO[s].account;
    return !need || withKey.has(need);
  };
}

/** What a swap changed, for the owner's Inbox note. */
export interface Swap {
  who: string;
  from: string;
  to: string;
}

/**
 * Roles (and seats of a project without a template) whose free model, or free fallback, left the list move to the
 * closest free model this machine can use. A role's seats pick the change up at their next start.
 */
export function swapGoneModels(
  hub: Pick<Hub, "snap" | "configChanged" | "activity">,
  list: FreeModel[],
  updateRole: (roleId: string, patch: RolePatch) => void,
  usable = usableSources(),
): Swap[] {
  if (!list.length) return [];
  const ids = new Set(list.map((m) => m.id));
  const gone = (cli: string, model: string) => cli === "opencode" && !!freeSourceOf(model) && !ids.has(model);
  const next = (model: string) => closestFree(model, list, usable)?.id ?? null;
  const swaps: Swap[] = [];
  const t = hub.snap.config.template;
  for (const r of t?.roles ?? []) {
    const patch: RolePatch = {};
    const m = gone(r.cli, r.model) ? next(r.model) : null;
    if (m) (patch.model = m), swaps.push({ who: r.title, from: r.model, to: m });
    const f = r.fallback && gone(r.fallback.cli, r.fallback.model) ? next(r.fallback.model) : null;
    if (f && r.fallback) (patch.fallback = { cli: "opencode", model: f }), swaps.push({ who: `${r.title} (fallback)`, from: r.fallback.model, to: f });
    if (Object.keys(patch).length) updateRole(r.id, patch);
  }
  if (!t) {
    for (const a of hub.snap.config.team) {
      const m = gone(a.cli, a.model) ? next(a.model) : null;
      if (m) swaps.push({ who: a.name, from: a.model, to: m }), (a.model = m);
    }
    if (swaps.length) hub.configChanged();
  }
  for (const s of swaps) hub.activity("config", null, `${s.who}: free model ${s.from} is no longer free; switched to ${s.to} (from the next start).`);
  return swaps;
}
