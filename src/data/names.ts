import { BRAND } from "./brand";

/** Default operative callsigns. Cipher leads the operations unit. */
export const LEAD_NAME = "Cipher";
export const WORKER_NAMES = ["Ghost", "Vortex", "Nyx", "Pulse", "Zero", "Hex", "Valkyrie", "Kestrel", "Specter", "Aegis", "Glitch"];

/** The first default worker name nobody on the team uses yet. */
export function nextAgentName(taken: string[]): string {
  const used = new Set(taken.map((n) => n.trim().toLowerCase()));
  return WORKER_NAMES.find((n) => !used.has(n.toLowerCase())) ?? `Agent ${taken.length + 1}`;
}

/** The sign on the office wall fits 19 small pixel letters (10 big ones). */
export const OFFICE_NAME_MAX = 19;
export const DEFAULT_OFFICE_NAME = BRAND.officeSign;

export function officeSign(name?: string): string {
  const clean = (name ?? "").trim();
  if (!clean || /^jsm\s*hq$/i.test(clean)) return DEFAULT_OFFICE_NAME;
  return clean.slice(0, OFFICE_NAME_MAX);
}
