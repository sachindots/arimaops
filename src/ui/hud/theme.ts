import type { AgentConfig, OfficeSnapshot } from "../../data/types";

/** What a team is for: building software, or security work (attack, defend, or both). Labels, badges and the core's colour. */
export type TeamMode = "build" | "redteam" | "blueteam" | "purpleteam";

export const TEAM_MODE_LABEL: Record<TeamMode, string> = { build: "Build", redteam: "Red team", blueteam: "Blue team", purpleteam: "Purple team" };
export const TEAM_MODE_COLOR: Record<TeamMode, string> = { build: "#00f0ff", redteam: "#ff2a4b", blueteam: "#38bdf8", purpleteam: "#a371f7" };
export const TEAM_MODE_HINT: Record<TeamMode, string> = {
  build: "Software project: tasks, PRs and reviews",
  redteam: "Security testing: scope, findings and the report",
  blueteam: "Defence: detection, response and hardening",
  purpleteam: "Attack and defence together: findings mapped to detections",
};

/** Agents only: build or red team (a security role). */
type AgentMode = "build" | "redteam";

// Whole words only: "sec" must not match "second opinion".
const SECURITY = /\b(sec|security|secops|red|redteam|pentest(er)?|vuln\w*|exploit\w*|audit\w*|recon|scanner|appsec|threat\w*|soc|osint)\b/;

export function agentMode(agent: Pick<AgentConfig, "id" | "role" | "roleId">): AgentMode {
  return SECURITY.test(`${agent.id} ${agent.role} ${agent.roleId ?? ""}`.toLowerCase()) ? "redteam" : "build";
}

/** Blue or purple when the template says so; red team when it's another security template, it has findings, or half its team is security. */
export function projectMode(snap: OfficeSnapshot | null): TeamMode {
  if (!snap) return "build";
  const tpl = `${snap.config.template?.id ?? ""} ${snap.config.template?.name ?? ""}`.toLowerCase();
  if (/\bblue\b/.test(tpl)) return "blueteam";
  if (/\bpurple\b/.test(tpl)) return "purpleteam";
  if (SECURITY.test(tpl)) return "redteam";
  if ((snap.findings?.length ?? 0) > 0) return "redteam";
  const sec = snap.config.team.filter((a) => agentMode(a) === "redteam").length;
  return sec > 0 && sec >= snap.config.team.length / 2 ? "redteam" : "build";
}
