// Global Multi-Project Registry for .hq (dot hq) & CTO Overwatch.
// Tracks all .hq projects in ~/.hq/projects.json (added explicitly: created, opened with --repo, or registered),
// knows which are loaded in this server, and lets both the CTO agent (via MCP) and the user (via CTO Overwatch Drawer)
// inspect and update tasks across every project from a single command center.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BRAND } from "../src/data/brand";
import { inferDepartmentForRole } from "../src/data/roles";
import type { Board, HqConfig, ProjectOverview, Task, TaskStatus } from "../src/data/types";
import type { Hub } from "./hub";
import type { Planner } from "./planner";
import { slugify } from "./paths";
import { loadConfig, loadPlan, saveConfig, savePlan } from "./store";

export interface RegistryEntry {
  id: string;
  name: string;
  path: string;
  repo: string;
  hqPort: number;
  lastUpdatedAt: string;
  /** Loaded with GitHub/sbx polling paused. */
  paused?: boolean;
}

/** A project loaded in this server. */
export interface LiveProject {
  hub: Hub;
  planner: Planner;
  paused: boolean;
}

const live = new Map<string, LiveProject>(); // by resolved repo path

export function setLiveProject(root: string, project: LiveProject) {
  live.set(resolve(root), project);
}

const registryFile = () => {
  const dir = join(homedir(), BRAND.homeDir);
  mkdirSync(dir, { recursive: true });
  return join(dir, "projects.json");
};

export function readRegistry(): RegistryEntry[] {
  const file = registryFile();
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRegistry(entries: RegistryEntry[]) {
  const file = registryFile();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n");
  renameSync(tmp, file);
}

function findConfigFile(repoRoot: string): string | null {
  const next = join(repoRoot, BRAND.repoDir, "config.json");
  if (existsSync(next)) return next;
  const legacy = join(repoRoot, BRAND.legacyRepoDir, "config.json");
  if (existsSync(legacy)) return legacy;
  return null;
}

function readRepoConfig(repoRoot: string): HqConfig | null {
  const f = findConfigFile(repoRoot);
  if (!f) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as HqConfig;
  } catch {
    return null;
  }
}

/** Registers or updates a project in `~/.hq/projects.json`. */
export function registerProjectInRegistry(repoRoot: string, config: HqConfig) {
  const cleanPath = resolve(repoRoot);
  const entries = readRegistry();
  const now = new Date().toISOString();
  const nextEntry: RegistryEntry = {
    id: slugify(config.project.id || config.project.name),
    name: config.project.name,
    path: cleanPath,
    repo: config.project.repo || config.project.name,
    hqPort: config.project.hqPort || 7420,
    lastUpdatedAt: now,
  };
  const idx = entries.findIndex((e) => resolve(e.path) === cleanPath || e.id === nextEntry.id);
  if (idx >= 0) entries[idx] = { ...nextEntry, ...(entries[idx].paused ? { paused: true } : {}) };
  else entries.push(nextEntry);
  writeRegistry(entries);
}

/** Remembers pause across restarts. */
export function setRegistryPaused(root: string, paused: boolean) {
  const entries = readRegistry();
  const e = entries.find((x) => resolve(x.path) === resolve(root));
  if (!e) return;
  if (paused) e.paused = true;
  else delete e.paused;
  writeRegistry(entries);
}

/** Manually registers an existing repo path on disk; initializes `.hq/config.json` and `.hq/plan.json` if not yet present. */
export function registerProjectPath(rawPath: string): ProjectOverview | null {
  const cleanPath = resolve(rawPath.trim());
  if (!existsSync(cleanPath) || !statSync(cleanPath).isDirectory()) {
    throw new Error(`Directory not found: ${cleanPath}`);
  }
  let cfg = readRepoConfig(cleanPath);
  if (!cfg) {
    const folderName = cleanPath.split("/").filter(Boolean).pop() || "project";
    const loaded = loadConfig(
      {
        root: cleanPath,
        name: folderName,
        originUrl: null,
        github: null,
        hasCodeRabbit: false,
        hasInsta: false,
      },
      7420,
    );
    cfg = loaded.config;
    saveConfig(cleanPath, cfg);
    savePlan(cleanPath, loadPlan(cleanPath));
  }
  registerProjectInRegistry(cleanPath, cfg);
  const all = listProjectsOverview();
  return all.find((p) => resolve(p.path) === cleanPath) ?? null;
}

