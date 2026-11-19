// Write-only app variable (.env) helpers for project-wide and per-agent env files.
// Only key names ever leave disk; values stay in 0600 files loaded directly by the agent runtime.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectHome } from "./paths";

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const projectEnvPath = (slug: string): string => join(projectHome(slug), "project.env");

export const agentEnvPath = (slug: string, agentId: string): string => join(projectHome(slug), `${agentId}.env`);

function parseKey(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const eq = line.indexOf("=");
  if (eq <= 0) return null;
  const key = line.slice(0, eq);
  if (!ENV_KEY_RE.test(key)) return null;
  const val = line.slice(eq + 1).replace(/\r$/, "");
  return /\S/.test(val) ? key : null;
}

/** Sorted deduplicated variable names whose values are non-empty in `file`. Never returns values. */
export function listEnvKeys(file: string): string[] {
  if (!existsSync(file)) return [];
  const keys = new Set<string>();
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const key = parseKey(line);
    if (key) keys.add(key);
  }
  return [...keys].sort();
}

/** True when `file` defines `key` with a non-empty value. */
export function hasEnvKey(file: string, key: string): boolean {
  return listEnvKeys(file).includes(key);
}

function readLines(file: string, header?: string): string[] {
  if (!existsSync(file)) return header ? header.trimEnd().split("\n") : [];
  const raw = readFileSync(file, "utf8");
  return raw.trim() ? raw.replace(/\r?\n$/, "").split(/\r?\n/) : [];
}

function writeAtomicEnv(file: string, lines: string[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const content = lines.length ? `${lines.join("\n")}\n` : "";
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** Sets or updates `key` in `file` atomically with mode 0600. Rejects invalid names or multi-line/empty values. */
export function setEnvVar(file: string, key: string, value: string, header?: string): void {
  const k = key.trim();
  if (!ENV_KEY_RE.test(k)) throw new Error("Variable name must use letters, digits and underscores, starting with a letter or _.");
  const v = value.trim();
  if (!v) throw new Error("Value cannot be empty.");
  if (/[\r\n]/.test(v)) throw new Error("Value must be a single line.");
  const lines = readLines(file, header);
  let replaced = false;
  const out: string[] = [];
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq > 0 && line.slice(0, eq) === k) {
      if (!replaced) {
        out.push(`${k}=${v}`);
        replaced = true;
      }
      continue;
    }
    out.push(line);
  }
  if (!replaced) out.push(`${k}=${v}`);
  writeAtomicEnv(file, out);
}

/** Removes `key` from `file` atomically if present. */
export function removeEnvVar(file: string, key: string): void {
  const k = key.trim();
  if (!ENV_KEY_RE.test(k)) throw new Error("Variable name must use letters, digits and underscores, starting with a letter or _.");
  if (!existsSync(file)) return;
  const lines = readLines(file).filter((line) => {
    const eq = line.indexOf("=");
    return !(eq > 0 && line.slice(0, eq) === k);
  });
  writeAtomicEnv(file, lines);
}

/** Existing env files for `agentId`, project-wide first so per-agent overrides it. */
export function envFilesForAgent(slug: string, agentId: string): string[] {
  return [projectEnvPath(slug), agentEnvPath(slug, agentId)].filter((p) => existsSync(p));
}
