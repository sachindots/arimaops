import { useEffect, useMemo, useRef, useState } from "react";
import { BRAND } from "../../data/brand";
import { officeLabel } from "../../data/names";
import type { Mode } from "../../office/iso/behaviour";
import { followBuilding, useBuilding } from "../../store/building";
import { isViewer, officeActions, useOffice } from "../../store/office";
import { ui, useUi } from "../../store/ui";
import { readPref, writePref } from "../../lib/prefs";
import { ago, Portrait, StateChip, TokensChip, useNow } from "../kit";
import { FILTERS, matches, rowsOf, sortRows, tokensOf, type Filter, type Row } from "./rank";
import { useScreens } from "./screens";
import { FactoryCard } from "./Factory";

const MODE_COLOR: Record<Mode, string> = {
  "needs-input": "#F59E0B",
  alert: "#ff1744",
  working: "#00ff66",
  cheer: "#00ff66",
  starting: "#22D3EE",
  idle: "#8A97B0",
  stopped: "#3a4560",
};
const FILTER_LABEL: Record<Filter, string> = { all: "All", attention: "Needs you", working: "Working", idle: "Idle", stopped: "Stopped" };
const DENSITY = { S: 300, M: 420, L: 600 } as const;
type Density = keyof typeof DENSITY;

const short = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** A per-browser set remembered in preferences (hidden or pinned tiles, projects turned off). */
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
 * The command center: every agent of every running project as a tile, what needs you first.
 * Tiles show a live, read-only screen preview; Open or Pop out gives the real terminal.
 */
