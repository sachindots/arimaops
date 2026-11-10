import type { AgentState, ReviewState, SessionState } from "../data/types";

// Black-Red + Hacker Terminal Cyberspace palette. Shared by the office and the HUD.
// Strictly zero yellow or orange: Crimson Red (#ff1744), Phosphor Green (#00ff66), Ice Cyan (#00e5ff), Neon Violet (#c04dff).
export const colors = {
  ink: "#040508",
  cream: "#0a0c12",
  cream2: "#10141f",
  cream3: "#261520",
  muted: "#6e7b94",
  navy: "#07090e",
  navy2: "#04060a",
  blue: "#00e5ff",
  red: "#ff1744",
  orange: "#c04dff",
  green: "#00ff66",
  lav: "#6e7b94",
  yellow: "#00ff66",
  pink: "#ff2a85",
  grass: "#050609",
  white: "#e6edf7",
  // ArimaOps brand accents (HUD only; the office keeps its own palette).
  gold: "#E8B339",
  amber: "#F59E0B",
  goldDark: "#B9791C",
  cyan: "#22D3EE",
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

/** Robot body colours offered for new agents, in order (zero yellow/orange). */
export const agentPalette = [
  "#ff1744", // crimson red (lead)
  "#00ff66", // matrix phosphor green
  "#00e5ff", // cyber ice cyan
  "#c04dff", // neon violet
  "#ff2a85", // cyber magenta
  "#3ee0d0", // plasma teal
  "#5271ff", // electric cobalt
  "#00b8d4", // deep cyan
  "#ff5c8a", // neon rose
  "#9d4edd", // dark amethyst
  "#72efdd", // mint cyber
  "#c2c9d6", // titanium silver
] as const;

export const font = {
  ui: '"Pixelify Sans", "Trebuchet MS", system-ui, sans-serif',
  term: '"VT323", ui-monospace, Menlo, Consolas, monospace',
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
