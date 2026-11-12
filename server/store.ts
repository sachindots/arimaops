// Persistence in the repo: config.json (team + workflow) and plan.json (boards + tasks),
// both rows in .arima/arima.db (see lib/docs.ts). An older .hq/ or .jsmhq/ is read where it is (see paths.repoDirOf).

import { join } from "node:path";
import { isAgentCli, type Board, type HqConfig, type Task } from "../src/data/types";
import { hqDb } from "./lib/db";
import { readDoc, writeDoc } from "./lib/docs";
import { legacyRules } from "./legacy";
import { applyTemplate, projectTemplate, seatOf } from "./templates";
import { repoDirOf, slugify } from "./paths";
import type { RepoInfo } from "./repo";

export interface PlanFile {
  boards: Board[];
  tasks: Task[];
}

const dir = (root: string) => repoDirOf(root);


function defaultConfig(repo: RepoInfo, port: number): HqConfig {
  return {
    project: { id: slugify(repo.name), name: repo.name, repo: repo.github ?? repo.name, path: repo.root, hqPort: port },
    team: [], // the welcome screen picks a template, which makes the seats
    template: null,
    rules: legacyRules(null),
    workflow: {
      mode: repo.github ? "github-pr" : "deliverables",
      review: { enabled: true, tool: repo.hasCodeRabbit ? "coderabbit" : "human", command: "" },
      merge: { by: "human" },
      deploy: { enabled: repo.hasInsta, tool: "instacloud", command: "", perAgentEnvironments: repo.hasInsta },
    },
  };
}

/** `isNew`: no config yet — the welcome screen fills it in, then it's saved. */
export function loadConfig(repo: RepoInfo, port: number): { config: HqConfig; isNew: boolean } {
  const file = join(dir(repo.root), "config.json");
  const found = readDoc<HqConfig>(file);
  if (found) {
    // Older files may miss newer fields.
    for (const a of found.team) {
      a.workspacePath ??= null;
      a.mcp ??= [];
      a.sandbox.resources ??= { cpus: null, memoryGb: null };
      // Phase D: policy level, proxy and secret names moved to sbx itself.
      const old = a.sandbox as unknown as Record<string, unknown>;
      delete old.policy;
      delete old.proxy;
      delete old.secrets;
    }
    found.workflow.mode ??= repo.github ? "github-pr" : "deliverables";
    // Configs from before project.id: their resources are named after the current name.
    // Slugified again in case the file was edited by hand: it ends up in paths and sandbox names.
    found.project.id = slugify(found.project.id ?? found.project.name);
    found.project.path = repo.root;
    return { config: resolveSaved(found), isNew: false };
  }
  return { config: defaultConfig(repo, port), isNew: true };
}

/** Fills in what config.json doesn't keep: the template, its rules, and each seat's role. */
export function resolveSaved(found: HqConfig): HqConfig {
  const template = found.team.some((a) => a.roleId) ? projectTemplate(hqDb(), slugify(found.project.id ?? found.project.name)) : null;
  if (template) {
    applyTemplate(found, template);
    return found;
  }
  // Made before templates: read-only, with the rules its old type implied.
  found.template = null;
  found.rules = legacyRules((found.project as { type?: unknown }).type);
  for (const a of found.team) {
    if (!isAgentCli(a.cli)) a.cli = "claude";
    a.skills ??= [];
    a.roleMd ??= "";
  }
  return found;
}

/** The project's id (slug) as loadConfig will set it, read before anything is migrated. */
export function slugOf(repo: RepoInfo): string {
  try {
    const found = readDoc<HqConfig>(join(dir(repo.root), "config.json"));
    if (found) return slugify(found.project.id ?? found.project.name);
  } catch {
    /* unreadable: loadConfig reports it */
  }
  return slugify(repo.name);
}

export function saveConfig(root: string, cfg: HqConfig) {
  // The path is machine-specific; teammates get their own.
  const { path: _path, ...project } = cfg.project;
  const { template, rules: _rules, ...rest } = cfg;
  // A template project keeps only its seats here; roles live in the project's template copy.
  const team = template ? cfg.team.map(seatOf) : cfg.team;
  writeDoc(join(dir(root), "config.json"), { ...rest, team, project: { ...project, path: "" } });
}

export function loadPlan(root: string): PlanFile {
  return readDoc<PlanFile>(join(dir(root), "plan.json")) ?? { boards: [{ id: "B1", title: "Backlog", status: "active", order: 0 }], tasks: [] };
}

export function savePlan(root: string, plan: PlanFile) {
  writeDoc(join(dir(root), "plan.json"), plan);
}
