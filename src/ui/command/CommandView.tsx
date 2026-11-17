import { useEffect, useMemo, useRef, useState } from "react";
import { BRAND } from "../../data/brand";
import type { Mode } from "../../data/mode";
import { CLI_LABEL } from "../../data/types";
import { followBuilding, useBuilding } from "../../store/building";
import { isViewer, officeActions, useOffice } from "../../store/office";
import { ui, useUi } from "../../store/ui";
import { useAgentUsage, type AgentUsage } from "../../store/usage";
import { readPref, writePref } from "../../lib/prefs";
import { ago, fmtTokens, fmtUsd, Portrait, Sparkline, StateChip, useCountUp, useNow } from "../kit";
import { TerminalView } from "../drawers/TerminalView";
import { FILTERS, matches, rowsOf, sortRows, tokensOf, type Filter, type Row } from "./rank";
import { useScreens } from "./screens";
import { RosterTable } from "../agents/RosterTable";
import { FactoryCard } from "./Factory";
import { agentMode } from "../hud/theme";

const MODE_COLOR: Record<Mode, string> = {
  "needs-input": "#ffb020",
  alert: "#ff2a4b",
  working: "#3b82f6",
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

/** Projects in the order their first row comes (needs-you first), each project's rows together. */
const groupedRows = (rows: Row[]) => [...new Set(rows.map((r) => r.project))].flatMap((p) => rows.filter((r) => r.project === p));

/**
 * Mission control: every agent of every running project in one roster (grouped by project, what needs you first) and
 * the focused agent's live screen beside it. Needs you and activity live on Home. 1–9 focus an agent.
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
  const multi = projects.length > 1;
  const ordered = multi ? groupedRows(shown) : shown; // the order on screen, which 1–9 follow
  const focus = ordered.find((r) => r.key === focusKey) ?? ordered[0];
  const usageOf = (r: Row): AgentUsage | undefined => (r.current ? usage.byId.get(r.agent.id) : undefined);
  const tokensToday = (r: Row) => {
    const u = usageOf(r);
    return u ? usage.total(u) : tokensOf(r);
  };
  const teamToday = useCountUp(shown.reduce((t, r) => t + tokensToday(r), 0));

  // Keys: 1–9 focus that agent, / search, o back home.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, select, [contenteditable], .xterm") || e.metaKey || e.ctrlKey || e.altKey) return;
      const st = useUi.getState();
      if (st.settings || st.setupOpen || st.drawer) return;
      if (/^[1-9]$/.test(e.key)) {
        const r = ordered[Number(e.key) - 1];
        if (r) setFocusKey(r.key);
      } else if (e.key === "/") search.current?.focus();
      else if ((e.key === "o" || e.key === "O") && !solo) ui.setView("office");
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ordered, solo]);

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
        <h1 className="m-0 font-display text-[20px] font-semibold text-ink">Command center</h1>
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
          Today <b className="font-display text-[13px] font-semibold text-ink">{fmtTokens(teamToday)}</b> tokens
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

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 max-[1099px]:flex-none min-[1100px]:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <section className="hud-glass scroll-thin flex min-h-0 flex-col overflow-y-auto rounded-2xl p-3 max-[1099px]:max-h-[50vh]" aria-label="Agents">
          {shown.length === 0 ? (
            <p className="m-0 px-2 py-6 text-center text-[13px] text-muted">{all.length ? "No agents match this filter." : "No agents yet. Add a team in Settings → Team."}</p>
          ) : (
            <RosterTable
              rows={ordered}
              selected={focus?.key}
              onPick={(r) => setFocusKey(r.key)}
              usageOf={usageOf}
              tokensOf={tokensToday}
              grouped={multi}
              narrow
              keys
            />
          )}
          {hiddenRows.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-[var(--border-hairline)] px-2 pt-2 text-[12px]">
              <span className="text-muted">Hidden:</span>
              {hiddenRows.map((r) => (
                <button key={r.key} className="btn min-h-[28px] px-2 text-[12px]" onClick={() => toggleHidden(r.key)} title="Show again">
                  {r.agent.name}
                </button>
              ))}
            </div>
          )}
        </section>
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
          <section className="hud-glass grid place-items-center rounded-2xl p-8 text-[13px] text-muted">Pick an agent on the left.</section>
        )}
      </div>
    </div>
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
      className="hud-glass flex min-h-[420px] min-w-0 flex-col overflow-hidden rounded-2xl"
      style={{ borderColor: urgent ? color : undefined }}
      aria-label={`${r.agent.name}, ${r.mode}`}
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-white/[0.07] px-4 py-3">
        <Portrait name={r.agent.name} color={r.agent.color} lead={r.agent.isLead} size={40} />
        <div className="min-w-[min(100%,200px)] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="m-0 font-display text-[20px] font-semibold text-ink">{r.agent.name}</h2>
            {r.status && <StateChip state={r.status.state} session={r.status.session.state} blink={false} />}
            {multi && <span className="chip text-[12px]">{r.projectName}</span>}
            {agentMode(r.agent) === "redteam" && <span className="rounded border border-red/40 px-1.5 text-[12px] text-red">Red team</span>}
          </div>
          <div className="truncate text-[12px] text-muted">
            {r.agent.role} · {CLI_LABEL[r.agent.cli] ?? r.agent.cli}
            {r.agent.model ? ` · ${r.agent.model}` : ""}
            {r.status ? ` · ${MODE_LABEL[r.mode].toLowerCase()} for ${ago(r.status.stateSince, now)}` : ""}
          </div>
        </div>
        <div className="flex items-end gap-4">
          <div className="text-right">
            <div className="text-[12px] text-muted">Tokens today</div>
            <div className="font-display text-[20px] font-semibold leading-none text-ink">{fmtTokens(shownTokens)}</div>
          </div>
          {use && (
            <div className="text-right">
              <div className="text-[12px] text-muted">Cost</div>
              <div className="font-display text-[15px] font-semibold leading-none text-muted">{fmtUsd(use.costUsd)}</div>
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

      <div className="relative min-h-0 flex-1 bg-cream-2/50">
        {running && r.current ? (
          <TerminalView key={r.agent.id} agentId={r.agent.id} autoFocus={false} />
        ) : running && text ? (
          <pre ref={pre} className="scroll-thin m-0 h-full overflow-auto whitespace-pre bg-[#0b1220] px-4 py-3 font-term text-[12px] leading-[1.45] text-[#f8fafc]" onDoubleClick={open} aria-label={`${r.agent.name}'s screen`}>
            {text}
          </pre>
        ) : (
          <div className="grid h-full place-items-center p-6 text-center">
            <div className="flex flex-col items-center gap-3">
              <span className="font-display text-[15px] text-muted">{running ? "No output yet" : r.mode === "starting" ? "Starting…" : `${r.agent.name} isn't running`}</span>
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