export function CommandView() {
  const solo = useUi((s) => s.solo?.kind === "command");
  const compact = useUi((s) => s.compact); // phone/tablet layout: a full-screen page with a Back button
  const snap = useOffice((s) => s.snap);
  const live = useOffice((s) => s.live);
  const others = useBuilding((s) => s.others);
  const now = useNow(5_000);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [density, setDensity] = useState<Density>(() => ((readPref("cmd.density") as Density) in DENSITY ? (readPref("cmd.density") as Density) : "M"));
  const [maxed, setMaxed] = useState<string | null>(null);
  const [hidden, toggleHidden] = usePrefSet("cmd.hidden");
  const [pinned, togglePin] = usePrefSet("cmd.pinned");
  const [projectsOff, toggleProject] = usePrefSet("cmd.projectsOff");
  const search = useRef<HTMLInputElement>(null);

  // Other projects' live status (read-only sockets), the same feed the office building uses.
  useEffect(() => followBuilding(), []);

  const current = snap?.config.project.id ?? "";
  const projects = useMemo(() => {
    const list = snap ? [{ id: current, name: officeLabel(snap.config.project), current: true, snap }] : [];
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
  const maxRow = maxed ? shown.find((r) => r.key === maxed) : undefined;

  // Keys: 1–9 maximize that tile, Esc back to the grid, / search, o the office.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, select, [contenteditable], .xterm") || e.metaKey || e.ctrlKey || e.altKey) return;
      const st = useUi.getState();
      if (st.settings || st.setupOpen || st.drawer) return;
      if (/^[1-9]$/.test(e.key)) {
        const r = shown[Number(e.key) - 1];
        if (r) setMaxed((m) => (m === r.key ? null : r.key));
      } else if (e.key === "Escape" && maxed) setMaxed(null);
      else if (e.key === "/") search.current?.focus();
      else if ((e.key === "o" || e.key === "O") && !solo) ui.setView("office");
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shown, maxed, solo]);

  const count = (f: Filter) => inScope.filter((r) => FILTERS[f](r.mode) && !hidden.has(r.key)).length;
  const setDens = (d: Density) => {
    setDensity(d);
    try {
      writePref("cmd.density", d);
    } catch {
      /* private window */
    }
  };

  return (
    <div className={`fixed z-[5] flex flex-col gap-2 ${solo || compact ? "inset-0 bg-grass p-2" : "bottom-4 left-4 right-4 top-[74px]"}`} aria-label="Command center">
      <div className="panel flex flex-wrap items-center gap-2 px-3 py-2">
        {compact && !solo && (
          <button className="btn min-h-[40px] px-2.5" aria-label="Back" onClick={() => ui.setView("office", false)}>
            ‹
          </button>
        )}
        {solo && <b className="font-term text-[20px] text-gold">{BRAND.name}</b>}
        <b className="text-[16px]">Command</b>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Show">
          {(Object.keys(FILTER_LABEL) as Filter[]).map((f) => (
            <button key={f} className="btn min-h-[36px] px-2 text-[12px]" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {FILTER_LABEL[f]} · {count(f)}
            </button>
          ))}
        </div>
        <input
          ref={search}
          className="field h-[36px] w-[180px] text-[13px]"
          placeholder="Find agent, task…  (/)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Find agent or task"
        />
        <span className="flex-1" />
        <div className="flex gap-1" role="group" aria-label="Tile size">
          {(Object.keys(DENSITY) as Density[]).map((d) => (
            <button key={d} className="btn min-h-[36px] w-9 px-0 text-[12px]" aria-pressed={density === d} onClick={() => setDens(d)} title={`Tile size ${d}`}>
              {d}
            </button>
          ))}
        </div>
        {!solo && !compact && (
          <>
            <button className="btn min-h-[36px] px-2 text-[12px]" onClick={() => ui.popOutCommand(current)} title="Open the command center in its own window (another monitor)">
              Pop out ↗
            </button>
            <button className="btn min-h-[36px] px-2 text-[12px]" onClick={() => ui.setView("office")} title="Back to the office (o)">
              Office
            </button>
          </>
        )}
      </div>

      <Stats projects={projects} rows={all} off={projectsOff} toggle={toggleProject} />

      {!maxRow && <FactoryCard projects={projects.filter((p) => !projectsOff.has(p.id))} live={live} />}

      {maxRow ? (
        <div className="min-h-0 flex-1">
          <Tile row={maxRow} screen={screens[maxRow.project]?.[maxRow.agent.id]} now={now} max multi={projects.length > 1} pinned={pinned.has(maxRow.key)} onPin={() => togglePin(maxRow.key)} onHide={() => (toggleHidden(maxRow.key), setMaxed(null))} onMax={() => setMaxed(null)} />
        </div>
      ) : (
        <div className="scroll-thin grid min-h-0 flex-1 content-start items-start gap-2 overflow-y-auto pr-1" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${DENSITY[density]}px), 1fr))` }}>
          {shown.map((r, i) => (
            <Tile
              key={r.key}
              row={r}
              index={i + 1}
              screen={screens[r.project]?.[r.agent.id]}
              now={now}
              multi={projects.length > 1}
              pinned={pinned.has(r.key)}
              onPin={() => togglePin(r.key)}
              onHide={() => toggleHidden(r.key)}
              onMax={() => setMaxed(r.key)}
              lines={density === "S" ? 8 : density === "M" ? 12 : 18}
            />
          ))}
          {!shown.length && (
            <p className="panel col-span-full m-0 p-6 text-center text-[14px] text-muted">
              {all.length ? "Nothing here with this filter." : "No agents yet. Add a team in Settings → Team."}
            </p>
          )}
        </div>
      )}

      {hiddenRows.length > 0 && (
        <div className="panel flex flex-wrap items-center gap-1.5 px-3 py-1.5 text-[12px]">
          <span className="text-muted">Hidden:</span>
          {hiddenRows.map((r) => (
            <button key={r.key} className="btn min-h-[32px] px-2 text-[12px]" onClick={() => toggleHidden(r.key)} title="Show again">
              <i className="mr-1 inline-block h-2 w-2" style={{ background: MODE_COLOR[r.mode] }} />
              {r.agent.name}
              {projects.length > 1 ? ` · ${r.projectName}` : ""}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Per project: who needs you, who's working, tokens used. Tap a project to show or hide its tiles. */
function Stats({ projects, rows, off, toggle }: { projects: { id: string; name: string }[]; rows: Row[]; off: Set<string>; toggle: (id: string) => void }) {
  const total = rows.reduce((t, r) => t + tokensOf(r), 0);
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[12px]" aria-label="Stats">
      {projects.map((p) => {
        const mine = rows.filter((r) => r.project === p.id);
        const n = (f: Filter) => mine.filter((r) => FILTERS[f](r.mode)).length;
        const tok = mine.reduce((t, r) => t + tokensOf(r), 0);
        return (
          <button key={p.id} className="btn flex min-h-[34px] items-center gap-2 px-2 text-[12px]" aria-pressed={!off.has(p.id)} onClick={() => toggle(p.id)} title={off.has(p.id) ? "Show this project's agents" : "Hide this project's agents"}>
            <b>{p.name}</b>
            {n("attention") > 0 && <span style={{ color: MODE_COLOR["needs-input"] }}>{n("attention")} need you</span>}
            <span style={{ color: MODE_COLOR.working }}>{n("working")} working</span>
            <span className="text-muted">{n("idle")} idle</span>
            {tok > 0 && <span className="text-muted">{short(tok)} tok</span>}
          </button>
        );
      })}
      {total > 0 && <span className="ml-auto text-muted">All projects: {short(total)} tokens</span>}
    </div>
  );
}

function Tile({
  row: r,
  screen,
  now,
  index,
  max = false,
  multi,
  pinned,
  onPin,
  onHide,
  onMax,
  lines = 12,
}: {
  row: Row;
  screen: string | undefined;
  now: number;
  index?: number;
  max?: boolean;
  multi: boolean;
  pinned: boolean;
  onPin: () => void;
  onHide: () => void;
  onMax: () => void;
  lines?: number;
}) {
  const pre = useRef<HTMLPreElement>(null);
  const running = r.status?.session.state === "running";
  const text = (screen ?? "").replace(/\s+$/, "");
  const visible = max ? text : text.split("\n").slice(-lines).join("\n");
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [visible]);
  const open = () => (r.current ? ui.openAgent(r.agent.id) : ui.popOutAgent(r.project, r.agent.id));
  const color = MODE_COLOR[r.mode];

  return (
    <section
      className={`panel flex min-w-0 flex-col ${max ? "h-full" : ""}`}
      style={{ borderColor: r.mode === "needs-input" || r.mode === "alert" ? color : undefined, boxShadow: `inset 4px 0 0 ${color}` }}
      aria-label={`${r.agent.name}, ${r.mode}`}
    >
      <header className="flex flex-wrap items-center gap-2 border-b-2 border-ink px-2.5 py-1.5">
        {index !== undefined && index <= 9 && <kbd className="font-mono text-[10px] text-muted">{index}</kbd>}
        <Portrait color={r.agent.color} lead={r.agent.isLead} size={24} />
        <b className="truncate text-[15px]">{r.agent.name}</b>
        {multi && <span className="chip text-[10px]">{r.projectName}</span>}
        {r.status && <StateChip state={r.status.state} session={r.status.session.state} blink={false} />}
        {r.status && <span className="font-mono text-[11px] text-muted">{ago(r.status.stateSince, now)}</span>}
        <span className="flex-1" />
        <span className="hidden font-mono text-[11px] text-muted min-[1500px]:inline">
          {r.agent.cli}
          {r.agent.model ? `:${r.agent.model}` : ""}
        </span>
        {r.status?.usage && <TokensChip usage={r.status.usage} />}
      </header>
      {r.status?.note && r.mode !== "working" && r.mode !== "stopped" && (
        <p className="m-0 border-b-2 border-ink px-2.5 py-1 text-[12px]" style={{ color: r.mode === "needs-input" || r.mode === "alert" ? color : undefined }}>
          {r.status.note}
        </p>
      )}
      <p className="m-0 truncate px-2.5 py-1 text-[12px] text-muted" title={r.task?.title}>
        {r.task ? (
          <>
            <b className="font-mono text-ink">{r.task.id}</b> {r.task.title}
          </>
        ) : (
          "No task"
        )}
      </p>
      {running || r.mode === "starting" || max ? (
      <pre
        ref={pre}
        className={`scroll-thin m-0 min-h-0 overflow-auto whitespace-pre bg-[#04060a] px-2.5 py-1.5 font-mono text-[11px] leading-[1.35] text-[#cfd8e6] ${max ? "flex-1 text-[13px]" : ""}`}
        style={max ? undefined : { height: `${lines * 1.35 * 11 + 12}px` }}
        onDoubleClick={open}
        aria-label={`${r.agent.name}'s screen`}
      >
        {running ? visible || " " : <span className="text-muted">{r.mode === "starting" ? "Starting…" : "Not running"}</span>}
      </pre>
      ) : null}
      <footer className="flex flex-wrap items-center gap-1 px-2 py-1.5">
        <button className="btn min-h-[34px] px-2 text-[12px]" onClick={open} title={r.current ? "Open its terminal, task and messages" : "Open in its own window"}>
          Open
        </button>
        <button className="btn min-h-[34px] w-9 px-0 text-[13px]" onClick={() => ui.popOutAgent(r.project, r.agent.id)} title="Its own window: drag it to another monitor" aria-label={`Pop out ${r.agent.name}`}>
          ↗
        </button>
        {r.current && !isViewer && (running || r.mode === "starting" ? (
          <button className="btn min-h-[34px] px-2 text-[12px]" onClick={() => officeActions.stopAgent(r.agent.id)}>
            Stop
          </button>
        ) : (
          <button className="btn min-h-[34px] border-green px-2 text-[12px] text-green" onClick={() => officeActions.startAgent(r.agent.id)}>
            Start
          </button>
        ))}
        <span className="flex-1" />
        <button className="btn min-h-[34px] w-9 px-0 text-[13px]" aria-pressed={pinned} onClick={onPin} title={pinned ? "Unpin" : "Pin to the top"}>
          ⌖
        </button>
        <button className="btn min-h-[34px] w-9 px-0 text-[13px]" onClick={onHide} title="Hide this tile">
          ◌
        </button>
        <button className="btn min-h-[34px] w-9 px-0 text-[13px]" onClick={onMax} title={max ? "Back to the grid (Esc)" : `Fill the screen${index && index <= 9 ? ` (${index})` : ""}`}>
          {max ? "⤡" : "⤢"}
        </button>
      </footer>
    </section>
  );
}
