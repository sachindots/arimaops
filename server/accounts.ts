// What agents on one machine share, whatever project they work in: the CLI's
// subscription (one Claude / ChatGPT / Google account per CLI here) and the
// machine's memory. A usage limit hit by one agent applies to every agent on
// that CLI; the number of agents running at once is capped by RAM.

import { totalmem } from "node:os";
import type { AgentCli } from "../src/data/types";
import type { Hub } from "./hub";

export interface LimitFrom {
  project: string;
  agentId: string;
  name: string;
}
type Listener = (cli: AgentCli, until: Date, from: LimitFrom) => void;

const listeners = new Set<Listener>();

/** Each loaded project listens; returns the unsubscribe. */
export function onAccountLimit(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** An agent hit its CLI's usage limit: tell every project. */
export function shareLimit(cli: AgentCli, until: Date, from: LimitFrom) {
  for (const fn of listeners) fn(cli, until, from);
}

/**
 * Marks this project's other running agents on `cli` limited until `until` (unless already limited as long).
 * shortcut: assumes one account per CLI on this machine; per-agent accounts would need an account id on each agent.
 */
export function markLimited(hub: Hub, cli: AgentCli, until: Date, from: LimitFrom): string[] {
  const marked: string[] = [];
  const at = until.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  for (const a of hub.snap.config.team) {
    if (a.cli !== cli || (hub.slug === from.project && a.id === from.agentId)) continue;
    const st = hub.status(a.id);
    if (!st || (st.session.state !== "running" && st.session.state !== "starting")) continue;
    if (st.limitedUntil && Date.parse(st.limitedUntil) >= until.getTime()) continue;
    hub.setStatus(a.id, { limitedUntil: until.toISOString(), note: `Usage limit until ${at} (shared account: ${from.name} hit it)` });
    marked.push(a.name);
  }
  return marked;
}

/** Rough memory one agent's CLI process takes (Claude Code and agy are Node apps; Codex is lighter). */
const AGENT_MB = 500;
const RESERVED_MB = 2048; // the OS, HQ itself, your editor and browser

/** Agents that may run at once on this machine: ARIMA_MAX_AGENTS, else what the RAM allows. */
export function maxAgents(totalBytes = totalmem(), env = process.env.ARIMA_MAX_AGENTS): number {
  const fromEnv = Number(env);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return Math.max(2, Math.floor((totalBytes / 2 ** 20 - RESERVED_MB) / AGENT_MB));
}

/** Agents running or starting across these projects. */
export function runningAgents(hubs: Hub[]): number {
  return hubs.reduce((n, h) => n + h.snap.agents.filter((a) => a.session.state === "running" || a.session.state === "starting").length, 0);
}
