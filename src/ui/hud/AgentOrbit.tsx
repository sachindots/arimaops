import { useEffect, useRef, useState, type RefObject } from "react";
import { CLI_LABEL, type AgentConfig, type AgentStatus, type Task } from "../../data/types";
import { modeOf, type Mode } from "../../data/mode";
import { isViewer, officeActions, useOffice } from "../../store/office";
import { ui } from "../../store/ui";
import { fmtTokens, fmtUsd, Portrait, useCountUp } from "../kit";
import { useAgentUsage, type AgentUsage } from "../../store/usage";
import { DECK } from "../deck/frame";
import { Icon } from "../deck/Icon";

type Member = { config: AgentConfig; status: AgentStatus };

const STATE: Record<Mode, { dot: string; label: string; badge: string }> = {
  working: {
    dot: "bg-cyan-500 animate-pulse",
    label: "Working",
    badge: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 [[data-scheme=dark]_&]:text-cyan-300",
  },
  cheer: {
    dot: "bg-emerald-500",
    label: "Done",
    badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 [[data-scheme=dark]_&]:text-emerald-300",
  },
  "needs-input": {
    dot: "bg-amber-500 animate-pulse",
    label: "Needs Attention",
    badge: "border-amber-400/60 bg-amber-500/15 font-semibold text-amber-900 [[data-scheme=dark]_&]:text-amber-300",
  },
  alert: {
    dot: "bg-red-500 animate-pulse",
    label: "Alert",
    badge: "border-red-500/35 bg-red-500/12 font-semibold text-red-700 [[data-scheme=dark]_&]:text-red-300",
  },
  starting: {
    dot: "bg-indigo-500 animate-pulse",
    label: "Starting",
    badge: "border-indigo-500/30 bg-indigo-500/10 text-indigo-700 [[data-scheme=dark]_&]:text-indigo-300",
  },
  idle: {
    dot: "bg-slate-400",
    label: "Standby",
    badge: "border-[var(--border-hairline)] bg-cream-2 text-muted",
  },
  stopped: {
    dot: "bg-slate-400/60",
    label: "Off",
    badge: "border-[var(--border-hairline)] bg-cream-2 text-muted/80",
  },
};

/**
 * Where the core and the ring sit inside a box of w × h.
 */
