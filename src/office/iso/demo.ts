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

const EXTRA: Pick<AgentConfig, "id" | "name" | "role" | "color">[] = [
  { id: "demo-echo", name: "Echo", role: "Developer", color: "#c9b6ff" },
  { id: "demo-sol", name: "Sol", role: "QA", color: "#ff9f1c" },
  { id: "demo-ivy", name: "Ivy", role: "Designer", color: "#ff2a85" },
  { id: "demo-kit", name: "Kit", role: "Developer", color: "#00e5ff" },
  { id: "demo-rex", name: "Rex", role: "Reviewer", color: "#00ff66" },
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

/** `?officeDemo=1&officeWings=N`: N-1 made-up projects around yours, to test a big building. Scene-only. */
export const demoWingCount = () => {
  try {
    return Math.min(60, Math.max(0, Number(new URLSearchParams(location.search).get("officeWings")) || 0));
  } catch {
    return 0;
  }
};

const NAMES = ["Atlas", "Beacon", "Cinder", "Delta", "Ember", "Fjord", "Garnet", "Harbor", "Indigo", "Juniper", "Kestrel", "Lumen", "Mosaic", "Nimbus", "Onyx", "Pylon", "Quartz", "Raven", "Sable", "Tundra"];
const ROLES = ["Developer", "Reviewer", "Docs Writer", "Frontend", "Red Teamer"];
const COLORS = ["#c9b6ff", "#ff9f1c", "#ff2a85", "#00e5ff", "#00ff66", "#ffd166"];

let fakes: { key: string; list: { id: string; name: string; snap: OfficeSnapshot }[] } | null = null;

export function demoOthers(base: OfficeSnapshot, n: number): { id: string; name: string; snap: OfficeSnapshot }[] {
  const key = `${n}|${base.config.project.id}`;
  if (fakes?.key === key) return fakes.list;
  const template = base.config.team.find((a) => !a.isLead) ?? base.config.team[0];
  const now = new Date().toISOString();
  const list = Array.from({ length: Math.max(0, n - 1) }, (_, p) => {
    const security = p % 5 === 3;
    const size = 2 + (p % 4);
    const team: AgentConfig[] = Array.from({ length: size }, (_, i) => ({
      ...template,
      id: `a${i}`,
      name: `${NAMES[p % NAMES.length].slice(0, 3)}${i}`,
      role: i === 0 ? (security ? "Red Team Commander" : "Tech Lead") : security ? "Red Teamer" : ROLES[(p + i) % 4],
      isLead: i === 0,
      color: COLORS[(p + i) % COLORS.length],
    }));
    const agents: AgentStatus[] = team.map((a, i) => {
      const [state, session] = STATES[(p + i) % STATES.length];
      return { agentId: a.id, state, currentTaskId: null, stateSince: now, note: null, session: { state: (p + i) % 3 === 0 ? "stopped" : session, detail: null, workspace: null, sandbox: null } };
    });
    const id = `demo-${NAMES[p % NAMES.length].toLowerCase()}${p >= NAMES.length ? p : ""}`;
    const name = `${NAMES[p % NAMES.length]}${p >= NAMES.length ? ` ${p}` : ""}`;
    const snap: OfficeSnapshot = {
      ...base,
      config: { ...base.config, team, project: { ...base.config.project, id, name, officeName: name }, rules: { ...base.config.rules, findings: security } },
      agents, messages: [], activity: [], pullRequests: [], findings: [], tasks: [],
    };
    return { id, name, snap };
  });
  fakes = { key, list };
  return list;
}
