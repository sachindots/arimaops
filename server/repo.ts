// Facts about the repo (or project folder) .hq was started in.

import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { run } from "./lib/exec";

export interface RepoInfo {
  root: string;
  name: string;
  originUrl: string | null;
  github: string | null; // "owner/name" when origin is GitHub
  hasCodeRabbit: boolean;
  hasInsta: boolean;
}

export async function detectRepo(start: string): Promise<RepoInfo> {
  let top = await run("git", ["rev-parse", "--show-toplevel"], { cwd: start });
  if (!top.ok) {
    // Allow .hq to run in any folder (e.g., OSINT, research, content, or new project): initialize a local git repo automatically.
    const init = await run("git", ["init", "-q"], { cwd: start });
    if (!init.ok) throw new Error(`${start} is not a git repository and could not be initialized. Pass --repo <path>.`);
    top = await run("git", ["rev-parse", "--show-toplevel"], { cwd: start });
  }
  const root = top.ok ? top.stdout.trim() : resolve(start);
  const origin = await run("git", ["remote", "get-url", "origin"], { cwd: root });
  const originUrl = origin.ok ? origin.stdout.trim() : null;
  const m = originUrl?.match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/);
  return {
    root,
    name: basename(root),
    originUrl,
    github: m ? m[1] : null,
    hasCodeRabbit: existsSync(join(root, ".coderabbit.yaml")) || existsSync(join(root, ".coderabbit.yml")),
    hasInsta: existsSync(join(root, ".insta")),
  };
}
