import { useEffect, useMemo, useRef, useState } from "react";
import { BRAND } from "../../data/brand";
import type { Mode } from "../../data/mode";
import { CLI_LABEL } from "../../data/types";
import { followBuilding, useBuilding } from "../../store/building";
import { isViewer, officeActions, selectAttention, useOffice } from "../../store/office";
import { ui, useUi } from "../../store/ui";
import { useAgentUsage, type AgentUsage } from "../../store/usage";
import { readPref, writePref } from "../../lib/prefs";
import { ago, fmtTokens, fmtUsd, Meter, Portrait, Sparkline, StateChip, useCountUp, useNow } from "../kit";
import { TerminalView } from "../drawers/TerminalView";
import { FILTERS, matches, rowsOf, sortRows, tokensOf, type Filter, type Row } from "./rank";
import { useScreens } from "./screens";
import { FactoryCard } from "./Factory";
import { agentMode } from "../hud/theme";

const MODE_COLOR: Record<Mode, string> = {
  "needs-input": "#ffb020",
  alert: "#ff2a4b",
  working: "#00f0ff",
  cheer: "#3fb950",
  starting: "#818cf8",
  idle: "#8b9bb4",
  stopped: "#475569",
};
const MODE_LABEL: Record<Mode, string> = { "needs-input": "Needs you", alert: "Problem", working: "Working", cheer: "Done", starting: "Starting", idle: "Idle", stopped: "Off" };
const FILTER_LABEL: Record<Filter, string> = { all: "All", attention: "Needs you", working: "Working", idle: "Idle", stopped: "Stopped" };

/** A per-browser set remembered in preferences (pinned or hidden agents, projects turned off). */
function usePrefSet(name: string): [Set<string>, (key: string) => void] {
  const [set, setSet] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(readPref(name) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (key: string) =>
    setSet((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        writePref(name, JSON.stringify([...next]));
      } catch {
        /* private window */
      }
      return next;
    });
  return [set, toggle];
}

/**
 * Mission control: every agent of every running project in a roster (what needs you first), the focused agent's
 * live screen in the middle, and what's waiting on you plus the latest activity on the right. 1–9 focus an agent.
 */
