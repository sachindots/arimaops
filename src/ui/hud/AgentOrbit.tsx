import { useEffect, useRef, useState, type RefObject } from "react";
import { useReducedMotion } from "framer-motion";
import { CLI_LABEL, type AgentConfig, type AgentStatus, type Task } from "../../data/types";
import { modeOf, type Mode } from "../../data/mode";
import { isViewer, officeActions } from "../../store/office";
import { ui } from "../../store/ui";
import { fmtTokens, fmtUsd, Meter, Portrait, Sparkline, useCountUp } from "../kit";
import { useAgentUsage, type AgentUsage } from "../../store/usage";
import { agentMode } from "./theme";

type Member = { config: AgentConfig; status: AgentStatus };

const STATE: Record<Mode, { color: string; label: string }> = {
  working: { color: "#00f0ff", label: "Working" },
  cheer: { color: "#3fb950", label: "Done" },
  "needs-input": { color: "#ffb020", label: "Needs you" },
  alert: { color: "#ff2a4b", label: "Problem" },
  starting: { color: "#818cf8", label: "Starting" },
  idle: { color: "#8b9bb4", label: "Idle" },
  stopped: { color: "#475569", label: "Off" },
};

/**
 * Where the core and the ring sit inside a box of w × h. Desktop: the box is the window, minus the rail (92 px),
 * the top bar (64 px) and 16 px margins. Compact (phones, tablets): the box is the page between the header and the tabs.
 */
export function hudFrame(w: number, h: number, compact = false) {
  if (compact) return { cx: w / 2, cy: h / 2 - 8, width: w, height: h - 16, r: Math.min(w, h) * (w < 640 ? 0.17 : 0.2) };
  const left = 92;
  const top = 64;
  const width = w - left - 16;
  const height = h - top - 16;
  return { cx: left + width / 2, cy: top + height / 2, width, height, r: Math.min(width, height) * 0.2 };
}

function useBoxSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

const HALF = { node: { x: 40, y: 42 }, pill: { x: 80, y: 24 }, card: { x: 120, y: 82 } } as const;

/**
 * The team in orbit around the core: one card per agent on an ellipse, each tied to the core by a link that
 * shows its state (flowing while it works, pulsing amber while it waits on you, faint when idle or off).
 * Phones get avatar nodes; more than 6 agents get pills; otherwise full cards.
 */
