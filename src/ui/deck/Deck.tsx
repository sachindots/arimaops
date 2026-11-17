import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";
import { modeOf } from "../../data/mode";
import { selectAttention, selectTeam, useOffice } from "../../store/office";
import { ui, useUi } from "../../store/ui";
import { CommandView } from "../command/CommandView";
import { AgentList, ChatList, More, Thread } from "../compact/CompactApp";
import { ActionItemsDrawer } from "../drawers/ActionItemsDrawer";
import { AgentDrawer } from "../drawers/AgentDrawer";
import { BoardsDrawer } from "../drawers/BoardsDrawer";
import { CtoDrawer } from "../drawers/CtoDrawer";
import { EnvironmentDrawer } from "../drawers/EnvironmentDrawer";
import { FindingsDrawer } from "../drawers/FindingsDrawer";
import { FlowDrawer } from "../drawers/FlowDrawer";
import { PrDrawer } from "../drawers/PrDrawer";
import { TerminalDrawer } from "../drawers/TerminalDrawer";
import { AgentOrbit } from "../hud/AgentOrbit";
import { ParticleCore } from "../hud/ParticleCore";
import { UsagePage } from "../hud/UsagePage";
import { projectTheme } from "../theme/projectTheme";
import { DeckHeader } from "./DeckHeader";
import { DeckRail, type RailId } from "./DeckRail";
import { DECK } from "./frame";
import { GoalsPage } from "./GoalsPage";
import { StageRibbon } from "./StageRibbon";

type Page = "home" | "agents" | "chat" | "goals" | "usage" | "more";

const PAGE_OF: Partial<Record<string, RailId>> = { boards: "board", actions: "inbox", prs: "prs", findings: "findings", flow: "flow" };

/**
 * The Spatial Multi-Agent Command Deck (desktop, 1000 px and up):
 * Top header, micro icon rail, dot-matrix spatial canvas with the 3D particle sphere and orbiting agent pods,
 * streamlined bottom stage ribbon, and a docked right slide-over drawer.
 */
