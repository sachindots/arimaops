// Persistence in the repo: config.json (team + workflow) and plan.json (boards + tasks),
// both rows in .arima/arima.db (see lib/docs.ts). An older .hq/ or .jsmhq/ is read where it is (see paths.repoDirOf).

import { join } from "node:path";
import { defaultRoleMdFor, defaultSkillsForRole, inferDepartmentForRole } from "../src/data/roles";
import { isAgentCli, isDepartmentId, isProjectType, type AgentConfig, type Board, type HqConfig, type SandboxSettings, type Task } from "../src/data/types";
import { LEAD_NAME, WORKER_NAMES } from "../src/data/names";
import { readDoc, writeDoc } from "./lib/docs";
import { repoDirOf, slugify } from "./paths";
import type { RepoInfo } from "./repo";

export interface PlanFile {
  boards: Board[];
  tasks: Task[];
}

const dir = (root: string) => repoDirOf(root);


export const defaultSandbox = (): SandboxSettings => ({
  resources: { cpus: null, memoryGb: null }, // sbx's own defaults
  allow: [],
  deny: [],
});

export function newAgent(id: string, name: string, role: string, color: string, isLead: boolean): AgentConfig {
  return {
    id,
    name,
    role,
    department: inferDepartmentForRole(role, isLead),
    isLead,
    cli: "claude",
    model: "", // the CLI's default; users can pick with /model or "Start with model"
    mode: "sandbox",
    color,
    skills: defaultSkillsForRole(role, isLead),
    roleMd: defaultRoleMdFor(name, role, isLead),
    sandbox: defaultSandbox(),
    workspacePath: null,
    mcp: [],
  };
}

function defaultConfig(repo: RepoInfo, port: number): HqConfig {
  return {
    project: { id: slugify(repo.name), name: repo.name, repo: repo.github ?? repo.name, path: repo.root, hqPort: port, type: "software" },
    team: [newAgent(slugify(LEAD_NAME), LEAD_NAME, "CTO", "#ff1744", true), newAgent(slugify(WORKER_NAMES[0]), WORKER_NAMES[0], "Senior Dev", "#00ff66", false)],
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
      if (!isAgentCli(a.cli)) a.cli = "claude";
      a.department = isDepartmentId(a.department) ? a.department : inferDepartmentForRole(a.role, a.isLead);
      a.skills ??= defaultSkillsForRole(a.role, a.isLead);
      if (!a.roleMd?.trim()) a.roleMd = defaultRoleMdFor(a.name, a.role, a.isLead);
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
    if (!isProjectType(found.project.type)) found.project.type = "software";
    return { config: found, isNew: false };
  }
  return { config: defaultConfig(repo, port), isNew: true };
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
  writeDoc(join(dir(root), "config.json"), { ...cfg, project: { ...project, path: "" } });
}

export function loadPlan(root: string): PlanFile {
  return readDoc<PlanFile>(join(dir(root), "plan.json")) ?? { boards: [{ id: "B1", title: "Backlog", status: "active", order: 0 }], tasks: [] };
}

export function savePlan(root: string, plan: PlanFile) {
  writeDoc(join(dir(root), "plan.json"), plan);
}
