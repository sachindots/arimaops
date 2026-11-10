// `?officeDemo=1`: a scene-only snapshot with six agents in every state, for
// screenshots and frame timing. Never sent to the server; the real snapshot
// is left untouched.

import type { AgentConfig, AgentStatus, OfficeSnapshot, SessionState } from "../../data/types";

export const wantsDemo = () => {
  try {
    return new URLSearchParams(location.search).get("officeDemo") === "1";
  } catch {
    return false;
  }
};

const EXTRA: Pick<AgentConfig, "id" | "name" | "role" | "color" | "department">[] = [
  { id: "demo-echo", name: "Echo", role: "Developer", color: "#c9b6ff", department: "eng" },
  { id: "demo-sol", name: "Sol", role: "QA", color: "#ff9f1c", department: "qa-ops" },
  { id: "demo-ivy", name: "Ivy", role: "Designer", color: "#ff2a85", department: "eng" },
  { id: "demo-kit", name: "Kit", role: "Developer", color: "#00e5ff", department: "eng" },
  { id: "demo-rex", name: "Rex", role: "Reviewer", color: "#00ff66", department: "qa-ops" },
];
// Worker states in seat order: typing, wandering, "?", "!", walking in from the door.
const STATES: [AgentStatus["state"], SessionState][] = [["working", "running"], ["idle", "running"], ["needs-input", "running"], ["working", "failed"], ["working", "starting"]];

let last: { from: OfficeSnapshot; to: OfficeSnapshot } | null = null;

export function demoSnapshot(snap: OfficeSnapshot): OfficeSnapshot {
  if (last?.from === snap) return last.to;
  const base = snap.config.team;
  const template = base.find((a) => !a.isLead) ?? base[0];
  const team: AgentConfig[] = [...base];
  for (const x of EXTRA) {
    if (team.length >= 6) break;
    team.push({ ...template, ...x, isLead: false });
  }
  let w = 0;
  const now = new Date().toISOString();
  const agents: AgentStatus[] = team.map((a) => {
    const [state, session] = a.isLead ? (["working", "running"] as const) : STATES[w++ % STATES.length];
    return { agentId: a.id, state, currentTaskId: null, stateSince: now, note: null, session: { state: session, detail: null, workspace: null, sandbox: null } };
  });
  const to = { ...snap, config: { ...snap.config, team }, agents };
  last = { from: snap, to };
  return to;
}
