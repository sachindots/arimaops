import type { SimSpeed } from "../../data/source";
import { isViewer, officeActions, selectAttention, useOffice } from "../../store/office";
import { ui, useUi } from "../../store/ui";

const SPEEDS: SimSpeed[] = [1, 2, 4];

function Logo() {
  return (
    <svg className="h-[30px] w-[30px] shrink-0" viewBox="0 0 10 10" shapeRendering="crispEdges" aria-hidden>
      <rect x="0" y="0" width="10" height="10" fill="#050609" />
      <rect x="1" y="1" width="8" height="8" fill="#0a0c12" stroke="#ff1744" strokeWidth="1" />
      <rect x="2" y="6" width="2" height="2" fill="#ff1744" />
      <rect x="5" y="2" width="3" height="6" fill="#00ff66" />
      <rect x="6" y="3" width="1" height="4" fill="#0a0c12" />
    </svg>
  );
}

export function TopBar() {
  const snap = useOffice((s) => s.snap);
  const speed = useOffice((s) => s.speed);
  const hasDev = useOffice((s) => s.presets !== null);
  const planBoardId = useUi((s) => s.planBoardId);
  const attention = selectAttention(snap).total;
  const debugOpen = useUi((s) => s.debugOpen);
  const live = useOffice((s) => s.live);
  if (!snap) return null;
  const setupIssues = snap.setup.checks.filter((c) => c.status !== "ok").length;
  const stopped = snap.agents.filter((a) => a.session.state === "stopped" || a.session.state === "failed");

  // Live: count real running sessions. Mock: every agent counts as running.
  const runningIds = new Set(snap.agents.filter((a) => a.session.state === "running").map((a) => a.agentId));
  const sandboxes = snap.config.team.filter((a) => a.mode === "sandbox" && runningIds.has(a.id)).length;
  const local = snap.config.team.filter((a) => a.mode === "local" && runningIds.has(a.id)).length;
  const boards = [...snap.boards].sort((a, b) => a.order - b.order);
  const active = boards.filter((b) => b.status === "active");
  const openPrs = snap.pullRequests.filter((p) => !p.merged && !p.closed).length;

  return (
    <header className="hq-topbar panel fixed left-4 right-4 top-[10px] z-10 flex h-[50px] items-center gap-4 px-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <Logo />
        <b className="whitespace-nowrap text-[22px] font-bold tracking-[0.04em]">
          <span className="text-red">.</span>hq
        </b>
        {isViewer && (
          <span className="chip shrink-0 text-[12px]" style={{ ["--c" as string]: "#00e5ff" }} title="Read-only link: watch + chat. Use the operator link to control agents.">
            Viewer
          </span>
        )}
        {!live && (
          <span className="chip shrink-0 text-[12px]" style={{ ["--c" as string]: "#ff1744" }} title="Running on mock data. Start the real .hq with `pnpm dev:hq`.">
            Demo data
          </span>
        )}
        <span className="truncate text-[16px] text-muted">
          — <em className="font-semibold not-italic text-ink">{snap.config.project.name}</em>{" "}
          <span className="font-term text-[17px] text-green">{snap.config.project.repo}</span>
        </span>
      </div>
      <div className="flex-1" />

      <label className="flex items-center gap-2 text-[14px]">
        <span className="text-muted">Plan wall</span>
        <select
          className="field w-[190px] py-0 text-[14px]"
          value={planBoardId ?? ""}
          onChange={(e) => ui.showBoardOnWall(e.target.value || null)}
          aria-label="Board shown on the plan wall"
        >
          <option value="">First active ({active[0]?.title ?? "none"})</option>
          {boards.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title} · {b.status}
            </option>
          ))}
        </select>
      </label>

      {hasDev && (
        <div className="flex items-center gap-1.5" role="group" aria-label="Simulation speed">
          {SPEEDS.map((s) => (
            <button key={s} className="btn px-2 text-[14px]" aria-pressed={speed === s} onClick={() => officeActions.setSpeed(s)}>
              {s}x
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-1.5">
        <button className="btn w-8 px-0 text-[18px] leading-none" aria-label="Zoom out" onClick={() => ui.zoom(-1)}>
          −
        </button>
        <button className="btn w-8 px-0 text-[18px] leading-none" aria-label="Zoom in" onClick={() => ui.zoom(1)}>
          +
        </button>
      </div>

      <div
        className="flex items-center gap-2 whitespace-nowrap border border-[rgba(0,255,102,0.4)] bg-navy px-2.5 py-0.5 text-[15px] text-ink"
        title="Each agent runs in its own isolated Docker Sandbox (microVM)"
      >
        <span>
          Sandbox · <b className="text-green">{sandboxes}</b> running{local ? ` · ${local} local` : ""}
        </span>
        <i className="led" style={runningIds.size ? undefined : { background: "#6e7b94", boxShadow: "none", animation: "none" }} />
      </div>

      {live && !isViewer && stopped.length > 0 && (
        <button className="btn text-[14px]" onClick={() => stopped.forEach((a) => officeActions.startAgent(a.agentId))}>
          Start {stopped.length === snap.agents.length ? "team" : `${stopped.length} stopped`}
        </button>
      )}
      {live && (
        <button className="btn text-[14px]" onClick={() => ui.openSetup()} title="Setup checklist">
          Setup{setupIssues ? ` · ${setupIssues}` : " ✓"}
        </button>
      )}
      <div className="flex gap-1.5">
        <button
          className="btn text-[14px]"
          style={attention ? { background: "rgba(255, 23, 68, 0.22)", borderColor: "#ff1744", color: "#ff5c8a" } : undefined}
          onClick={() => ui.openActions()}
          title="Everything waiting on you"
        >
          Action items{attention ? ` · ${attention}` : ""}
        </button>
        <button
          className="btn text-[14px]"
          style={{ borderColor: "rgba(0, 229, 255, 0.45)", color: "#00e5ff" }}
          onClick={() => ui.openCto()}
          title="Multi-project CTO Command Center & Overwatch"
        >
          CTO Overwatch
        </button>
        <button className="btn text-[14px]" onClick={() => ui.openBoards(planBoardId ?? undefined)}>
          Boards
        </button>
        <button className="btn text-[14px]" onClick={() => ui.openPrs()}>
          PRs{openPrs ? ` · ${openPrs}` : ""}
        </button>
        {!isViewer && <button className="btn text-[14px]" onClick={() => ui.openTerminal()} title="Your own shell on this machine: the repo, an agent's folder or any folder">
          Terminal
        </button>}
      </div>
      {!isViewer && (
        <button className="btn text-[14px]" onClick={() => ui.openSettings("team")}>
          Settings
        </button>
      )}
      <button className="btn text-[14px]" aria-pressed={debugOpen} onClick={() => ui.toggleDebug()} title="Debug panel (D)">
        Debug
      </button>
    </header>
  );
}
