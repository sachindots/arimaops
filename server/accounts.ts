// What agents on one machine share, whatever project they work in: the CLI's
// subscription (one Claude / ChatGPT / Google account per CLI here) and the
// machine's memory. A usage limit hit by one agent applies to every agent on
// that CLI; the number of agents running at once is capped by RAM.

import { lstatSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { join } from "node:path";
import { BRAND } from "../src/data/brand";
import type { AgentCli, AgentConfig } from "../src/data/types";
import type { Hub } from "./hub";

export interface LimitFrom {
  project: string;
  agentId: string;
  name: string;
  account: string;
}

/** "default" unless the agent names another account. */
export const accountOf = (a: Pick<AgentConfig, "account">) => a.account || "default";

/** Account names: short, lowercase, safe in volume names and paths. */
export const cleanAccount = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);

/** Where a local CLI keeps another account's sign-in and logs (the default account uses the CLI's usual folder). */
export function accountHome(cli: AgentCli, account: string, home = homedir()): string | null {
  if (account === "default") return null;
  return join(home, BRAND.homeDir, "accounts", `${cli}-${account}`);
}

/** Variables that point a local CLI at another account's folder. */
export function accountEnv(cli: AgentCli, account: string, home = homedir()): Record<string, string> {
  const dir = accountHome(cli, account, home);
  if (!dir) return {};
  if (cli === "claude") return { CLAUDE_CONFIG_DIR: dir };
  if (cli === "codex") return { CODEX_HOME: dir };
  // Antigravity, Gemini, Copilot and OpenCode have no config-folder setting: they get a home of their own (see mirrorHome),
  // and a dead keyring address, because a desktop keyring would hand every account the same saved sign-in.
  return { HOME: dir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(dir, ".no-keyring")}` };
}

/** True when the CLI's account folder is a whole home (mirrorHome) rather than a config folder. */
export const ownsHome = (cli: AgentCli) => cli !== "claude" && cli !== "codex";

/** Where these CLIs keep their sign-ins; an account home gets its own copy, everything else links to the real home. */
const OWN_PER_ACCOUNT = [".gemini", ".copilot", ".cache", ".config/antigravity", ".config/github-copilot", ".local/share/opencode", ".local/state"];

/** Fills an account home with links to the real home (git, ssh, gh, tools), keeping the sign-in folders its own. Safe to rerun. */
export function mirrorHome(dir: string, home = homedir(), rel = "") {
  mkdirSync(join(dir, rel), { recursive: true, mode: 0o700 });
  for (const name of readdirSync(join(home, rel))) {
    const path = rel ? `${rel}/${name}` : name;
    if (path === BRAND.homeDir || OWN_PER_ACCOUNT.includes(path)) continue;
    if (OWN_PER_ACCOUNT.some((p) => p.startsWith(`${path}/`))) mirrorHome(dir, home, path);
    else if (!lexists(join(dir, path))) symlinkSync(join(home, path), join(dir, path));
  }
}

function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
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

/** Marks this project's other running agents on the same CLI and account limited until `until` (unless already limited as long). */
export function markLimited(hub: Hub, cli: AgentCli, until: Date, from: LimitFrom): string[] {
  const marked: string[] = [];
  const at = until.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  for (const a of hub.snap.config.team) {
    if (a.cli !== cli || accountOf(a) !== from.account || (hub.slug === from.project && a.id === from.agentId)) continue;
    const st = hub.status(a.id);
    if (!st || (st.session.state !== "running" && st.session.state !== "starting")) continue;
    if (st.limitedUntil && Date.parse(st.limitedUntil) >= until.getTime()) continue;
    hub.setStatus(a.id, { limitedUntil: until.toISOString(), note: `Usage limit until ${at} (same ${cli} account as ${from.name})` });
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
