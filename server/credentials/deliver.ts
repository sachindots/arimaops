// Getting an account's secrets to one agent process, and nowhere else:
// - never on a command line (tmux and docker command lines show in `ps`),
// - never in the agent's folder (agents can read, commit and print their folder),
// - only in ~/.hq/secrets/<project>/<agent>/ (0700), which is removed when the agent stops.
// The env file is read once at launch and deleted (by the launch shell, and by HQ after a minute in case the launch failed).

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BRAND } from "../../src/data/brand";
import type { ProviderEnv } from "../../src/data/providers";

export const CONTAINER_SECRETS_DIR = "/run/arima";
const ENV_FILE = "launch.env";
const SWEEP_MS = 60_000;

export interface Prepared {
  /** KEY=value file to load at launch (0600; deleted after reading). */
  envFile: string;
  /** Container mode: host file → path inside the container. */
  mounts: [string, string][];
}

export const secretsDir = (project: string, agentId: string, home = homedir()) => join(home, BRAND.homeDir, "secrets", project, agentId);

export function prepareSecrets(project: string, agentId: string, pe: ProviderEnv, mode: "local" | "container", home = homedir()): Prepared {
  const dir = secretsDir(project, agentId, home);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const mounts: [string, string][] = [];
  const pathOf = new Map<string, string>();
  for (const f of pe.files) {
    if (!/^[\w.-]+$/.test(f.name)) throw new Error(`Bad secret file name: ${f.name}`);
    const host = join(dir, f.name);
    writeFileSync(host, f.content, { mode: 0o600 });
    const inside = mode === "container" ? `${CONTAINER_SECRETS_DIR}/${f.name}` : host;
    if (mode === "container") mounts.push([host, inside]);
    pathOf.set(f.name, inside);
  }
  const lines = Object.entries(pe.env).map(([k, v]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`Bad variable name: ${k}`);
    const value = v.replace(/\{file:([\w.-]+)\}/g, (_, n: string) => pathOf.get(n) ?? "");
    if (/[\r\n]/.test(value)) throw new Error(`${k} can't contain a line break.`);
    return `${k}=${value}`;
  });
  const envFile = join(dir, ENV_FILE);
  writeFileSync(envFile, lines.join("\n") + "\n", { mode: 0o600 });
  setTimeout(() => rmSync(envFile, { force: true }), SWEEP_MS).unref();
  return { envFile, mounts };
}

/** Removes an agent's secret files (on stop, remove, or before a new start). */
export function removeSecrets(project: string, agentId: string, home = homedir()) {
  rmSync(secretsDir(project, agentId, home), { recursive: true, force: true });
}