function summarizeCounts(tasks: Task[]) {
  const count = (s: TaskStatus) => tasks.filter((t) => t.status === s).length;
  return {
    todo: count("todo"),
    inProgress: count("in-progress"),
    inReview: count("in-review"),
    done: count("done"),
    blocked: count("blocked"),
    total: tasks.length,
  };
}

/** Lists all known `.hq` projects with their team roster, boards, tasks, and task counts. */
export function listProjectsOverview(): ProjectOverview[] {
  const out: ProjectOverview[] = [];

  for (const entry of readRegistry()) {
    const p = resolve(entry.path);
    const loaded = live.get(p);
    if (loaded) {
      const cfg = loaded.hub.snap.config;
      const boards = loaded.hub.snap.boards;
      const tasks = loaded.hub.snap.tasks;
      out.push({
        id: cfg.project.id,
        name: cfg.project.name,
        path: p,
        repo: cfg.project.repo,
        hqPort: cfg.project.hqPort,
        online: true,
        paused: loaded.paused,
        isCurrent: false,
        type: cfg.project.type ?? "software",
        workflowMode: cfg.workflow.mode ?? "github-pr",
        officeName: cfg.project.officeName,
        lastUpdatedAt: new Date().toISOString(),
        team: cfg.team.map((a) => ({
          id: a.id,
          name: a.name,
          role: a.role,
          department: inferDepartmentForRole(a.role, a.isLead, a.department),
          isLead: a.isLead,
          cli: a.cli,
          model: a.model,
        })),
        boards,
        tasks,
        counts: summarizeCounts(tasks),
      });
      continue;
    }

    const cfg = readRepoConfig(p);
    if (!cfg) continue;
    const plan = loadPlan(p);
    out.push({
      id: slugify(cfg.project.id || cfg.project.name || entry.id),
      name: cfg.project.name || entry.name,
      path: p,
      repo: cfg.project.repo || entry.repo,
      hqPort: cfg.project.hqPort || entry.hqPort,
      online: false,
      paused: false,
      isCurrent: false,
      type: cfg.project.type ?? "software",
      workflowMode: cfg.workflow.mode ?? "github-pr",
      officeName: cfg.project.officeName,
      lastUpdatedAt: entry.lastUpdatedAt,
      team: (cfg.team ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        department: inferDepartmentForRole(a.role, a.isLead, a.department),
        isLead: a.isLead,
        cli: a.cli,
        model: a.model ?? "",
      })),
      boards: plan.boards ?? [],
      tasks: plan.tasks ?? [],
      counts: summarizeCounts(plan.tasks ?? []),
    });
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function resolveTargetProject(projectIdOrName: string): { live?: LiveProject; path: string; config: HqConfig } {
  const q = projectIdOrName.trim().toLowerCase();
  const projects = listProjectsOverview();
  const match = projects.find(
    (p) => p.id.toLowerCase() === q || p.name.toLowerCase() === q || p.path.toLowerCase() === q,
  );
  if (!match) {
    throw new Error(`Project "${projectIdOrName}" not found. Known projects: ${projects.map((p) => `${p.id} (${p.name})`).join(", ") || "none"}`);
  }
  const loaded = live.get(resolve(match.path));
  if (loaded) return { live: loaded, path: match.path, config: loaded.hub.snap.config };
  const cfg = readRepoConfig(match.path);
  if (!cfg) throw new Error(`Could not read config for project "${match.name}" at ${match.path}`);
  return { path: match.path, config: cfg };
}