export function CommandView() {
  const solo = useUi((s) => s.solo?.kind === "command");
  const compact = useUi((s) => s.compact);
  const snap = useOffice((s) => s.snap);
  const live = useOffice((s) => s.live);
  const others = useBuilding((s) => s.others);
  const now = useNow(5_000);
  const usage = useAgentUsage(1);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [hidden, toggleHidden] = usePrefSet("cmd.hidden");
  const [pinned, togglePin] = usePrefSet("cmd.pinned");
  const [projectsOff, toggleProject] = usePrefSet("cmd.projectsOff");
  const search = useRef<HTMLInputElement>(null);

  // Other projects' live status (read-only sockets), the same feed the projects list uses.
  useEffect(() => followBuilding(), []);

  const current = snap?.config.project.id ?? "";
  const projects = useMemo(() => {
    const list = snap ? [{ id: current, name: snap.config.project.name, current: true, snap }] : [];
    for (const o of Object.values(others)) if (o.snap) list.push({ id: o.id, name: o.name, current: false, snap: o.snap });
    return list;
  }, [snap, others, current]);
  const all = useMemo(() => sortRows(projects.flatMap((p) => rowsOf(p.id, p.name, p.current, p.snap, now)), pinned), [projects, pinned, now]);
  const screens = useScreens(
    projects.map((p) => p.id),
    live,
  );

  const inScope = all.filter((r) => !projectsOff.has(r.project) && matches(r, query));
  const shown = inScope.filter((r) => FILTERS[filter](r.mode) && !hidden.has(r.key));
  const hiddenRows = inScope.filter((r) => hidden.has(r.key));
  const focus = shown.find((r) => r.key === focusKey) ?? shown[0];
  const multi = projects.length > 1;
  const usageOf = (r: Row): AgentUsage | undefined => (r.current ? usage.byId.get(r.agent.id) : undefined);
  const tokensToday = (r: Row) => {
    const u = usageOf(r);
    return u ? usage.total(u) : tokensOf(r);
  };
  const teamToday = useCountUp(shown.reduce((t, r) => t + tokensToday(r), 0));
  const maxTokens = Math.max(1, ...shown.map(tokensToday));

  // Keys: 1–9 focus that agent, / search, o back home.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, select, [contenteditable], .xterm") || e.metaKey || e.ctrlKey || e.altKey) return;
      const st = useUi.getState();
      if (st.settings || st.setupOpen || st.drawer) return;
      if (/^[1-9]$/.test(e.key)) {
        const r = shown[Number(e.key) - 1];
        if (r) setFocusKey(r.key);
      } else if (e.key === "/") search.current?.focus();
      else if ((e.key === "o" || e.key === "O") && !solo) ui.setView("office");
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shown, solo]);

  const count = (f: Filter) => inScope.filter((r) => FILTERS[f](r.mode) && !hidden.has(r.key)).length;

  return (
    <div className="hud-void scroll-thin fixed inset-0 z-[5] flex flex-col gap-3 p-4 max-[1099px]:overflow-y-auto max-[640px]:p-2.5" aria-label="Command center">
      <div className="hud-glass flex flex-wrap items-center gap-2.5 rounded-2xl px-4 py-2.5">
        {!solo && (
          <button className="btn min-h-[34px] px-3 text-[12px]" onClick={() => ui.setView("office", false)} title="Back to Home (o)">
            ← Home
          </button>
        )}
        {solo && <b className="font-display text-[15px] text-accent">{BRAND.name}</b>}
        <h1 className="m-0 font-display text-[18px] font-semibold text-ink">Command center</h1>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Show">
          {(Object.keys(FILTER_LABEL) as Filter[]).map((f) => (
            <button key={f} className="btn min-h-[32px] px-2.5 text-[12px]" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {FILTER_LABEL[f]} · {count(f)}
            </button>
          ))}
        </div>
        <input
          id="cmd-grid-search"
          name="grid-search"
          ref={search}
          className="field h-[32px] w-[190px] text-[12px]"
          placeholder="Find agent, task… (/)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Find agent or task"
        />
        <span className="flex-1" />
        <span className="text-[12px] text-muted" title="Tokens used today by the agents shown">
          Today <b className="font-display text-[14px] font-semibold text-ink">{fmtTokens(teamToday)}</b> tokens
        </span>
        {!solo && !compact && (
          <button className="btn min-h-[32px] px-2.5 text-[12px]" onClick={() => ui.popOutCommand(current)} title="Open the command center in its own window (another monitor)">
            Pop out ↗
          </button>
        )}
      </div>

      {multi && (
        <div className="flex flex-wrap items-center gap-2" aria-label="Projects">
          {projects.map((p) => {
            const mine = all.filter((r) => r.project === p.id);
            const n = (f: Filter) => mine.filter((r) => FILTERS[f](r.mode)).length;
            return (
              <button key={p.id} className="btn flex min-h-[32px] items-center gap-2 px-3 text-[12px]" aria-pressed={!projectsOff.has(p.id)} onClick={() => toggleProject(p.id)} title={projectsOff.has(p.id) ? "Show this project's agents" : "Hide this project's agents"}>
                <b className="text-ink">{p.name}</b>
                {n("attention") > 0 && <span style={{ color: MODE_COLOR["needs-input"] }}>{n("attention")} need you</span>}
                <span style={{ color: MODE_COLOR.working }}>{n("working")} working</span>
                <span className="text-muted">{n("idle")} idle</span>
              </button>
            );
          })}
        </div>
      )}

      <FactoryCard projects={projects.filter((p) => !projectsOff.has(p.id))} live={live} defaultOpen={false} />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 max-[1099px]:flex-none min-[1100px]::grid-cols-[minmax(280px,320px)_minmax(0,1fr)_minmax(260px,300px)]">
        <Roster
          rows={shown}
          focus={focus?.key}
          onFocus={setFocusKey}
          multi={multi}
          now={now}
          usageOf={usageOf}
          tokensToday={tokensToday}
          maxTokens={maxTokens}
          hiddenRows={hiddenRows}
          onUnhide={toggleHidden}
          empty={all.length ? "No agents match this filter." : "No agents yet. Add a team in Settings → Team."}
        />
        {focus ? (
          <Focus
            key={focus.key}
            row={focus}
            screen={screens[focus.project]?.[focus.agent.id]}
            now={now}
            multi={multi}
            use={usageOf(focus)}
            pinned={pinned.has(focus.key)}
            onPin={() => togglePin(focus.key)}
            onHide={() => toggleHidden(focus.key)}
          />
        ) : (
          <section className="hud-glass grid place-items-center rounded-2xl p-8 text-[14px] text-muted">Pick an agent on the left.</section>
        )}
        <SidePanels onFocus={(id) => setFocusKey(`${current}/${id}`)} />
      </div>
    </div>
  );
}

