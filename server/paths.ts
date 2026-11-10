import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BRAND } from "../src/data/brand";

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "project";

/** ~/.arima: everything HQ keeps for this machine. */
export const homeRoot = () => join(homedir(), BRAND.homeDir);

/** ~/.arima/<project>/: HQ's per-project home (agent folders, tokens). Falls back to an older folder name if the project is still there. */
export function projectHome(projectSlug: string): string {
  const nextDir = join(homedir(), BRAND.homeDir, projectSlug);
  const legacyDir = BRAND.legacyHomeDirs.map((d) => join(homedir(), d, projectSlug)).find((d) => existsSync(d));
  const dir = !existsSync(nextDir) && legacyDir ? legacyDir : nextDir;
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The repo's HQ folder: .arima, or an older name already there (a committed .hq keeps working until you `git mv` it). */
export function repoDirOf(root: string): string {
  for (const d of [BRAND.repoDir, ...BRAND.legacyRepoDirs]) if (existsSync(join(root, d))) return join(root, d);
  return join(root, BRAND.repoDir);
}

export function managedWorkspace(projectSlug: string, agentId: string): string {
  return join(projectHome(projectSlug), agentId);
}

/** Session names used for tmux and for the sandbox. */
export const sessionName = (projectSlug: string, agentId: string) => `hq-${projectSlug}-${agentId}`;

/**
 * Agent token: what hooks and the Team MCP send. Stable per project so agent
 * sessions that outlive an HQ restart keep working. Stored 0600 in HQ's home.
 */
export function agentToken(projectSlug: string): string {
  const file = join(projectHome(projectSlug), "agent-token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const tok = randomBytes(24).toString("hex");
  writeFileSync(file, tok, { mode: 0o600 });
  return tok;
}

/** One agent's own token: HMAC of its id under the project secret, so an agent can't act as another. */
export const agentTokenFor = (secret: string, agentId: string) => createHmac("sha256", secret).update(`agent:${agentId}`).digest("hex");

/**
 * Browser token, required by the UI's WebSocket. New on every start — except in
 * dev, where it survives server reloads so the open tab keeps working.
 */
export function browserToken(projectSlug: string, dev: boolean): string {
  if (!dev) return randomBytes(24).toString("hex");
  const file = join(projectHome(projectSlug), "dev-browser-token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const tok = randomBytes(24).toString("hex");
  writeFileSync(file, tok, { mode: 0o600 });
  return tok;
}
