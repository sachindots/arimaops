// What the command center shows first. Pure (no React), so scripts/command-test.ts can check it.

import type { AgentConfig, AgentStatus, OfficeSnapshot, Task } from "../../data/types";
import { modeOf, type Mode } from "../../data/mode";

export interface Row {
  key: string; // "<project>/<agent>": agent ids repeat across projects
  project: string;
  projectName: string;
  current: boolean;
  agent: AgentConfig;
  status: AgentStatus | undefined;
  task: Task | undefined;
  mode: Mode;
}

export type Filter = "all" | "attention" | "working" | "idle" | "stopped";

/** Lower first: what needs you, then what's stuck, then work in progress, then the rest. */
const ORDER: Record<Mode, number> = { "needs-input": 0, alert: 1, working: 2, cheer: 2, starting: 3, idle: 4, stopped: 5 };

export const FILTERS: Record<Filter, (m: Mode) => boolean> = {
  all: () => true,
  attention: (m) => m === "needs-input" || m === "alert",
  working: (m) => m === "working" || m === "cheer" || m === "starting",
  idle: (m) => m === "idle",
  stopped: (m) => m === "stopped",
};

export function rowsOf(project: string, projectName: string, current: boolean, snap: OfficeSnapshot, now = Date.now()): Row[] {
  return snap.config.team.map((agent) => {
    const status = snap.agents.find((s) => s.agentId === agent.id);
    const task = status?.currentTaskId ? snap.tasks.find((t) => t.id === status.currentTaskId) : snap.tasks.find((t) => t.ownerId === agent.id && t.status === "in-progress");
    return { key: `${project}/${agent.id}`, project, projectName, current, agent, status, task, mode: modeOf(status, now) };
  });
}

/** Pinned first, then by attention, then the longest-waiting first, then by name. */
export function sortRows(rows: Row[], pinned: Set<string>): Row[] {
  const since = (r: Row) => (r.status ? Date.parse(r.status.stateSince) : Infinity);
  return [...rows].sort(
    (a, b) =>
      Number(pinned.has(b.key)) - Number(pinned.has(a.key)) ||
      ORDER[a.mode] - ORDER[b.mode] ||
      since(a) - since(b) ||
      a.agent.name.localeCompare(b.agent.name),
  );
}

export function matches(r: Row, q: string): boolean {
  if (!q) return true;
  const s = q.toLowerCase();
  return [r.agent.name, r.agent.role, r.projectName, r.agent.cli, r.agent.model ?? "", r.task?.id ?? "", r.task?.title ?? "", r.status?.note ?? ""].some((v) => v.toLowerCase().includes(s));
}

export const tokensOf = (r: Row) => (r.status?.usage ? r.status.usage.input + r.status.usage.cached + r.status.usage.output : 0);
