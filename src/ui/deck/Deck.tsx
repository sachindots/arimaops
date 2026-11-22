import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";
import { modeOf } from "../../data/mode";
import { selectAttention, selectTeam, useOffice } from "../../store/office";
import { ui, useUi, type WorkspaceId } from "../../store/ui";
import { CommandView } from "../command/CommandView";
import { FactoryPage } from "../command/Factory";
import { ActionItemsDrawer } from "../drawers/ActionItemsDrawer";
import { AgentDrawer } from "../drawers/AgentDrawer";
import { CtoDrawer } from "../drawers/CtoDrawer";
import { EnvironmentDrawer } from "../drawers/EnvironmentDrawer";
import { TerminalDrawer } from "../drawers/TerminalDrawer";
import { AgentOrbit } from "../hud/AgentOrbit";
import { ParticleCore } from "../hud/ParticleCore";
import { UsagePage } from "../hud/UsagePage";
import { PreviewPage } from "../preview/PreviewPage";
import { SettingsPage } from "../settings/SettingsModal";
import { TeamPage } from "../team/TeamPage";
import { projectTheme } from "../theme/projectTheme";
import { WorkPage } from "../work/WorkPage";
import { DeckHeader } from "./DeckHeader";
import { DeckBottomNav, DeckRail } from "./DeckRail";
import { DECK, homeSides } from "./frame";
import { HomeCompact } from "./HomeCompact";
import { ActivityPanel, HomeIntentBar, NeedsYouPanel } from "./HomePanels";
import { OpsPage } from "./OpsPage";
import { StageRibbon } from "./StageRibbon";

const WORKSPACE_OF_DRAWER: Partial<Record<string, WorkspaceId>> = {
  boards: "work",
  prs: "work",
  findings: "work",
  flow: "work",
  actions: "inbox",
};

/**
 * Unified responsive ArimaOps shell across Desktop (>= 1000px), Tablet (900px), and Phone (390px):
 * - Single routing tree & state store: resizing 1440px <-> 900px <-> 390px never resets active workspace or drafts.
 * - >= 1000px: docked left rail, spatial Home Command Deck, desktop header, right slide-over panel.
 * - < 1000px: responsive header (with Ops button), 5-workspace bottom nav, compact scrolling Home, full-screen overlays.
 */
