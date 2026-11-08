// Agent folders: an HQ-managed clone per agent, or a folder the user chose.

import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { AgentConfig } from "../src/data/types";
import { run } from "./lib/exec";
import { log } from "./lib/log";
import { managedWorkspace, projectHome } from "./paths";
import type { RepoInfo } from "./repo";

export function workspaceFor(agent: AgentConfig, projectSlug: string): string {
  return agent.workspacePath || managedWorkspace(projectSlug, agent.id);
}

const INTERNAL_PREFIXES = [".git/", ".hq/", ".claude/", ".agents/", ".agent/", ".codex/", ".gemini/", "node_modules/"];
const INTERNAL_FILES = new Set([".hq-role.md", ".hq-hook.mjs", ".jsmhq-role.md", ".jsmhq-hook.mjs", "opencode.json"]);

function isSyncableRelPath(rel: string, hintSet: Set<string>): boolean {
  const norm = rel.replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
  if (!norm || norm.startsWith("/") || norm.split("/").includes("..")) return false;
  if (INTERNAL_FILES.has(norm)) return false;
  if (INTERNAL_PREFIXES.some((p) => norm === p.slice(0, -1) || norm.startsWith(p))) return false;
  if ((norm === "CLAUDE.md" || norm === "AGENTS.md") && !hintSet.has(norm)) return false;
  return true;
}

function collectFilesRecursive(root: string, relDir: string, out: string[]) {
  const full = relDir ? join(root, relDir) : root;
  if (!existsSync(full)) return;
  let st;
  try {
    st = lstatSync(full);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) return;
  if (st.isFile()) {
    out.push(relDir.replace(/\\/g, "/"));
    return;
  }
  if (!st.isDirectory()) return;
  for (const entry of readdirSync(full)) {
    const childRel = relDir ? `${relDir}/${entry}` : entry;
    if (INTERNAL_PREFIXES.some((p) => childRel === p.slice(0, -1) || childRel.startsWith(p))) continue;
    collectFilesRecursive(root, childRel, out);
  }
}

function copyRelFile(srcRoot: string, dstRoot: string, rel: string): boolean {
  const srcFull = resolve(srcRoot, rel);
  const dstFull = resolve(dstRoot, rel);
  if (!srcFull.startsWith(resolve(srcRoot) + sep) || !dstFull.startsWith(resolve(dstRoot) + sep)) return false;
  if (!existsSync(srcFull)) return false;
  try {
    const st = lstatSync(srcFull);
    if (!st.isFile() || st.isSymbolicLink()) return false;
    mkdirSync(dirname(dstFull), { recursive: true });
    copyFileSync(srcFull, dstFull);
    return true;
  } catch {
    return false;
  }
}

/**
 * In Deliverables mode, each agent runs in an isolated clone (`~/.hq/<slug>/<agentId>`).
 * When an agent completes or submits a task for review, sync its created/modified project files
 * back to `repoRoot` and into all other active agent workspaces so downstream tasks see them immediately.
 */
export async function syncDeliverablesFromAgent(
  agent: AgentConfig,
  team: AgentConfig[],
  projectSlug: string,
  repoRoot: string,
  hintPaths: string[] = [],
): Promise<string[]> {
  const srcDir = workspaceFor(agent, projectSlug);
  if (!existsSync(srcDir) || resolve(srcDir) === resolve(repoRoot)) return [];

  const hintSet = new Set(hintPaths.map((p) => p.replace(/\\/g, "/").replace(/^\.\/+/, "").trim()).filter(Boolean));
  const candidates = new Set<string>();

  for (const h of hintSet) {
    const files: string[] = [];
    collectFilesRecursive(srcDir, h, files);
    for (const f of files) candidates.add(f);
  }

  const status = await run("git", ["status", "--porcelain", "-uall"], { cwd: srcDir });
  if (status.ok) {
    for (const rawLine of status.stdout.split("\n")) {
      if (rawLine.length < 4) continue;
      const rawPath = rawLine.slice(3).trim();
      const rel = (rawPath.includes(" -> ") ? rawPath.split(" -> ").pop()! : rawPath).replace(/^"+|"+$/g, "");
      const files: string[] = [];
      collectFilesRecursive(srcDir, rel, files);
      for (const f of files) candidates.add(f);
    }
  }

  const synced: string[] = [];
  const otherDirs = team
    .filter((a) => a.id !== agent.id)
    .map((a) => workspaceFor(a, projectSlug))
    .filter((d) => existsSync(d) && resolve(d) !== resolve(srcDir) && resolve(d) !== resolve(repoRoot));

  for (const rel of candidates) {
    if (!isSyncableRelPath(rel, hintSet)) continue;
    if (copyRelFile(srcDir, repoRoot, rel)) {
      synced.push(rel);
      for (const otherDir of otherDirs) copyRelFile(srcDir, otherDir, rel);
    }
  }
  if (synced.length) log.info(`deliverables sync (${agent.id} -> repo & team): ${synced.join(", ")}`);
  return synced;
}

