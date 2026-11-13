// Agent skills for the project's stack (plan 009), user-authored custom skill folders
// (.hq/skills/<id>/ and ~/.arima/skills/<id>/), AND per-agent built-in/external skills.
//
// How skills work for Sandboxed Models:
// Docker Sandboxes (`sbx run`) bind-mounts the agent's host workspace folder (`~/.arima/<project>/<agentId>`)
// into the microVM. HQ resolves, fetches (pinned packs only: server/skillPacks.ts) and writes all skill folders on the HOST into:
// - .claude/skills/ (Claude Code, GitHub Copilot)
// - .agents/skills/ (Codex, OpenCode, Gemini CLI)
// - .agent/skills/  (Antigravity CLI / agy)
// Because the workspace is mounted into the sandbox, sandboxed models immediately see every
// skill (and its helper scripts/references) inside the VM without needing sandbox internet access.

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { repoDirOf } from "./paths";
import { agentMkdir, agentPath, agentRemove, agentWrite } from "./lib/agentFs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { BRAND } from "../src/data/brand";
import { classifyAgentSkills, renderSkillMd, type BuiltinSkill } from "../src/data/skillCatalog";
import type { SkillSpec } from "../src/data/stack";
import { excludeFromGit } from "./agentFiles";
import { run } from "./lib/exec";
import { log } from "./lib/log";
import { projectHome } from "./paths";
import { ensurePinnedSkills, pinFor } from "./skillPacks";
import { scanFolder } from "./skillScan";

const AGENT_DIRS = [".claude/skills", ".agents/skills", ".agent/skills"]; // Claude/Copilot, Codex/OpenCode/Gemini, Antigravity (agy)

const cacheDir = (slug: string) => join(projectHome(slug), "skills-cache");

let installing: Promise<void> | null = null;

/** Merges multiple SkillSpec lists by source. */
export function mergeSkillSpecs(...lists: SkillSpec[][]): SkillSpec[] {
  const bySource = new Map<string, Set<string>>();
  for (const list of lists) {
    for (const spec of list) {
      const set = bySource.get(spec.source) ?? new Set<string>();
      for (const s of spec.skills) set.add(s);
      bySource.set(spec.source, set);
    }
  }
  return [...bySource.entries()]
    .map(([source, names]) => ({ source, skills: [...names].sort() }))
    .sort((a, b) => a.source.localeCompare(b.source));
}

/** Who to tell when a role or the stack names a pack nobody pinned yet (set per project: files an Action item). */
const proposers = new Map<string, (source: string) => void>();
export const onUnpinnedPack = (slug: string, fn: (source: string) => void) => void proposers.set(slug, fn);

export interface SkillOptions {
  /** Offensive packs (BugHunter) are allowed: a red or purple project with a scope set, or lab mode. */
  offensive?: boolean;
}

/**
 * Puts the external skills these specs name into the project's cache on the host (once per change of specs), from
 * pinned packs only (docs/templates.md section 2): each skill's files are checked against its pin's hash and scanned.
 * A source nobody pinned is proposed to the owner (fetched, hashed and scanned, waiting for approval) and skipped.
 */
export function ensureSkillCache(slug: string, specs: SkillSpec[], opts: SkillOptions = {}): Promise<void> {
  const run_ = async () => {
    const dir = cacheDir(slug);
    const stamp = join(dir, "installed.json");
    const stampKey = JSON.stringify({ specs, offensive: !!opts.offensive });
    if (existsSync(stamp) && readFileSync(stamp, "utf8") === stampKey) return;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const failed: string[] = [];
    for (const spec of specs) {
      const found = pinFor(spec.source);
      if (!found) {
        proposers.get(slug)?.(spec.source);
        failed.push(`${spec.source} waits for your approval in Action items`);
        continue;
      }
      if (found.pin.use === "github-action") continue; // a workflow, not skills
      if (found.pin.use === "scoped-offensive" && !opts.offensive) {
        failed.push(`${spec.source} is offensive: only red and purple projects with a scope (or lab mode) get it`);
        continue;
      }
      try {
        const got = await ensurePinnedSkills(spec.source, spec.skills);
        for (const [name, from] of Object.entries(got))
          for (const sub of AGENT_DIRS) {
            if (!SAFE_SKILL_NAME.test(name)) continue;
            cpSync(from, join(dir, sub, name), { recursive: true, filter: (src) => !src.endsWith(".arima-ok") });
          }
      } catch (err) {
        failed.push(err instanceof Error ? err.message : String(err));
      }
    }
    writeFileSync(stamp, failed.length ? "" : stampKey); // a failure is retried at the next start
    if (failed.length) throw new Error(`Some skills didn't install. ${failed.join("; ")}`);
  };
  // One install at a time per HQ; a second caller waits for the first.
  const next = (installing ?? Promise.resolve()).then(run_);
  // What's kept for the next caller never rejects (an unhandled rejection would stop HQ).
  const settled = next.then(
    () => {},
    () => {},
  );
  installing = settled;
  void settled.then(() => {
    if (installing === settled) installing = null;
  });
  return next;
}

