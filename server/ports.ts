// Each local agent gets its own block of ports, unique across every project on
// this machine and kept across restarts, so two agents never both run a dev
// server on :3000. Container agents have their own network and don't need one.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BRAND } from "../src/data/brand";

export const PORT_BASE = 4100;
export const BLOCK = 10;
const LAST_PORT = 9999;

export interface PortBlock {
  first: number;
  last: number;
}

/** Block for `key` in `taken` (key → first port), allocating the lowest free one. Pure: returns the updated map. */
export function allocate(taken: Record<string, number>, key: string): { block: PortBlock; taken: Record<string, number> } {
  const have = taken[key];
  if (have) return { block: { first: have, last: have + BLOCK - 1 }, taken };
  const used = new Set(Object.values(taken));
  for (let first = PORT_BASE; first + BLOCK - 1 <= LAST_PORT; first += BLOCK) {
    if (used.has(first)) continue;
    return { block: { first, last: first + BLOCK - 1 }, taken: { ...taken, [key]: first } };
  }
  throw new Error(`No free port block left (${PORT_BASE}-${LAST_PORT}). Remove agents you no longer use.`);
}

const file = () => join(homedir(), BRAND.homeDir, "ports.json");

function read(): Record<string, number> {
  try {
    return existsSync(file()) ? (JSON.parse(readFileSync(file(), "utf8")) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** This agent's block, saved in ~/.hq/ports.json. */
export function portBlockFor(project: string, agentId: string): PortBlock {
  const { block, taken } = allocate(read(), `${project}/${agentId}`);
  mkdirSync(join(homedir(), BRAND.homeDir), { recursive: true });
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, JSON.stringify(taken, null, 2) + "\n");
  renameSync(tmp, file());
  return block;
}

/** Variables the agent's shell gets: PORT for tools that read it, and the whole range. */
export const portEnv = (b: PortBlock): Record<string, string> => ({ PORT: String(b.first), ARIMA_PORT_FIRST: String(b.first), ARIMA_PORT_LAST: String(b.last) });

/** Frees a removed agent's block. */
export function releasePortBlock(project: string, agentId: string) {
  const taken = read();
  const key = `${project}/${agentId}`;
  if (!(key in taken)) return;
  delete taken[key];
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, JSON.stringify(taken, null, 2) + "\n");
  renameSync(tmp, file());
}
