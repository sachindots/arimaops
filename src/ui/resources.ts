// Sandbox sizing maths shared by settings and the agent drawer.

import { SANDBOX_DEFAULT, type AgentConfig, type MachineInfo, type SandboxResources, type SessionInfo } from "../data/types";

/** HQ's default size for a new sandbox (the server applies the same). */
export function defaultSize(m: MachineInfo) {
  return { cpus: Math.min(SANDBOX_DEFAULT.cpus, m.cpus || SANDBOX_DEFAULT.cpus), memoryGb: SANDBOX_DEFAULT.memoryGb };
}

export function effective(r: SandboxResources, m: MachineInfo) {
  const d = defaultSize(m);
  return { cpus: r.cpus ?? d.cpus, memoryGb: r.memoryGb ?? d.memoryGb };
}

/** sbx's ceiling: 75% of RAM, in 0.5 GB steps. */
export const maxMemory = (m: MachineInfo) => Math.max(0.5, Math.floor(m.memoryGb * 0.75 * 2) / 2);

export function teamBudget(team: AgentConfig[], m: MachineInfo) {
  const sandboxed = team.filter((a) => a.mode === "sandbox");
  const sum = sandboxed.reduce(
    (acc, a) => {
      const e = effective(a.sandbox.resources, m);
      return { cpus: acc.cpus + e.cpus, memoryGb: acc.memoryGb + e.memoryGb };
    },
    { cpus: 0, memoryGb: 0 },
  );
  // HQ keeps 3 GB for the system and queues starts that wouldn't fit (server/accounts.ts fitsInRam).
  return { ...sum, count: sandboxed.length, overMemory: sum.memoryGb > m.memoryGb - 3 };
}

/** True when the existing sandbox was created with a different size than the setting asks for. */
export function sizeMismatch(r: SandboxResources, session: SessionInfo, m: MachineInfo): boolean {
  if (!session.sandbox) return false;
  const want = effective(r, m);
  return want.cpus !== session.sandbox.cpus || Math.abs(want.memoryGb - session.sandbox.memoryGb) > 0.26;
}

export const fmtGb = (gb: number) => `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