/**
 * Ensures an agent's workspace has the latest project files from `repoRoot` before starting a task in Deliverables mode.
 */
export function syncRepoToWorkspace(agent: AgentConfig, projectSlug: string, repoRoot: string, hintPaths: string[] = []): string[] {
  const dstDir = workspaceFor(agent, projectSlug);
  if (!existsSync(dstDir) || resolve(dstDir) === resolve(repoRoot)) return [];
  const hintSet = new Set(hintPaths.map((p) => p.replace(/\\/g, "/").replace(/^\.\/+/, "").trim()).filter(Boolean));
  const allFiles: string[] = [];
  collectFilesRecursive(repoRoot, "", allFiles);
  const synced: string[] = [];
  for (const rel of allFiles) {
    if (!isSyncableRelPath(rel, hintSet)) continue;
    if (copyRelFile(repoRoot, dstDir, rel)) synced.push(rel);
  }
  return synced;
}

/**
 * Whether git on the host turns LF into CRLF on checkout (Windows' default). Read from HQ's own
 * folder: what's in an agent's clone is the agent's to change, so it doesn't get a say.
 */
async function hostConvertsToCrlf(projectSlug: string): Promise<boolean> {
  const r = await run("git", ["config", "--type=bool", "--get", "core.autocrlf"], { cwd: projectHome(projectSlug) });
  return r.stdout.trim() === "true";
}

/**
 * Makes sure the agent's folder exists and is a git repo.
 * A full clone (not a worktree): inside a sandbox a worktree loses git access.
 * Also supports folders with zero commits (e.g. a brand-new research/OSINT directory).
 */
export async function ensureWorkspace(agent: AgentConfig, projectSlug: string, repo: RepoInfo): Promise<string> {
  const dir = workspaceFor(agent, projectSlug);
  if (agent.workspacePath) {
    if (!existsSync(dir)) throw new Error(`Folder not found: ${dir}`);
    if (!(await run("git", ["rev-parse", "--git-dir"], { cwd: dir })).ok) {
      await run("git", ["init", "-q"], { cwd: dir });
    }
    return dir;
  }
  // The sandbox's git can't see the host's setting, so it would show every CRLF file as changed and
  // an agent would commit the CRLF. A sandboxed agent's clone gets its own: LF on checkout and on commit.
  const lf = agent.mode !== "local" && (await hostConvertsToCrlf(projectSlug));
  if (!existsSync(dir)) {
    const hasCommits = (await run("git", ["rev-parse", "--verify", "HEAD"], { cwd: repo.root })).ok;
    if (hasCommits) {
      const clone = await run("git", ["clone", "--quiet", ...(lf ? ["-c", "core.autocrlf=input"] : []), repo.root, dir], { timeoutMs: 300_000 });
      if (!clone.ok) throw new Error(`git clone failed: ${clone.stderr.trim()}`);
    } else {
      mkdirSync(dir, { recursive: true });
      await run("git", ["init", "-q"], { cwd: dir });
      if (lf) await run("git", ["config", "core.autocrlf", "input"], { cwd: dir });
    }
  } else if (lf) {
    // An older clone. Its files stay CRLF until they're next checked out, but git now reads them correctly.
    await run("git", ["config", "core.autocrlf", "input"], { cwd: dir });
  }
  // A local clone points origin at the folder; agents need the real remote to push.
  if (repo.originUrl) await run("git", ["remote", "set-url", "origin", repo.originUrl], { cwd: dir });
  return dir;
}
