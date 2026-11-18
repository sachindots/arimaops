// One-shot setup: from what this machine has (CLIs, keys, RAM, the live free list), propose a CLI and model for every
// role of a template, a free fallback for each, and a sandbox size. Paid models go to the lead and the builders; free
// models to the light roles (review, QA, docs, research). Pure, so the setup wizard and `arimaops setup` share it.

import { bestFree, FREE_SOURCES, FREE_SOURCE_INFO, type FreeModel, type FreeSource } from "./freeModels";
import type { Role } from "./model";
import type { Provider } from "./providers";
import { SANDBOX_DEFAULT, type AgentCli } from "./types";

export interface SetupFacts {
  ramGb: number;
  cpus: number;
  /** CLIs that run here (installed for Local mode, or available in sandboxes). */
  clis: AgentCli[];
  /** Providers with a saved API key. */
  keys: Provider[];
  free: FreeModel[];
}

export interface RolePick {
  roleId: string;
  title: string;
  cli: AgentCli;
  model: string;
  fallback: { cli: AgentCli; model: string } | null;
  free: boolean;
  why: string;
}

export interface SetupProposal {
  roles: RolePick[];
  sandbox: { cpus: number; memoryGb: number };
  /** Agents that fit in RAM at once at that sandbox size. */
  maxAgents: number;
  /** Commands to run first (the owner runs them). */
  install: string[];
  /** Free sources the owner could add a key for, with where to get one. */
  keysToAdd: { source: FreeSource; label: string; signup: string; limits: string }[];
}

/** Roles that read, check or write words rather than build. */
// The verifier is not light: it runs the app in its own browser image, built for Claude Code.
const LIGHT = /review|second|qa|test|doc|writ|edit|report|research|recon|analy|scribe/i;

/** Paid picks by CLI, strongest first: [lead, builder]. */
const PAID: Partial<Record<AgentCli, [string, string]>> = {
  claude: ["claude-opus-5-5", "claude-sonnet-5-5"],
  codex: ["gpt-6.1-sol", "gpt-6-sol"],
  agy: ["claude-opus-5-5-high", "claude-sonnet-5-5-high"],
};
const AGY_FREE = "gemini-3.8-flash-high";
const SANDBOX_GB = SANDBOX_DEFAULT.memoryGb;
const RESERVED_GB = 3;

export function proposeSetup(roles: Role[], f: SetupFacts): SetupProposal {
  const has = (c: AgentCli) => f.clis.includes(c);
  const usable = (s: FreeSource) => {
    const need = FREE_SOURCE_INFO[s].account;
    return !need || f.keys.includes(need);
  };
  // The best usable free model of each family. Light roles take them in turn, so a reviewer and a second opinion
  // land on different models: a check by the same model as the work it checks catches little.
  const families = f.free.filter((m, i, all) => usable(m.source) && all.findIndex((x) => usable(x.source) && (x.family || x.id) === (m.family || m.id)) === i);
  const free = bestFree(f.free, usable);
  // OpenCode installs itself in sandboxes; on the host the owner installs it once.
  const freePick = free ? { cli: "opencode" as const, model: free.id } : has("agy") ? { cli: "agy" as const, model: AGY_FREE } : null;
  let turn = 0;
  const lightPick = () => (families.length ? { cli: "opencode" as const, model: families[turn++ % families.length].id } : freePick);
  const paidCli = (["claude", "codex", "agy"] as const).find((c) => has(c));

  const picks = roles.map((r): RolePick => {
    const light = !r.isLead && LIGHT.test(`${r.id} ${r.title}`);
    const paid = paidCli && PAID[paidCli] ? { cli: paidCli, model: PAID[paidCli]![r.isLead ? 0 : 1] } : null;
    const lightFree = light ? lightPick() : null;
    const main = light ? (lightFree ?? paid) : (paid ?? freePick);
    if (!main) return { roleId: r.id, title: r.title, cli: r.cli, model: r.model, fallback: r.fallback, free: false, why: "No CLI found: kept as it is." };
    const isFree = main === freePick || main === lightFree;
    const second = has("agy") && main.cli !== "agy" ? { cli: "agy" as const, model: AGY_FREE } : null;
    const fallback = isFree ? second : freePick;
    return {
      roleId: r.id,
      title: r.title,
      ...main,
      fallback: r.isLead ? null : fallback, // the lead never moves CLI mid-task
      free: isFree,
      why: r.isLead ? "Lead: the strongest paid model you have." : light ? (isFree ? "Light role: a free model is enough." : "Light role, but no free model is usable: paid.") : isFree ? "No paid CLI found: free." : "Builder: paid model, free fallback at limits.",
    };
  });

  const install = picks.some((p) => p.cli === "opencode" || p.fallback?.cli === "opencode") && !has("opencode") ? ["npm install -g opencode-ai"] : [];
  const keysToAdd = FREE_SOURCES.filter((s) => !usable(s)).map((s) => ({ source: s, ...FREE_SOURCE_INFO[s] }));
  const cpus = Math.max(1, Math.min(2, f.cpus));
  return { roles: picks, sandbox: { cpus, memoryGb: SANDBOX_GB }, maxAgents: Math.max(1, Math.floor((f.ramGb - RESERVED_GB) / SANDBOX_GB)), install, keysToAdd };
}