export function Deck() {
  const snap = useOffice((s) => s.snap);
  const view = useUi((s) => s.view);
  const drawer = useUi((s) => s.drawer);
  const maximized = useUi((s) => s.drawerMaximized);
  const reduce = useReducedMotion();
  const [page, setPage] = useState<Page>("home");
  const [thread, setThread] = useState<string | null>(null);

  const panelKey = drawer ? (drawer.kind === "agent" ? `agent:${drawer.id}` : drawer.kind) : null;
  useEffect(() => {
    const el = document.activeElement;
    if (el instanceof HTMLElement && el.closest('[aria-label="Side panel"]')) el.blur();
  }, [panelKey]);

  if (!snap) return null;

  const theme = projectTheme(snap);
  const team = selectTeam(snap);
  const workingCount = team.filter((a) => modeOf(a.status) === "working").length;
  const attention = selectAttention(snap).total;
  const activeTasks = snap.tasks.filter((t) => t.status === "in-progress" || t.status === "in-review" || t.status === "blocked").length;
  const security = theme.security || (snap.findings?.length ?? 0) > 0;
  const drawerPage = drawer ? PAGE_OF[drawer.kind] : undefined;

  const go = (id: RailId) => {
    if (id === "board") return ui.openBoards();
    if (id === "inbox") return ui.openActions();
    if (id === "prs") return ui.openPrs();
    if (id === "flow") return ui.openFlow();
    if (id === "findings") return ui.openFindings();
    ui.closeDrawer();
    if (id === "grid") return ui.setView("command");
    setPage(id);
  };

  const activeGoals = (snap.goals ?? []).filter((g) => g.status === "active");
  const chatWith = thread ?? snap.config.team.find((a) => a.isLead)?.id ?? snap.config.team[0]?.id ?? null;
  const main =
    drawer?.kind === "boards" ? <BoardsDrawer key={drawer.stageId ?? "all"} initialBoardId={drawer.boardId} initialStageId={drawer.stageId} />
    : drawer?.kind === "actions" ? <ActionItemsDrawer />
    : drawer?.kind === "prs" ? <PrDrawer />
    : drawer?.kind === "findings" ? <FindingsDrawer />
    : drawer?.kind === "flow" ? <FlowDrawer />
    : page === "chat" ? (
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[320px] shrink-0 flex-col border-r border-[var(--border-hairline)]">
          <ChatList onOpen={setThread} selected={chatWith} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">{chatWith && <Thread key={chatWith} agentId={chatWith} />}</div>
      </div>
    )
    : page === "agents" ? <AgentList />
    : page === "goals" ? <GoalsPage />
    : page === "more" ? <More />
    : page === "usage" ? <UsagePage />
    : null;
  const home = main === null;

  const side =
    drawer?.kind === "agent" ? <AgentDrawer id={drawer.id} initialTab={drawer.tab} />
    : drawer?.kind === "env" ? <EnvironmentDrawer name={drawer.name} />
    : drawer?.kind === "terminal" ? <TerminalDrawer />
    : drawer?.kind === "cto" ? <CtoDrawer />
    : null;
  const sideKey = drawer ? (drawer.kind === "agent" ? `agent:${drawer.id}` : drawer.kind === "env" ? `env:${drawer.name}` : drawer.kind) : null;
  const current: RailId = drawerPage ?? page;

  const grid = view === "command" && !drawerPage;
  const slideOver = (
    <AnimatePresence mode="wait">
      {side && sideKey && (
        <motion.aside
          key={sideKey}
          initial={reduce ? false : { x: "100%" }}
          animate={{ x: 0 }}
          exit={reduce ? { pointerEvents: "none" } : { x: "100%", pointerEvents: "none" }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          className={`hud-drawer fixed bottom-0 right-0 z-50 flex flex-col overflow-hidden border-l ${maximized ? "" : "w-[min(calc(100vw-80px),680px)]"}`}
          style={{ top: grid ? 0 : DECK.header, left: maximized ? (grid ? 0 : DECK.rail) : undefined }}
          aria-label="Side panel"
        >
          {side}
        </motion.aside>
      )}
    </AnimatePresence>
  );
  if (grid)
    return (
      <>
        <CommandView />
        {slideOver}
      </>
    );

  return (
    <div className="deck fixed inset-0 overflow-hidden" aria-label="ArimaOps">
      {home && <div className="deck-grid pointer-events-none fixed inset-0" aria-hidden="true" />}

      {/* Top-left context subtitle + active goals pills on Home */}
      {home && (
        <div
          className="pointer-events-none fixed z-20 flex flex-wrap items-center gap-2 px-6"
          style={{ top: DECK.header + 16, left: DECK.rail }}
        >
          <span className="h-2 w-2 rounded-full" style={{ background: "var(--accent)" }} />
          <span className="text-[12px] font-semibold text-ink">
            {theme.security ? "Offensive Security Operation" : "Multi-Agent Swarm Orbit"}
          </span>
          <span className="text-muted/40">/</span>
          <span className="text-[12px] text-muted">
            {workingCount} active agent{workingCount === 1 ? "" : "s"}
            {attention ? ` · ${attention} pending approval${attention === 1 ? "" : "s"}` : ""}
            {activeTasks ? ` · ${activeTasks} task${activeTasks === 1 ? "" : "s"} in flight` : ""}
          </span>
          {activeGoals.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => go("goals")}
              className="deck-pill pointer-events-auto flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px]"
              title={`${g.title}: ${g.done} of ${g.total} tasks done · $${g.usd.toFixed(2)} spent`}
            >
              <span className="font-term text-muted">{g.id}</span>
              <span className="max-w-[160px] truncate font-medium text-ink">{g.title}</span>
              <span className="font-semibold text-accent">
                {g.done}/{g.total}
              </span>
            </button>
          ))}
        </div>
      )}

      {home && <ParticleCore workingCount={workingCount} attentionCount={attention} palette={theme.orb} />}
      {home && (
        <AgentOrbit
          team={team}
          tasks={snap.tasks}
          activeAgentId={drawer?.kind === "agent" ? drawer.id : null}
          redTeamProject={theme.id !== "build"}
          lift={!snap.welcome && !snap.config.template}
          caption={`${workingCount} working${attention ? ` · ${attention} need you` : ""}`}
        />
      )}
      {home && <StageRibbon snap={snap} theme={theme} />}

      <DeckHeader snap={snap} theme={theme} workingCount={workingCount} activeTasks={activeTasks} />
      <DeckRail current={current} security={security} attention={attention} onGo={go} />

      <AnimatePresence mode="wait">
        {!home && (
          <motion.main
            key={current}
            initial={reduce ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="fixed bottom-0 right-0 z-10 flex min-w-0 bg-[var(--color-grass)]"
            style={{ top: DECK.header, left: DECK.rail }}
          >
            <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--surface-card)]">{main}</section>
          </motion.main>
        )}
      </AnimatePresence>

      {slideOver}
    </div>
  );
}
