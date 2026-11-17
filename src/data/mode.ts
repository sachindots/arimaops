// What an agent is doing, in one word, for tiles and lists: from its status and session.
import type { AgentStatus } from "./types";

export type Mode = "working" | "cheer" | "idle" | "needs-input" | "alert" | "stopped" | "starting";

export function modeOf(st: AgentStatus | undefined, now = Date.now()): Mode {
  if (!st) return "stopped";
  const s = st.session.state;
  if (s === "stopped") return "stopped";
  if (s === "starting") return "starting";
  if (s === "failed") return "alert";
  if (st.limitedUntil && new Date(st.limitedUntil).getTime() > now) return "alert";
  if (st.state === "needs-input") return "needs-input";
  if (st.state === "idle") return "idle";
  if (st.state === "review-passed") return "cheer";
  return "working";
}
