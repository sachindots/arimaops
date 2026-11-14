// Small shared HUD pieces.

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { AgentState, ReviewState, SessionState, Tokens } from "../data/types";
import { reviewStyle, sessionLabel, stateStyle } from "../theme/tokens";

/** The agent's role, in its colour. */
export function RoleBadge({ role, color, compact = false }: { role: string; color: string; compact?: boolean }) {
  return (
    <span
      className={`inline-flex items-center truncate rounded-md border font-medium ${
        compact ? "max-w-full px-1 py-0 text-[11px] leading-[14px]" : "max-w-[18ch] px-1.5 py-0.5 text-[12px] leading-tight"
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
      <span className="chip chip-dot" style={{ ["--c" as string]: session === "failed" ? "#ff2a4b" : "#6b7280" }}>
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
        fontSize: Math.max(11, Math.round(size * 0.42)),
        background: `color-mix(in srgb, ${color} 22%, #0a101d)`,
        color: `color-mix(in srgb, ${color} 70%, white)`,
        boxShadow: lead ? `0 0 0 2px #050914, 0 0 0 3px ${color}` : `inset 0 0 0 1px color-mix(in srgb, ${color} 45%, transparent)`,
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
  return <h3 className="mb-2 text-[13px] font-semibold text-muted">{children}</h3>;
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
    <div role="tablist" className="no-scrollbar inline-flex max-w-full gap-1 overflow-x-auto rounded-xl border border-white/[0.08] bg-navy/60 p-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          className={`shrink-0 cursor-pointer whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors ${
            value === t.id ? "bg-accent/15 text-accent shadow-[inset_0_-2px_0_#00f0ff]" : "text-muted hover:bg-white/[0.05] hover:text-ink"
          }`}
          onClick={() => onChange(t.id)}
        >
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
    <span className="chip text-[11px]" title={`${short(usage.input)} fresh input · ${short(usage.cached)} from cache · ${short(usage.output)} output`}>
      {short(total)} tok
    </span>
  );
}

/** Tokens as 1.2k / 34k / 3.4M. */
export function fmtTokens(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n));
}

/** Estimated cost: $0.42, $12.30, $1.2k. */
export function fmtUsd(n: number): string {
  return n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(n >= 100 ? 0 : 2)}`;
}

/** Counts up (or down) to `value` over ~0.6 s, for live numbers. Jumps straight there when motion is reduced. */
export function useCountUp(value: number): number {
  const [shown, setShown] = useState(value);
  const now = useRef(value); // what's on screen, to animate from
  useEffect(() => {
    const set = (v: number) => setShown((now.current = v));
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return set(value);
    const from = now.current;
    const start = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / 600);
      set(from + (value - from) * (1 - (1 - k) ** 3));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return shown;
}

/** A small line-and-area chart of `data` (oldest first). */
export function Sparkline({ data, color = "#00f0ff", width = 96, height = 24, label }: { data: number[]; color?: string; width?: number; height?: number; label?: string }) {
  const id = useId();
  const max = Math.max(1, ...data);
  const step = data.length > 1 ? width / (data.length - 1) : width;
  const pts = data.map((v, i) => [i * step, height - 2 - (v / max) * (height - 4)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label ?? "Activity"} className="shrink-0 overflow-visible">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.35" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {pts.length > 1 && <path d={`${line} L${width},${height} L0,${height} Z`} fill={`url(#${id})`} />}
      {pts.length > 1 && <path d={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" style={{ filter: `drop-shadow(0 0 3px ${color})` }} />}
    </svg>
  );
}

/** A thin glowing bar: `value` of `max`. */
export function Meter({ value, max, color = "#00f0ff", label }: { value: number; max: number; color?: string; label: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="hud-meter" role="meter" aria-label={label} aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={Math.round(max)} style={{ ["--c" as string]: color }}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