// Which skill folders HQ put in each agent's folder. Kept in HQ's own home, not in the
// agent's folder (an agent can edit its .git), and only ever names paths like
// .claude/skills/<name>, .agents/skills/<name>, or .agent/skills/<name>.
const SAFE = /^\.(claude|agents|agent)\/skills\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ownedFile = (slug: string, workspace: string) =>
  join(projectHome(slug), "skills-owned", `${createHash("sha1").update(resolve(workspace)).digest("hex").slice(0, 16)}.json`);

function readOwned(slug: string, workspace: string): string[] {
  try {
    const list = JSON.parse(readFileSync(ownedFile(slug, workspace), "utf8")) as unknown;
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string" && SAFE.test(p)) : [];
  } catch {
    return [];
  }
}

/**
 * Resolves user-authored custom skill folders from:
 * 1. Repo-local: `<repoRoot>/.hq/skills/<skill-id>/`
 * 2. Global home: `~/.arima/skills/<skill-id>/`
 * Repo-local overrides global if both exist.
 */
export function resolveUserSkillFolders(repoRoot: string | undefined, requestedIds: string[]): Map<string, string> {
  const found = new Map<string, string>();
  const globalSkillsRoot = join(homedir(), BRAND.homeDir, "skills");
  const repoSkillsRoot = repoRoot ? join(repoDirOf(repoRoot), "skills") : null;
  const wantAll = requestedIds.includes("*");
  const wantSet = new Set(requestedIds.map((s) => s.trim().toLowerCase()));

  const scanRoot = (root: string | null) => {
    if (!root || !existsSync(root)) return;
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !SAFE_SKILL_NAME.test(entry.name)) continue;
        const skillDir = join(root, entry.name);
        if (!existsSync(join(skillDir, "SKILL.md"))) continue;
        if (wantAll || wantSet.has(entry.name.toLowerCase())) {
          found.set(entry.name, skillDir);
        }
      }
    } catch {
      /* ignore unreadable directory */
    }
  };

  scanRoot(globalSkillsRoot);
  scanRoot(repoSkillsRoot); // repo-local wins over global
  return found;
}

/** True if HQ has put skills into this folder before (so a now-empty stack/agent still cleans them up). */
export const hasHqSkills = (slug: string, workspace: string) => readOwned(slug, workspace).length > 0;

