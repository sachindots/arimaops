// Small shared HUD pieces.

import { useEffect, useState, type ReactNode } from "react";
import type { AgentState, ReviewState, SessionState, Tokens } from "../data/types";
import { reviewStyle, sessionLabel, stateStyle } from "../theme/tokens";

/** The agent's role, in its colour. */
export function RoleBadge({ role, color, compact = false }: { role: string; color: string; compact?: boolean }) {
  return (
    <span
      className={`inline-flex items-center truncate border font-mono font-bold uppercase tracking-wider ${
        compact ? "max-w-full px-1 py-0 text-[9px] leading-[14px]" : "max-w-[14ch] px-1.5 py-0.5 text-[10px] leading-tight"
      }`}
      style={{ color, borderColor: `${color}66`, backgroundColor: `${color}18` }}
      title={role}
    >
      {role}
    </span>
  );
}

/** The agent's state; when its session isn't running, that instead (a stopped agent isn't "Idle"). */
export function StateChip({ state, session, blink = true }: { state: AgentState; session?: SessionState; blink?: boolean }) {
  if (session && session !== "running")
    return (
      <span className="chip chip-dot" style={{ ["--c" as string]: session === "failed" ? "#f85149" : "#6b7280" }}>
        {sessionLabel[session]}
      </span>
    );
  const st = stateStyle[state];
  return (
    <span className={`chip chip-dot ${blink && state === "needs-input" ? "blink" : ""}`} style={{ ["--c" as string]: st.color }}>
      {st.label}
    </span>
  );
}

export function ReviewChip({ review, merged }: { review: ReviewState; merged?: boolean }) {
  const st = merged ? { label: "Merged", color: "#2ea043" } : reviewStyle[review];
  return (
    <span className="chip chip-dot" style={{ ["--c" as string]: st.color, color: merged ? "#fff" : undefined }}>
      {st.label}
    </span>
  );
}

/** ArimaOps' mark: an indigo tile with the A. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className="shrink-0" aria-hidden>
      <rect width="32" height="32" rx="8" fill="#6366f1" />
      <path d="M16 7 L24.5 25 H20.6 L18.9 21 H13.1 L11.4 25 H7.5 Z M14.4 18 H17.6 L16 14.2 Z" fill="#fff" />
    </svg>
  );
}

/** An agent's avatar: its colour, its initial, and a ring for the lead. */
export function Portrait({ color, lead, size = 40, name }: { color: string; lead: boolean; size?: number; name?: string }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        background: `color-mix(in srgb, ${color} 22%, #16181d)`,
        color: `color-mix(in srgb, ${color} 70%, white)`,
        boxShadow: lead ? `0 0 0 2px #0f1115, 0 0 0 3px ${color}` : `inset 0 0 0 1px color-mix(in srgb, ${color} 45%, transparent)`,
      }}
      title={lead ? "Lead" : undefined}
      aria-hidden
    >
      {name ? name.trim().charAt(0).toUpperCase() : ""}
    </span>
  );
}

export function Dot({ color, size = 10 }: { color: string; size?: number }) {
  return <i className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: color }} />;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.12em] text-muted">{children}</h3>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[14px] font-semibold">{label}</span>
      {children}
      {hint && <span className="text-[12px] text-muted">{hint}</span>}
    </label>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (id: T) => void }) {
  return (
    <div role="tablist" className="flex flex-wrap gap-2">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} aria-pressed={value === t.id} className="btn text-[14px]" onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Re-renders every `ms` so relative times stay fresh. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

const short = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** Tokens read from the CLI's own logs: total, with the split in the tooltip. */
export function TokensChip({ usage }: { usage: Tokens }) {
  const total = usage.input + usage.cached + usage.output;
  return (
    <span className="chip text-[10px]" title={`${short(usage.input)} fresh input · ${short(usage.cached)} from cache · ${short(usage.output)} output`}>
      {short(total)} tok
    </span>
  );
}