function Roster({
  rows,
  focus,
  onFocus,
  multi,
  now,
  usageOf,
  tokensToday,
  maxTokens,
  hiddenRows,
  onUnhide,
  empty,
}: {
  rows: Row[];
  focus: string | undefined;
  onFocus: (key: string) => void;
  multi: boolean;
  now: number;
  usageOf: (r: Row) => AgentUsage | undefined;
  tokensToday: (r: Row) => number;
  maxTokens: number;
  hiddenRows: Row[];
  onUnhide: (key: string) => void;
  empty: string;
}) {
  return (
    <section className="hud-glass scroll-thin flex min-h-0 flex-col overflow-y-auto rounded-2xl p-2 max-[1099px]:max-h-[45vh]" aria-label="Agents">
      <h2 className="m-0 px-2 pb-2 pt-1 font-display text-[14px] font-semibold text-muted">
        Agents <span className="text-[12px]">{rows.length}</span>
      </h2>
      {rows.length === 0 && <p className="m-0 px-2 py-6 text-center text-[13px] text-muted">{empty}</p>}
      <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
        {rows.map((r, i) => {
          const color = MODE_COLOR[r.mode];
          const on = r.key === focus;
          const urgent = r.mode === "needs-input" || r.mode === "alert";
          const u = usageOf(r);
          const n = tokensToday(r);
          return (
            <li key={r.key}>
              <button
                className={`hud-scan flex w-full flex-col gap-1.5 rounded-xl border px-2.5 py-2 text-left transition-colors ${on ? "hud-corners border-accent/50 bg-accent/[0.08]" : urgent ? "border-amber/50 bg-amber/[0.06] hover:bg-amber/[0.1]" : "border-white/[0.06] hover:border-white/20 hover:bg-white/[0.03]"}`}
                style={{ ["--corner" as string]: color, boxShadow: urgent ? `0 0 16px ${color}22` : undefined }}
                aria-current={on ? "true" : undefined}
                onClick={() => onFocus(r.key)}
                title={i < 9 ? `Focus (${i + 1})` : "Focus"}
              >
                <span className="flex items-center gap-2">
                  <span className="relative shrink-0">
                    <Portrait name={r.agent.name} color={r.agent.color} lead={r.agent.isLead} size={28} />
                    <i className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-navy ${r.mode === "working" || urgent ? "animate-pulse" : ""}`} style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <b className="truncate text-[13px] font-semibold text-ink">{r.agent.name}</b>
                      {multi && <span className="truncate text-[11px] text-muted">· {r.projectName}</span>}
                    </span>
                    <span className="block truncate text-[12px]">
                      <span style={{ color }}>{MODE_LABEL[r.mode]}</span>
                      <span className="text-muted">{r.task ? ` · ${r.task.id} ${r.task.title}` : r.status?.note ? ` · ${r.status.note}` : ""}</span>
                    </span>
                  </span>
                  {i < 9 && <kbd className="kbd shrink-0">{i + 1}</kbd>}
                </span>
                <span className="flex items-center gap-2">
                  <span className="w-[44px] shrink-0 font-display text-[12px] text-ink">{fmtTokens(n)}</span>
                  <span className="min-w-0 flex-1">
                    <Meter value={n} max={maxTokens} color={color} label={`${r.agent.name}'s tokens today`} />
                  </span>
                  {u && <Sparkline data={u.series} color={color} width={48} height={14} label={`${r.agent.name} today`} />}
                  {r.status && <span className="w-[30px] shrink-0 text-right text-[11px] text-muted">{ago(r.status.stateSince, now)}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {hiddenRows.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-white/[0.06] px-2 pt-2 text-[12px]">
          <span className="text-muted">Hidden:</span>
          {hiddenRows.map((r) => (
            <button key={r.key} className="btn min-h-[28px] px-2 text-[12px]" onClick={() => onUnhide(r.key)} title="Show again">
              {r.agent.name}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/** The focused agent: who, what, its numbers, and its live screen (the real terminal for this project's running agents). */
function Focus({ row: r, screen, now, multi, use, pinned, onPin, onHide }: { row: Row; screen: string | undefined; now: number; multi: boolean; use?: AgentUsage; pinned: boolean; onPin: () => void; onHide: () => void }) {
  const pre = useRef<HTMLPreElement>(null);
  const running = r.status?.session.state === "running";
  const text = (screen ?? "").replace(/\s+$/, "");
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [text]);
  const color = MODE_COLOR[r.mode];
  const urgent = r.mode === "needs-input" || r.mode === "alert";
  const tokens = use ? use.input + use.cached + use.output : tokensOf(r);
  const shownTokens = useCountUp(tokens);
  const open = () => (r.current ? ui.openAgent(r.agent.id) : ui.popOutAgent(r.project, r.agent.id));

  return (
    <section
      className="hud-glass hud-corners flex min-h-[420px] min-w-0 flex-col overflow-hidden rounded-2xl"
      style={{ ["--corner" as string]: color, borderColor: urgent ? color : undefined, boxShadow: urgent ? `0 0 0 1px ${color}, 0 0 28px ${color}33` : undefined }}
      aria-label={`${r.agent.name}, ${r.mode}`}
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-white/[0.07] px-4 py-3">
        <Portrait name={r.agent.name} color={r.agent.color} lead={r.agent.isLead} size={40} />
        <div className="min-w-[min(100%,200px)] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="m-0 font-display text-[20px] font-semibold text-ink">{r.agent.name}</h2>
            {r.status && <StateChip state={r.status.state} session={r.status.session.state} blink={false} />}
            {multi && <span className="chip text-[11px]">{r.projectName}</span>}
            {agentMode(r.agent) === "redteam" && <span className="rounded border border-red/40 px-1.5 text-[11px] text-red">Red team</span>}
          </div>
          <div className="truncate text-[12px] text-muted">
            {r.agent.role} · {CLI_LABEL[r.agent.cli] ?? r.agent.cli}
            {r.agent.model ? ` · ${r.agent.model}` : ""}
            {r.status ? ` · ${MODE_LABEL[r.mode].toLowerCase()} for ${ago(r.status.stateSince, now)}` : ""}
          </div>
        </div>
        <div className="flex items-end gap-4">
          <div className="text-right">
            <div className="text-[11px] text-muted">Tokens today</div>
            <div className="font-display text-[22px] font-semibold leading-none text-ink">{fmtTokens(shownTokens)}</div>
          </div>
          {use && (
            <div className="text-right">
              <div className="text-[11px] text-muted">Cost</div>
              <div className="font-display text-[16px] font-semibold leading-none text-muted">{fmtUsd(use.costUsd)}</div>
            </div>
          )}
          {use && <Sparkline data={use.series} color={color} width={90} height={32} label={`${r.agent.name}'s tokens today`} />}
        </div>
      </header>

      {r.status?.note && urgent && (
        <p className="m-0 border-b border-white/[0.06] px-4 py-2 text-[13px]" style={{ color, background: `${color}10` }}>
          <b className="font-semibold">{r.mode === "alert" ? "Problem: " : "Waiting on you: "}</b>
          {r.status.note}
        </p>
      )}
      <p className="m-0 truncate border-b border-white/[0.05] px-4 py-1.5 text-[12px] text-muted" title={r.task?.title}>
        {r.task ? (
          <>
            <b className="mr-1.5 font-term font-medium text-accent">{r.task.id}</b>
            <span className="text-ink">{r.task.title}</span>
          </>
        ) : (
          "No task"
        )}
      </p>

      <div className="relative min-h-0 flex-1 bg-navy-2/80">
        {running && r.current ? (
          <TerminalView key={r.agent.id} agentId={r.agent.id} autoFocus={false} />
        ) : running && text ? (
          <pre ref={pre} className="scroll-thin m-0 h-full overflow-auto whitespace-pre px-4 py-3 font-term text-[12px] leading-[1.45] text-ink" onDoubleClick={open} aria-label={`${r.agent.name}'s screen`}>
            {text}
          </pre>
        ) : (
          <div className="grid h-full place-items-center p-6 text-center">
            <div className="flex flex-col items-center gap-3">
              <span className="font-display text-[16px] text-muted">{running ? "No output yet" : r.mode === "starting" ? "Starting…" : `${r.agent.name} isn't running`}</span>
              {!running && r.current && !isViewer && r.mode !== "starting" && (
                <button className="btn btn-primary px-3" onClick={() => officeActions.startAgent(r.agent.id)}>
                  Start {r.agent.name}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-1.5 border-t border-white/[0.06] px-3 py-2">
        <button className="btn min-h-[30px] px-2.5 text-[12px]" onClick={open} title={r.current ? "Open its terminal, task and messages" : "Open in its own window"}>
          Open
        </button>
        {r.current && (
          <button className="btn min-h-[30px] px-2.5 text-[12px]" onClick={() => ui.openAgent(r.agent.id, "usage")}>
            Usage
          </button>
        )}
        <button className="btn min-h-[30px] px-2 text-[12px] max-[640px]:hidden" onClick={() => ui.popOutAgent(r.project, r.agent.id)} title="Its own window: drag it to another monitor">
          Pop out ↗
        </button>
        {r.current && !isViewer && (running || r.mode === "starting") && (
          <button className="btn min-h-[30px] border-red/35 px-2.5 text-[12px] text-red hover:border-red hover:bg-red/15" onClick={() => officeActions.stopAgent(r.agent.id)}>
            Stop
          </button>
        )}
        <span className="flex-1" />
        <button className="btn min-h-[30px] px-2 text-[12px]" aria-pressed={pinned} onClick={onPin} title={pinned ? "Unpin" : "Keep at the top of the list"}>
          {pinned ? "Pinned" : "Pin"}
        </button>
        <button className="btn min-h-[30px] px-2 text-[12px]" onClick={onHide} title="Hide from the list">
          Hide
        </button>
      </footer>
    </section>
  );
}

/** Right column: what's waiting on you in this project, then the latest activity. */
function SidePanels({ onFocus }: { onFocus: (agentId: string) => void }) {
  const snap = useOffice((s) => s.snap);
  const now = useNow(15_000);
  if (!snap) return null;
  const att = selectAttention(snap);
  const name = (id: string | null) => (id ? (snap.config.team.find((a) => a.id === id)?.name ?? (id === "hq" ? "HQ" : id)) : "HQ");
  return (
    <div className="flex min-h-0 flex-col gap-3 max-[1099px]:hidden">
      <section className="hud-glass scroll-thin flex max-h-[45%] min-h-0 flex-col overflow-y-auto rounded-2xl p-3" aria-label="Needs you">
        <h2 className="m-0 mb-2 flex items-center gap-2 font-display text-[14px] font-semibold text-muted">
          Needs you
          {att.total > 0 && <span className="rounded-full bg-amber px-1.5 font-term text-[11px] font-semibold text-navy">{att.total}</span>}
          <span className="flex-1" />
          <button className="text-[12px] font-normal text-accent hover:underline" onClick={() => ui.openActions()}>
            Open inbox
          </button>
        </h2>
        {att.items.length === 0 ? (
          <p className="m-0 text-[13px] text-muted">Nothing waits on you.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {att.items.slice(0, 8).map((i) => (
              <li key={i.id}>
                <button className="flex w-full flex-col rounded-lg border border-amber/25 bg-amber/[0.05] px-2.5 py-1.5 text-left hover:bg-amber/[0.1]" onClick={() => ui.openActions()}>
                  <span className="line-clamp-2 text-[12px] text-ink">{i.title}</span>
                  <span className="text-[11px] text-muted">
                    {name(i.fromId)} · {ago(i.at, now)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="hud-glass scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto rounded-2xl p-3" aria-label="Activity">
        <h2 className="m-0 mb-2 font-display text-[14px] font-semibold text-muted">Activity</h2>
        {snap.activity.length === 0 ? (
          <p className="m-0 text-[13px] text-muted">Nothing yet.</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-2 border-l border-accent/20 p-0 pl-3">
            {snap.activity.slice(0, 30).map((e) => (
              <li key={e.id} className="relative text-[12px]">
                <i className="absolute -left-[16.5px] top-1.5 h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_6px_#00f0ff]" />
                <button className="text-left hover:underline disabled:no-underline" disabled={!e.agentId} onClick={() => e.agentId && onFocus(e.agentId)}>
                  <b className="font-medium text-ink">{name(e.agentId)}</b> <span className="text-muted">{e.text}</span>
                </button>
                <span className="block text-[11px] text-muted">{ago(e.at, now)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
