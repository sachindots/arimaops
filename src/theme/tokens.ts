import type { AgentState, ReviewState, SessionState } from "../data/types";

// The calm palette, shared by the UI: neutral surfaces, indigo accent, muted status colours.
export const colors = {
  ink: "#0b0c0f",
  cream: "#0a0c12",
  cream2: "#10141f",
  cream3: "#261520",
  muted: "#6b7280",
  navy: "#0b0c0f",
  navy2: "#0b0c0f",
  blue: "#818cf8",
  red: "#f85149",
  orange: "#a371f7",
  green: "#3fb950",
  lav: "#6b7280",
  yellow: "#3fb950",
  pink: "#db61a2",
  grass: "#050609",
  white: "#e6e8eb",
  // ArimaOps brand accents (HUD only; the office keeps its own palette).
  gold: "#a5b4fc",
  amber: "#d29922",
  goldDark: "#4f46e5",
  cyan: "#818cf8",
} as const;

export interface StateStyle {
  label: string;
  color: string;
  dim: string;
}

export const stateStyle: Record<AgentState, StateStyle> = {
  working: { label: "Working", color: colors.blue, dim: "#006978" },
  "needs-input": { label: "Needs input", color: colors.red, dim: "#7a0b24" },
  "in-review": { label: "In review", color: colors.orange, dim: "#5e1d85" },
  "review-passed": { label: "Review passed", color: colors.green, dim: "#007a33" },
  idle: { label: "Idle", color: colors.lav, dim: "#384152" },
};

/** Label for an agent whose session isn't running (a stopped agent isn't "Idle"). */
export const sessionLabel: Record<Exclude<SessionState, "running">, string> = { stopped: "Stopped", starting: "Starting…", failed: "Failed" };

export const reviewStyle: Record<ReviewState, StateStyle> = {
  pending: { label: "Queued", color: colors.lav, dim: "#384152" },
  reviewing: { label: "Reviewing", color: colors.orange, dim: "#5e1d85" },
  "changes-requested": { label: "Changes", color: colors.red, dim: "#7a0b24" },
  passed: { label: "Passed", color: colors.green, dim: "#007a33" },
};

/** Agent colours offered for new agents, in order: muted, distinct on the dark surface, never a status colour. */
export const agentPalette = [
  "#818cf8", // indigo (lead)
  "#4fb3c4", // teal
  "#c084fc", // violet
  "#e879a6", // rose
  "#60a5fa", // blue
  "#a3b18a", // sage
  "#f0a868", // sand
  "#94a3b8", // slate
  "#67c5a3", // jade
  "#d4a5f5", // lilac
] as const;

export const font = {
  ui: '"Inter", system-ui, sans-serif',
  term: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
};

/** Lighter / darker variants of an agent colour for sprite shading. */
export function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => {
    const out = amount >= 0 ? v + (255 - v) * amount : v * (1 + amount);
    return Math.max(0, Math.min(255, Math.round(out)));
  };
  const r = ch((n >> 16) & 255);
  const g = ch((n >> 8) & 255);
  const b = ch(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}