/** Copies cached external skills, user-authored custom skill folders, AND built-in per-agent skills into an agent's folder. */
export async function syncSkillsInto(
  slug: string,
  workspace: string,
  directSkills: BuiltinSkill[] = [],
  userSkillFolders: Map<string, string> = new Map(),
): Promise<string[]> {
  const before = readOwned(slug, workspace);
  const tracked = async (rel: string) => (await run("git", ["ls-files", "--error-unmatch", rel], { cwd: workspace })).ok;
  const inside = (rel: string) => SAFE.test(rel) && resolve(workspace, rel).startsWith(resolve(workspace) + sep);
  const now: string[] = [];
  const there = (rel: string) => {
    try {
      lstatSync(agentPath(workspace, rel));
      return true;
    } catch {
      return false;
    }
  };
  for (const sub of AGENT_DIRS) {
    agentMkdir(workspace, sub); // refuses if .claude, .agents, .agent or skills is a symlink
    // 1. Copy external cached skills if present
    const from = join(cacheDir(slug), sub);
    if (existsSync(from)) {
      for (const name of readdirSync(from)) {
        const rel = `${sub}/${name}`;
        if (!inside(rel)) continue;
        if (await tracked(rel)) continue;
        if (there(rel) && !before.includes(rel)) continue;
        agentRemove(workspace, rel);
        cpSync(join(from, name), agentPath(workspace, rel), { recursive: true });
        now.push(rel);
      }
    }
    // 2. Copy user-authored custom skill folders (.hq/skills/<id>/ or ~/.arima/skills/<id>/)
    for (const [skillName, sourcePath] of userSkillFolders.entries()) {
      const rel = `${sub}/${skillName}`;
      if (!inside(rel)) continue;
      if (await tracked(rel)) continue;
      if (there(rel) && !before.includes(rel) && !now.includes(rel)) continue;
      agentRemove(workspace, rel);
      cpSync(sourcePath, agentPath(workspace, rel), { recursive: true });
      if (!now.includes(rel)) now.push(rel);
    }
    // 3. Write built-in and custom per-agent skills directly (unless overridden by a user-authored folder)
    for (const skill of directSkills) {
      if (userSkillFolders.has(skill.id)) continue;
      const rel = `${sub}/${skill.id}`;
      if (!inside(rel) || now.includes(rel)) continue;
      if (await tracked(rel)) continue;
      if (there(rel) && !before.includes(rel)) continue;
      agentRemove(workspace, rel);
      agentMkdir(workspace, rel);
      agentWrite(workspace, `${rel}/SKILL.md`, renderSkillMd(skill));
      now.push(rel);
    }
  }
  for (const rel of before) {
    if (now.includes(rel) || !inside(rel) || (await tracked(rel))) continue;
    try {
      agentRemove(workspace, rel);
    } catch {
      /* a symlinked parent: leave it */
    }
  }
  mkdirSync(join(projectHome(slug), "skills-owned"), { recursive: true });
  writeFileSync(ownedFile(slug, workspace), JSON.stringify(now));
  excludeFromGit(workspace, now);
  return now;
}

/** Install (if needed) and copy stack skills, user-authored skill folders, and built-in skills into the workspace. */
export async function prepareSkills(
  slug: string,
  workspace: string,
  stackSpecs: SkillSpec[],
  agentSkills: string[] = [],
  repoRoot?: string,
  opts: SkillOptions = {},
): Promise<{ count: number; error: string | null }> {
  const userSkillFolders = resolveUserSkillFolders(repoRoot, agentSkills);
  // Custom skill folders are scanned like packs; a blocked one isn't copied.
  const refused: string[] = [];
  for (const [name, folder] of [...userSkillFolders]) {
    const block = scanFolder(folder).find((f) => f.level === "block");
    if (block) {
      userSkillFolders.delete(name);
      refused.push(`custom skill ${name} is blocked by the scanner (${block.path}: ${block.why})`);
    }
  }
  const { builtin, external, custom } = classifyAgentSkills(agentSkills);
  // Filter out custom stubs if a real user skill folder exists in .hq/skills/ or ~/.arima/skills/
  const directSkills = [...builtin, ...custom.filter((c) => !userSkillFolders.has(c.id))];
  const allSpecs = mergeSkillSpecs(stackSpecs, external);
  let cacheError: string | null = refused.length ? refused.join("; ") : null;
  if (allSpecs.length) {
    try {
      await ensureSkillCache(slug, allSpecs, opts);
    } catch (err) {
      cacheError = [cacheError, err instanceof Error ? err.message : String(err)].filter(Boolean).join("; ");
      log.warn(`skills cache: ${cacheError}`);
    }
  }
  try {
    const copied = await syncSkillsInto(slug, workspace, directSkills, userSkillFolders);
    return { count: copied.filter((p) => p.startsWith(".claude/")).length, error: cacheError };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`skills sync: ${msg}`);
    return { count: 0, error: cacheError ?? msg };
  }
}