/** `redTeamProject`: the whole project is security work, so no agent needs its own Red team badge. */
export function AgentOrbit({ team, tasks, activeAgentId, caption, compact = false, redTeamProject = false, lift = false }: { team: Member[]; tasks: Task[]; activeAgentId: string | null; caption: string; compact?: boolean; redTeamProject?: boolean; lift?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const { w, h } = useBoxSize(box);
  const reduce = useReducedMotion();
  const usage = useAgentUsage(1);
  const f = hudFrame(w, h, compact);
  const kind = compact && w < 640 ? "node" : team.length > 6 ? "pill" : "card";
  const half = HALF[kind];
  const rx = Math.min(f.width * 0.36, f.width / 2 - half.x - 8 - (compact ? 0 : 16));
  const ry = Math.min(kind === "node" ? rx * 1.4 : f.height * 0.36, f.height / 2 - half.y - 12);
  const slots = team.map((m, i) => {
    // One agent at the top; an even team turns half a step so nobody sits at the bottom, where the caption is.
    const a = -Math.PI / 2 + ((i + (team.length % 2 ? 0 : 0.5)) * 2 * Math.PI) / team.length;
    return { m, x: f.cx + Math.cos(a) * rx, y: f.cy + Math.sin(a) * ry, a };
  });

  return (
    <div ref={box} className={`pointer-events-none inset-0 ${compact ? "absolute" : "fixed z-[2]"}`}>
      {w > 0 && (
        <p className="absolute m-0 -translate-x-1/2 whitespace-nowrap text-[12px] text-muted" style={{ left: f.cx, top: f.cy + f.height / 2 - (lift ? 58 : 26) }}>
          {caption}
        </p>
      )}
      {w > 0 && team.length > 0 && (
        <>
          <svg className="absolute inset-0 h-full w-full" aria-hidden="true">
            {slots.map(({ m, x, y, a }) => {
              const mode = modeOf(m.status);
              const { color } = STATE[mode];
              // From just outside the core's halo to just short of the card, so the line meets the card's edge.
              const sx = f.cx + Math.cos(a) * f.r * 1.35;
              const sy = f.cy + Math.sin(a) * f.r * 1.35 * 0.8;
              const len = Math.hypot(x - sx, y - sy);
              const cut = Math.min(len * 0.5, Math.abs(Math.cos(a)) > 0.5 ? half.x : half.y + 8);
              const ex = x - ((x - sx) / len) * cut;
              const ey = y - ((y - sy) / len) * cut;
              const path = `M${ex.toFixed(1)},${ey.toFixed(1)} L${sx.toFixed(1)},${sy.toFixed(1)}`;
              const live = mode === "working" || mode === "cheer";
              const waiting = mode === "needs-input" || mode === "alert";
              return (
                <g key={m.config.id}>
                  <path
                    d={path}
                    stroke={color}
                    strokeWidth={live || waiting ? 1.4 : 1}
                    strokeOpacity={mode === "stopped" ? 0.2 : live || waiting ? 0.7 : 0.3}
                    strokeDasharray={mode === "stopped" ? "2 6" : live ? "4 8" : undefined}
                    className={reduce ? undefined : live ? "hud-link-flow" : waiting ? "hud-link-pulse" : undefined}
                    fill="none"
                  />
                  {live && !reduce && (
                    <circle r={2.6} fill={color}>
                      <animateMotion dur="1.8s" repeatCount="indefinite" path={path} />
                    </circle>
                  )}
                </g>
              );
            })}
          </svg>
          <div className="absolute inset-0" aria-label="Agents">
            {slots.map(({ m, x, y }) => {
              const task = m.status.currentTaskId ? tasks.find((t) => t.id === m.status.currentTaskId) : undefined;
              const selected = activeAgentId === m.config.id;
              return (
                <div key={m.config.id} className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2" style={{ left: x, top: y }}>
                  {kind === "node" ? <NodeCard m={m} selected={selected} use={usage.byId.get(m.config.id)} /> : kind === "pill" ? <SmallCard m={m} selected={selected} use={usage.byId.get(m.config.id)} /> : <AgentCard m={m} task={task} selected={selected} badge={!redTeamProject} use={usage.byId.get(m.config.id)} max={usage.max} />}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function frame(mode: Mode, selected: boolean) {
  if (selected) return "border-accent shadow-[0_0_24px_rgba(0,240,255,0.25)]";
  if (mode === "needs-input") return "border-amber/70 shadow-[0_0_22px_rgba(255,176,32,0.22)]";
  if (mode === "alert") return "border-red/70 shadow-[0_0_22px_rgba(255,42,75,0.22)]";
  return "border-white/10 hover:border-accent/50";
}

function AgentCard({ m, task, selected, badge, use, max }: { m: Member; task?: Task; selected: boolean; badge: boolean; use?: AgentUsage; max: number }) {
  const { config, status } = m;
  const mode = modeOf(status);
  const st = STATE[mode];
  const running = status.session.state === "running";
  const line = task ? `${task.id} · ${task.title}` : status.note;
  return (
    <div
      className={`hud-glass hud-corners hud-scan w-[240px] rounded-2xl px-3 py-2.5 transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 ${frame(mode, selected)}`}
      style={{ ["--corner" as string]: `${st.color}cc` }}
    >
      <button type="button" onClick={() => ui.openAgent(config.id)} className="flex w-full cursor-pointer items-center gap-2.5 text-left" title={`Open ${config.name}`}>
        <Portrait name={config.name} color={config.color} lead={!!config.isLead} size={30} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <b className="truncate text-[14px] font-semibold text-ink">{config.name}</b>
            {badge && agentMode(config) === "redteam" && <span className="shrink-0 rounded border border-red/40 px-1 text-[11px] text-red">Red team</span>}
          </span>
          <span className="block truncate text-[12px] text-muted">
            {config.role} · {CLI_LABEL[config.cli] ?? config.cli}
          </span>
        </span>
      </button>
      <div className="mt-2 flex items-center gap-1.5 text-[12px]">
        <i className={`inline-block h-2 w-2 shrink-0 rounded-full ${mode === "working" || mode === "needs-input" ? "animate-pulse" : ""}`} style={{ background: st.color, boxShadow: `0 0 8px ${st.color}` }} />
        <span className="shrink-0 font-medium" style={{ color: st.color }}>
          {st.label}
        </span>
        {line && <span className="min-w-0 truncate text-muted" title={line}>· {line}</span>}
      </div>
      <UsageRow use={use} max={max} color={st.color} />
      <div className="mt-2 flex items-center gap-1.5 border-t border-white/[0.06] pt-2">
        <button type="button" onClick={() => ui.openAgent(config.id, "messages")} className="cursor-pointer rounded-md px-2 py-0.5 text-[12px] text-muted transition-colors hover:bg-white/[0.08] hover:text-ink">
          Chat
        </button>
        <button type="button" onClick={() => ui.openAgent(config.id, "terminal")} className="cursor-pointer rounded-md px-2 py-0.5 text-[12px] text-muted transition-colors hover:bg-white/[0.08] hover:text-ink">
          Terminal
        </button>
        <span className="flex-1" />
        {!isViewer && (
          <button
            type="button"
            onClick={() => (running ? officeActions.stopAgent(config.id) : officeActions.startAgent(config.id))}
            className={`cursor-pointer rounded-md px-2 py-0.5 text-[12px] transition-colors ${running ? "text-red hover:bg-red/15" : "text-accent hover:bg-accent/15"}`}
          >
            {running ? "Stop" : status.session.state === "starting" ? "Starting…" : "Start"}
          </button>
        )}
      </div>
    </div>
  );
}

function SmallCard({ m, selected, use }: { m: Member; selected: boolean; use?: AgentUsage }) {
  const { config, status } = m;
  const mode = modeOf(status);
  const st = STATE[mode];
  return (
    <button
      type="button"
      onClick={() => ui.openAgent(config.id)}
      className={`hud-glass flex w-[160px] cursor-pointer items-center gap-2 rounded-full py-1 pl-1 pr-3 text-left transition-[border-color,box-shadow] ${frame(mode, selected)}`}
      title={`${config.name} · ${config.role} · ${st.label}${use ? ` · ${fmtTokens(use.input + use.cached + use.output)} tokens today` : ""}${status.note ? ` · ${status.note}` : ""}`}
    >
      <Portrait name={config.name} color={config.color} lead={!!config.isLead} size={28} />
      <span className="min-w-0 flex-1">
        <b className="block truncate text-[13px] font-semibold text-ink">{config.name}</b>
        <span className="block truncate text-[11px]" style={{ color: st.color }}>
          {st.label}
          {use && <span className="text-muted"> · {fmtTokens(use.input + use.cached + use.output)}</span>}
        </span>
      </span>
    </button>
  );
}

/** Phones: the avatar in a status ring, the name and the state under it. Tap to open the agent. */
function NodeCard({ m, selected, use }: { m: Member; selected: boolean; use?: AgentUsage }) {
  const { config, status } = m;
  const mode = modeOf(status);
  const st = STATE[mode];
  const waiting = mode === "needs-input" || mode === "alert";
  return (
    <button
      type="button"
      onClick={() => ui.openAgent(config.id)}
      className="flex w-[80px] cursor-pointer flex-col items-center gap-1 text-center"
      title={`${config.name} · ${config.role} · ${st.label}${status.note ? ` · ${status.note}` : ""}`}
    >
      <span
        className={`rounded-full p-[3px] ${waiting ? "animate-pulse" : ""}`}
        style={{ boxShadow: `0 0 0 2px ${selected ? "#00f0ff" : st.color}, 0 0 ${waiting || mode === "working" ? 16 : 6}px ${st.color}66`, background: "rgba(8,13,24,0.85)" }}
      >
        <Portrait name={config.name} color={config.color} lead={false} size={40} />
      </span>
      <b className="max-w-full truncate text-[13px] font-semibold leading-tight text-ink">{config.name}</b>
      <span className="text-[11px] leading-tight" style={{ color: st.color }}>
        {st.label}
      </span>
      {use && <span className="font-display text-[11px] leading-tight text-muted">{fmtTokens(use.input + use.cached + use.output)} tok</span>}
    </button>
  );
}

/** Today's tokens (counting up live), estimated cost, a sparkline of the day and a meter against the busiest agent. */
function UsageRow({ use, max, color }: { use?: AgentUsage; max: number; color: string }) {
  const tokens = use ? use.input + use.cached + use.output : 0;
  const shown = useCountUp(tokens);
  return (
    <div className="mt-2 flex flex-col gap-1.5" title={use ? `Today: ${fmtTokens(use.input)} fresh input · ${fmtTokens(use.cached)} from cache · ${fmtTokens(use.output)} output` : "No tokens used today"}>
      <div className="flex items-end gap-2">
        <span className="font-display text-[18px] font-semibold leading-none text-ink">{fmtTokens(shown)}</span>
        <span className="pb-px text-[11px] text-muted">today</span>
        <span className="flex-1" />
        <span className="pb-px font-display text-[12px] text-muted">{fmtUsd(use?.costUsd ?? 0)}</span>
        <Sparkline data={use?.series ?? []} color={color} width={56} height={18} label="Tokens over the day" />
      </div>
      <Meter value={tokens} max={max} color={color} label="Share of the busiest agent's tokens" />
    </div>
  );
}