/** Creates a task in any registered project (live via Planner if current, or directly in `<projectPath>/.hq/plan.json`). */
export function createCrossProjectTask(
  projectId: string,
  args: { title: string; boardId?: string; description?: string; files?: string[]; doneWhen?: string; ownerId?: string },
): Task {
  const target = resolveTargetProject(projectId);
  if (target.live) {
    const currentPlanner = target.live.planner;
    const task = currentPlanner.createTask(
      {
        title: args.title,
        boardId: args.boardId,
        description: args.description,
        files: args.files,
        doneWhen: args.doneWhen,
      },
      "cto",
    );
    if (args.ownerId) {
      try {
        return currentPlanner.assign(task.id, args.ownerId, "cto");
      } catch {
        return task;
      }
    }
    return task;
  }

  const plan = loadPlan(target.path);
  let board: Board | undefined = args.boardId
    ? plan.boards.find((b) => b.id === args.boardId)
    : plan.boards.find((b) => b.status === "active") ?? plan.boards[0];
  if (!board) {
    board = { id: "B1", title: "Backlog", status: "active", order: 0 };
    plan.boards.push(board);
  }
  const existingNums = plan.tasks
    .filter((t) => t.boardId === board.id)
    .map((t) => {
      const m = t.id.match(/-T(\d+)$/);
      return m ? Number(m[1]) : 0;
    });
  const nextNum = Math.max(0, ...existingNums) + 1;
  const id = `${board.id}-T${String(nextNum).padStart(2, "0")}`;
  const owner = args.ownerId
    ? target.config.team.find((a) => a.id === args.ownerId || a.name.toLowerCase() === args.ownerId?.toLowerCase())?.id ?? null
    : null;
  const task: Task = {
    id,
    boardId: board.id,
    title: args.title.trim(),
    ownerId: owner,
    status: "todo",
    needs: [],
    prNumber: null,
    ...(args.description ? { description: args.description } : {}),
    ...(args.files?.length ? { files: args.files } : {}),
    ...(args.doneWhen ? { doneWhen: args.doneWhen } : {}),
  };
  plan.tasks.push(task);
  savePlan(target.path, plan);
  registerProjectInRegistry(target.path, target.config);
  return task;
}

/** Updates a task's status, owner, title, description, or note in any registered project. */
export function updateCrossProjectTask(
  projectId: string,
  taskId: string,
  patch: {
    title?: string;
    description?: string;
    doneWhen?: string;
    status?: TaskStatus;
    ownerId?: string | null;
    note?: string | null;
  },
): Task {
  const target = resolveTargetProject(projectId);
  if (target.live) {
    const { planner: currentPlanner, hub: currentHub } = target.live;
    const t = currentPlanner.updateTask(taskId, {
      title: patch.title,
      description: patch.description,
      doneWhen: patch.doneWhen,
      status: patch.status,
    });
    if (patch.note !== undefined) t.note = patch.note;
    if (patch.ownerId !== undefined) {
      if (patch.ownerId) {
        try {
          return currentPlanner.assign(taskId, patch.ownerId, "cto");
        } catch {
          t.ownerId = patch.ownerId;
        }
      } else {
        t.ownerId = null;
      }
      currentHub.emit({ type: "task.updated", task: { ...t } });
      currentHub.planChanged();
    }
    return t;
  }

  const plan = loadPlan(target.path);
  const task = plan.tasks.find((t) => t.id.toLowerCase() === taskId.trim().toLowerCase());
  if (!task) throw new Error(`Task "${taskId}" not found in project "${target.config.project.name}".`);
  if (patch.title !== undefined) task.title = patch.title;
  if (patch.description !== undefined) task.description = patch.description;
  if (patch.doneWhen !== undefined) task.doneWhen = patch.doneWhen;
  if (patch.status !== undefined) task.status = patch.status;
  if (patch.note !== undefined) task.note = patch.note;
  if (patch.ownerId !== undefined) {
    if (patch.ownerId === null || patch.ownerId === "") {
      task.ownerId = null;
    } else {
      const matched = target.config.team.find(
        (a) => a.id === patch.ownerId || a.name.toLowerCase() === patch.ownerId?.toLowerCase(),
      );
      task.ownerId = matched ? matched.id : patch.ownerId;
    }
  }
  savePlan(target.path, plan);
  registerProjectInRegistry(target.path, target.config);
  return task;
}
