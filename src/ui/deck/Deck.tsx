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

// Board, Inbox, PRs, Findings and Flow are pages kept in the drawer state, so ⌘K and links land on them too.
const PAGE_OF: Partial<Record<string, RailId>> = { boards: "board", actions: "inbox", prs: "prs", findings: "findings", flow: "flow" };

/**
 * The command deck (desktop, 1000 px and up; docs/design/command-deck.md): header, icon rail, and either the home
 * screen (the orb with the team in orbit and the stage ribbon) or a page. An agent, a terminal, an environment or
 * the projects open in the slide-over on the right. Colours come from the project's theme (data-theme on <html>).
 */
export function Deck() {
  const snap = useOffice((s) => s.snap);
  const view = useUi((s) => s.view);
  const drawer = useUi((s) => s.drawer);
  const maximized = useUi((s) => s.drawerMaximized);
  const reduce = useReducedMotion();
  const [page, setPage] = useState<Page>("home");
  const [thread, setThread] = useState<string | null>(null);

  // Typing must never land in a panel that is closing: when the panel changes, the old one gives up focus.
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
  // Chat is a list beside the open thread; it opens on the lead until you pick someone (or the Team thread).
  const chatWith = thread ?? snap.config.team.find((a) => a.isLead)?.id ?? snap.config.team[0]?.id ?? null;
  const main =
    drawer?.kind === "boards" ? <BoardsDrawer key={drawer.stageId ?? "all"} initialBoardId={drawer.boardId} initialStageId={drawer.stageId} />
    : drawer?.kind === "actions" ? <ActionItemsDrawer />
    : drawer?.kind === "prs" ? <PrDrawer />
    : drawer?.kind === "findings" ? <FindingsDrawer />
    : drawer?.kind === "flow" ? <FlowDrawer />
    : page === "chat" ? (
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[320px] shrink-0 flex-col border-r border-white/[0.08]">
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

  // The Grid is its own full screen; an agent (or a terminal, an environment, projects) opens over it, Esc returns.
  const grid = view === "command" && !drawerPage;
  const slideOver = (
    <AnimatePresence mode="wait">
      {side && sideKey && (
        <motion.aside
          key={sideKey}
          initial={reduce ? false : { opacity: 0, x: 32 }}
          animate={{ opacity: 1, x: 0 }}
          exit={reduce ? { pointerEvents: "none" } : { opacity: 0, x: 24, pointerEvents: "none" }}
          transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
          className={`fixed bottom-3 right-3 z-30 flex flex-col overflow-hidden rounded-2xl hud-drawer ${maximized ? "" : "w-[min(calc(100vw-120px),760px)]"}`}
          style={{ top: grid ? 12 : DECK.header + 12, left: maximized ? (grid ? 12 : DECK.rail + 12) : undefined }}
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
      {home && <ParticleCore workingCount={workingCount} attentionCount={attention} palette={theme.orb} />}
      {home && activeGoals.length > 0 && (
        <div
          className="no-scrollbar fixed z-10 flex items-center gap-2 overflow-x-auto px-4"
          style={{ top: DECK.header + 10, left: DECK.rail, right: 0 }}
          aria-label="Active goals"
        >
          {activeGoals.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => go("goals")}
              className="deck-pill flex shrink-0 items-center gap-2 rounded-full px-3 py-1 text-[12px]"
              title={`${g.title}: ${g.done} of ${g.total} tasks done · $${g.usd.toFixed(2)} spent`}
            >
              <span className="font-term text-muted">{g.id}</span>
              <span className="max-w-[200px] truncate text-ink">{g.title}</span>
              <span className="font-display text-accent">
                {g.done}/{g.total}
              </span>
              {g.current && <span className="text-muted">· {g.current}</span>}
            </button>
          ))}
        </div>
      )}
      {home && (
        <AgentOrbit
          team={team}
          tasks={snap.tasks}
          activeAgentId={drawer?.kind === "agent" ? drawer.id : null}
          redTeamProject={theme.id !== "build"}
          lift={!snap.welcome && !snap.config.template} // clear of the read-only note
          caption={
            team.length
              ? `${snap.config.project.name} · ${workingCount} working${attention ? ` · ${attention} need${attention === 1 ? "s" : ""} you` : ""}${activeTasks ? ` · ${activeTasks} task${activeTasks === 1 ? "" : "s"} in flight` : ""}`
              : snap.config.template
                ? "No agents yet. Add a team in Settings → Team."
                : "No agents in this project."
          }
        />
      )}
      {home && <StageRibbon snap={snap} theme={theme} />}

      <DeckHeader snap={snap} theme={theme} workingCount={workingCount} activeTasks={activeTasks} />
      <DeckRail current={current} security={security} attention={attention} onGo={go} />

      <AnimatePresence mode="wait">
        {!home && (
          <motion.main
            key={current}
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="fixed bottom-3 right-3 z-10 flex min-w-0"
            style={{ top: DECK.header + 12, left: DECK.rail + 12 }}
          >
            <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl hud-drawer">{main}</section>
          </motion.main>
        )}
      </AnimatePresence>

      {slideOver}
    </div>
  );
}