export function hudFrame(w: number, h: number, compact = false, strip = false) {
  if (compact) return { cx: w / 2, cy: (h - (strip ? 52 : 0)) / 2 - 8, width: w, height: h - 16 - (strip ? 52 : 0), r: Math.min(w, h) * (w < 640 ? 0.17 : 0.2) };
  const left = DECK.rail;
  const top = DECK.header;
  const width = w - left;
  const height = h - top - (strip ? DECK.footer : 0);
  return { cx: left + width / 2, cy: top + height / 2, width, height, r: Math.min(width, height) * 0.175 };
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

const HALF = { node: { x: 40, y: 42 }, pill: { x: 90, y: 26 }, card: { x: 138, y: 66 } } as const;

export function AgentOrbit({
  team,
  tasks,
  activeAgentId,
  caption,
  compact = false,
  redTeamProject = false,
  lift = false,
}: {
  team: Member[];
  tasks: Task[];
  activeAgentId: string | null;
  caption: string;
  compact?: boolean;
  redTeamProject?: boolean;
  lift?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const { w, h } = useBoxSize(box);
  const usage = useAgentUsage(1);
  const snap = useOffice((s) => s.snap);
  const stages = snap?.config.template?.flow.stages;
  const f = hudFrame(w, h, compact, (stages?.length ?? 0) > 1);
  const kind = compact && w < 640 ? "node" : team.length > 6 ? "pill" : "card";
  const half = HALF[kind];
  const rx = Math.min(f.width * 0.34, f.width / 2 - half.x - 16);
  const ry = Math.min(kind === "node" ? rx * 1.35 : f.height * 0.36, f.height / 2 - half.y - 16);
  const outerTrack = Math.round(Math.min(rx, ry) * 1.92);
  const innerTrack = Math.round(outerTrack * 0.68);
  const slots = team.map((m, i) => {
    const a = -Math.PI / 2 + ((i + (team.length % 2 ? 0 : 0.5)) * 2 * Math.PI) / team.length;
    return { m, x: f.cx + Math.cos(a) * rx, y: f.cy + Math.sin(a) * ry, a };
  });

  const projectName = snap?.config.project.name ?? "Project";
  const statusText = redTeamProject ? "Offensive Threat Simulation Core" : "Swarm Synchronized";

  return (
    <div ref={box} className={`pointer-events-none inset-0 ${compact ? "absolute" : "fixed z-[2]"}`}>
      {/* Concentric Orbit Guidance Tracks */}
      {w > 0 && !compact && (
        <>
          <div
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-[var(--border-hairline)] transition-colors"
            style={{ left: f.cx, top: f.cy, width: outerTrack, height: outerTrack }}
            aria-hidden="true"
          />
          <div
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-[var(--border-hairline)] opacity-75 transition-colors"
            style={{ left: f.cx, top: f.cy, width: innerTrack, height: innerTrack }}
            aria-hidden="true"
          />
        </>
      )}

      {/* Active Project Status Badge directly below the Particle Orb */}
      {w > 0 && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 flex items-center gap-1.5 whitespace-nowrap rounded-full border border-[var(--border-hairline)] bg-[var(--surface-card)] px-3.5 py-1 text-[12px] text-muted shadow-2xs"
          style={{ left: f.cx, top: compact ? f.cy + f.height / 2 - (lift ? 52 : 24) : f.cy + f.r * 1.06 }}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${redTeamProject ? "bg-red-500 animate-pulse" : "bg-cyan-500"}`} />
          <span className="font-semibold text-ink">{projectName}</span>
          <span className="text-muted/40">·</span>
          <span>{compact ? caption : statusText}</span>
        </div>
      )}

      {/* Streamlined Agent Pods */}
      {w > 0 && team.length > 0 && (
        <div className="absolute inset-0" aria-label="Agents">
          {slots.map(({ m, x, y }, i) => {
            const task = m.status.currentTaskId ? tasks.find((t) => t.id === m.status.currentTaskId) : undefined;
            const selected = activeAgentId === m.config.id;
            return (
              <div key={m.config.id} className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2" style={{ left: x, top: y }}>
                <div className={kind === "node" ? "" : "deck-float"} style={{ animationDelay: `${-(i * 1.2) % 5}s`, animationDuration: `${5 + (i % 3) * 0.4}s` }}>
                  {kind === "node" ? (
                    <NodeCard m={m} selected={selected} use={usage.byId.get(m.config.id)} />
                  ) : kind === "pill" ? (
                    <SmallCard m={m} selected={selected} use={usage.byId.get(m.config.id)} />
                  ) : (
                    <AgentCard m={m} task={task} stage={stages?.find((s) => s.id === task?.stageId)?.name} selected={selected} use={usage.byId.get(m.config.id)} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function cardBorder(mode: Mode, selected: boolean) {
  if (selected) return "border-[var(--accent)] ring-1 ring-[var(--accent)]";
  if (mode === "needs-input") return "deck-needs";
  if (mode === "alert") return "border-red-400/70";
  return "border-[var(--border-hairline)] hover:border-[var(--border-strong)]";
}

function AgentCard({ m, task, stage, selected, use }: { m: Member; task?: Task; stage?: string; selected: boolean; use?: AgentUsage }) {
  const { config, status } = m;
  const mode = modeOf(status);
  const st = STATE[mode];
  const running = status.session.state === "running";
  const tokens = use ? use.input + use.cached + use.output : 0;
  const shown = useCountUp(tokens);
  const line = task ? `${stage ? `${stage} · ` : ""}${task.id} · ${task.title}` : status.note ?? "Assigned to project team";

  return (
    <div
      className={`w-[276px] rounded-lg border bg-[var(--surface-card)] p-3.5 shadow-[var(--card-shadow)] transition-all hover:shadow-[var(--card-shadow-hover)] ${cardBorder(mode, selected)}`}
    >
      {/* Header row: avatar + name/role on left, status badge on right */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => ui.openAgent(config.id)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
          title={`Open ${config.name}`}
        >
          <Portrait name={config.name} color={config.color} lead={!!config.isLead} size={24} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px] font-semibold leading-tight text-ink">{config.name}</span>
            <span className="block truncate text-[12px] text-muted">
              {config.role} · {CLI_LABEL[config.cli] ?? config.cli}
            </span>
          </span>
        </button>
        <span className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[12px] ${st.badge}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} />
          <span>{st.label}</span>
        </span>
      </div>

      {/* Task / note description */}
      <p className="m-0 mb-2.5 truncate text-[12px] text-muted" title={line}>
        {line}
      </p>

      {/* Footer: Authorize/Details when Needs Attention, else tokens · actions · cost */}
      {mode === "needs-input" ? (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => ui.openActions()}
            className="flex flex-1 cursor-pointer items-center justify-center gap-1 rounded bg-amber-500 px-2.5 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-amber-600"
          >
            <Icon name="check" size={14} />
            <span>Authorize</span>
          </button>
          <button
            type="button"
            onClick={() => ui.openAgent(config.id)}
            className="cursor-pointer rounded border border-[var(--border-strong)] px-2.5 py-1.5 text-[12px] font-medium text-muted transition-colors hover:bg-cream-2 hover:text-ink"
          >
            Details
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between border-t border-[var(--border-hairline)] pt-1.5 text-[12px] text-muted">
          <span>{fmtTokens(shown)} tok</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => ui.openAgent(config.id, "messages")}
              className="cursor-pointer rounded px-1.5 py-0.5 text-[12px] text-muted transition-colors hover:bg-cream-2 hover:text-ink"
            >
              Chat
            </button>
            <button
              type="button"
              onClick={() => ui.openAgent(config.id, "terminal")}
              className="cursor-pointer rounded px-1.5 py-0.5 text-[12px] text-muted transition-colors hover:bg-cream-2 hover:text-ink"
            >
              Terminal
            </button>
            {!isViewer && (
              <button
                type="button"
                onClick={() => (running ? officeActions.stopAgent(config.id) : officeActions.startAgent(config.id))}
                className={`cursor-pointer rounded px-1.5 py-0.5 text-[12px] font-medium transition-colors ${running ? "text-red hover:bg-red/10" : "text-accent hover:bg-cream-2"}`}
              >
                {running ? "Stop" : status.session.state === "starting" ? "…" : "Start"}
              </button>
            )}
          </div>
          <span className="font-semibold text-ink">{fmtUsd(use?.costUsd ?? 0)}</span>
        </div>
      )}
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
      className={`flex w-[168px] cursor-pointer items-center gap-2 rounded-lg border bg-[var(--surface-card)] px-2.5 py-1.5 text-left shadow-[var(--card-shadow)] transition-all hover:shadow-[var(--card-shadow-hover)] ${cardBorder(mode, selected)}`}
      title={`${config.name} · ${config.role} · ${st.label}`}
    >
      <Portrait name={config.name} color={config.color} lead={!!config.isLead} size={22} />
      <span className="min-w-0 flex-1">
        <b className="block truncate text-[12px] font-semibold text-ink">{config.name}</b>
        <span className="block truncate text-[12px] text-muted">
          {st.label}
          {use && <span> · {fmtTokens(use.input + use.cached + use.output)}</span>}
        </span>
      </span>
    </button>
  );
}

function NodeCard({ m, selected, use }: { m: Member; selected: boolean; use?: AgentUsage }) {
  const { config, status } = m;
  const mode = modeOf(status);
  const st = STATE[mode];
  return (
    <button
      type="button"
      onClick={() => ui.openAgent(config.id)}
      className={`flex w-[80px] cursor-pointer flex-col items-center gap-1 rounded-lg border bg-[var(--surface-card)] p-1.5 text-center shadow-2xs ${cardBorder(mode, selected)}`}
      title={`${config.name} · ${config.role} · ${st.label}`}
    >
      <Portrait name={config.name} color={config.color} lead={false} size={32} />
      <b className="max-w-full truncate text-[12px] font-semibold leading-tight text-ink">{config.name}</b>
      <span className="text-[12px] leading-tight text-muted">{st.label}</span>
      {use && <span className="font-display text-[12px] leading-tight text-muted">{fmtTokens(use.input + use.cached + use.output)} tok</span>}
    </button>
  );
}