export function Deck() {
  const snap = useOffice((s) => s.snap);
  const view = useUi((s) => s.view);
  const settings = useUi((s) => s.settings !== null);
  const drawer = useUi((s) => s.drawer);
  const maximized = useUi((s) => s.drawerMaximized);
  const workspace = useUi((s) => s.workspace);
  const railExpanded = useUi((s) => s.railExpanded);
  const reduce = useReducedMotion();
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setWidth(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);

  const panelKey = drawer ? (drawer.kind === "agent" ? `agent:${drawer.id}` : drawer.kind) : null;
  useEffect(() => {
    const el = document.activeElement;
    if (el instanceof HTMLElement && el.closest('[aria-label="Side panel"]')) el.blur();
  }, [panelKey]);

  if (!snap) return null;

  const desktop = width >= 1000;
  const theme = projectTheme(snap);
  const team = selectTeam(snap);
  const sides = homeSides(width, team.length);
  const workingCount = team.filter((a) => modeOf(a.status) === "working").length;
  const attention = selectAttention(snap).total;
  const activeTasks = snap.tasks.filter(
    (t) => t.status === "in-progress" || t.status === "in-review" || t.status === "blocked",
  ).length;
  const security = theme.security || (snap.findings?.length ?? 0) > 0;
  const drawerWorkspace = drawer ? WORKSPACE_OF_DRAWER[drawer.kind] : undefined;
  const current: WorkspaceId = drawerWorkspace ?? workspace;
  const railWidth = railExpanded ? DECK.railExpanded : DECK.rail;

  const go = (id: WorkspaceId) => {
    ui.setWorkspace(id);
  };

  const pageMain = settings ? (
    <SettingsPage />
  ) : current === "work" ? (
    <WorkPage />
  ) : current === "inbox" ? (
    <ActionItemsDrawer />
  ) : current === "team" ? (
    <TeamPage />
  ) : current === "preview" ? (
    <PreviewPage />
  ) : current === "usage" ? (
    <UsagePage />
  ) : current === "factory" ? (
    <FactoryPage />
  ) : current === "ops" ? (
    <OpsPage />
  ) : null;

  const home = pageMain === null;
  const showSpatialHome = home && desktop;
  const showMainArea = !home || !desktop;

  const side =
    drawer?.kind === "agent" ? (
      <AgentDrawer id={drawer.id} initialTab={drawer.tab} />
    ) : drawer?.kind === "env" ? (
      <EnvironmentDrawer name={drawer.name} />
    ) : drawer?.kind === "terminal" ? (
      <TerminalDrawer />
    ) : drawer?.kind === "cto" ? (
      <CtoDrawer />
    ) : null;
  const sideKey = drawer
    ? drawer.kind === "agent"
      ? `agent:${drawer.id}`
      : drawer.kind === "env"
        ? `env:${drawer.name}`
        : drawer.kind
    : null;
  const mainKey = settings ? "settings" : current;

  const grid = view === "command" && !drawerWorkspace && !settings;
  const slideOver = (
    <AnimatePresence mode="wait">
      {side && sideKey && (
        <motion.aside
          key={sideKey}
          initial={reduce ? false : { x: "100%" }}
          animate={{ x: 0 }}
          exit={reduce ? { pointerEvents: "none" } : { x: "100%", pointerEvents: "none" }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          className={`hud-drawer fixed bottom-0 right-0 z-50 flex flex-col overflow-hidden ${
            desktop ? (maximized ? "border-l" : "w-[min(calc(100vw-80px),680px)] border-l") : "left-0"
          }`}
          style={{
            top: grid ? 0 : DECK.header,
            left: desktop ? (maximized ? (grid ? 0 : railWidth) : undefined) : 0,
          }}
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
      {showSpatialHome && <div className="deck-grid pointer-events-none fixed inset-0" aria-hidden="true" />}

      {showSpatialHome && sides.left > 0 && <NeedsYouPanel snap={snap} onGoals={() => ui.openGoals()} />}
      {showSpatialHome && sides.right > 0 && <ActivityPanel snap={snap} />}

      {showSpatialHome && (
        <ParticleCore
          workingCount={workingCount}
          attentionCount={attention}
          palette={theme.orb}
          teamSize={team.length}
        />
      )}
      {showSpatialHome && (
        <AgentOrbit
          team={team}
          tasks={snap.tasks}
          activeAgentId={drawer?.kind === "agent" ? drawer.id : null}
          lift={!snap.welcome && !snap.config.template}
          caption={`${team.length} agent${team.length === 1 ? "" : "s"} · ${workingCount} working${
            attention ? ` · ${attention} need you` : ""
          }`}
        />
      )}
      {showSpatialHome && <HomeIntentBar snap={snap} />}
      {showSpatialHome && <StageRibbon snap={snap} theme={theme} />}

      <DeckHeader snap={snap} theme={theme} workingCount={workingCount} activeTasks={activeTasks} />
      {desktop ? (
        <DeckRail current={current} security={security} attention={attention} onGo={go} />
      ) : (
        <DeckBottomNav current={current} attention={attention} onGo={go} />
      )}

      <AnimatePresence mode="wait">
        {showMainArea && (
          <motion.main
            key={mainKey}
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="fixed right-0 z-10 flex min-w-0 bg-[var(--color-grass)] transition-[left] duration-150"
            style={{
              top: DECK.header,
              left: desktop ? railWidth : 0,
              bottom: desktop ? 0 : `calc(${DECK.bottomNav}px + env(safe-area-inset-bottom))`,
            }}
          >
            <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--surface-card)]">
              {pageMain ?? <HomeCompact />}
            </section>
          </motion.main>
        )}
      </AnimatePresence>

      {slideOver}
    </div>
  );
}
