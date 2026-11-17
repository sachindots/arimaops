// SPDX-License-Identifier: AGPL-3.0-or-later
// `arimaops setup`: the terminal side of one-shot setup (src/data/teamSetup.ts). It reads this machine's facts,
// prints the proposed model per role, and with --apply makes HQ use that proposal for every new project.

import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { FREE_SOURCE_INFO } from "../src/data/freeModels";
import type { TeamTemplate } from "../src/data/model";
import { proposeSetup, type SetupFacts } from "../src/data/teamSetup";
import { BUILTIN_TEMPLATES } from "../src/data/templates";
import { CLI_LABEL, type AgentCli } from "../src/data/types";
import { localBinary } from "./adapters";
import { accountsState } from "./credentials/registry";
import { freeModelsState, refreshFreeModels } from "./freeModels";
import { readDoc, writeDoc } from "./lib/docs";
import { run } from "./lib/exec";
import { homeRoot } from "./paths";

const prefFile = () => join(homeRoot(), "model-setup.json");

/** True after `arimaops setup --apply`: new projects start with the proposal instead of the template's models. */
export const autoSetup = () => !!readDoc<{ apply?: boolean }>(prefFile())?.apply;

/** CLIs installed here, saved keys, RAM and the free list (refreshed when older than a day). */
export async function machineFacts(): Promise<SetupFacts> {
  const clis = Object.keys(localBinary) as AgentCli[];
  const found = await Promise.all(clis.map(async (c) => ((await run(localBinary[c], ["--version"], { timeoutMs: 8000 })).ok ? c : null)));
  // Sandboxes bring Claude Code and Codex with them.
  const sbx = (await run("sbx", ["version"], { timeoutMs: 8000 })).ok;
  const have = new Set([...found.filter((c): c is AgentCli => !!c), ...(sbx ? (["claude", "codex"] as const) : [])]);
  let free = freeModelsState();
  if (Date.now() - (Date.parse(free.checkedAt) || 0) > 24 * 3600_000) free = await refreshFreeModels();
  return {
    ramGb: Math.round(totalmem() / 1024 ** 3),
    cpus: cpus().length,
    clis: [...have],
    keys: [...new Set(accountsState().list.filter((a) => a.secret).map((a) => a.provider))],
    free: free.models,
  };
}

/** The template with every role on its proposed CLI, model and fallback. */
export function withProposal(t: TeamTemplate, facts: SetupFacts): TeamTemplate {
  const picks = new Map(proposeSetup(t.roles, facts).roles.map((p) => [p.roleId, p]));
  return { ...t, roles: t.roles.map((r) => {
    const p = picks.get(r.id);
    return p ? { ...r, cli: p.cli, model: p.model, fallback: p.fallback } : r;
  }) };
}

export async function setupCli(args: string[]) {
  const id = args[args.indexOf("--template") + 1];
  const t = (args.includes("--template") && BUILTIN_TEMPLATES.find((x) => x.id === id)) || BUILTIN_TEMPLATES[0];
  if (args.includes("--template") && t.id !== id) console.log(`No built-in template "${id}"; showing ${t.id}. Templates: ${BUILTIN_TEMPLATES.map((x) => x.id).join(", ")}`);
  const f = await machineFacts();
  const p = proposeSetup(t.roles, f);
  console.log(`ArimaOps setup · ${f.ramGb} GB RAM · ${f.cpus} CPUs`);
  console.log(`CLIs: ${f.clis.map((c) => CLI_LABEL[c]).join(", ") || "none found"}`);
  console.log(`Keys: ${f.keys.join(", ") || "none"} · free models: ${f.free.length}\n`);
  console.log(`Team "${t.name}":`);
  for (const r of p.roles)
    console.log(`  ${r.title.padEnd(16)} ${`${CLI_LABEL[r.cli]} · ${r.model || "default"}${r.free ? " (free)" : ""}`.padEnd(52)} at a limit: ${r.fallback ? `${CLI_LABEL[r.fallback.cli]} · ${r.fallback.model}` : "waits"}`);
  console.log(`\nSandboxes: ${p.sandbox.cpus} CPUs · ${p.sandbox.memoryGb} GB each (about ${p.maxAgents} agents at once).`);
  if (p.install.length) console.log(`\nRun first:\n  ${p.install.join("\n  ")}`);
  if (p.keysToAdd.length) {
    console.log("\nMore free models with a key (add it in HQ: Settings → Accounts):");
    for (const k of p.keysToAdd) console.log(`  ${FREE_SOURCE_INFO[k.source].label.padEnd(14)} ${k.signup}  (${k.limits})`);
  }
  if (args.includes("--apply")) {
    writeDoc(prefFile(), { apply: true, at: new Date().toISOString() });
    console.log("\nSaved: new projects start with these picks (worked out again on this machine when each is made).");
    console.log("For a project you already have: Settings → Team → Set up models in one step.");
  } else if (args.includes("--off")) {
    writeDoc(prefFile(), { apply: false, at: new Date().toISOString() });
    console.log("\nNew projects use their template's models again.");
  } else console.log("\nRun `arimaops setup --apply` to use this for new projects.");
}
