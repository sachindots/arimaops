import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useState, type ReactNode } from "react";
import { modeOf } from "../../data/mode";
import { selectAttention, selectTeam, useOffice } from "../../store/office";
import { ui, useUi } from "../../store/ui";
import { CommandView } from "../command/CommandView";
import { AgentList, ChatList, More, NAV, NavIcon, Thread, type Tab } from "../compact/CompactApp";
import { ActionItemsDrawer } from "../drawers/ActionItemsDrawer";
import { AgentDrawer } from "../drawers/AgentDrawer";
import { BoardsDrawer } from "../drawers/BoardsDrawer";
import { CtoDrawer } from "../drawers/CtoDrawer";
import { EnvironmentDrawer } from "../drawers/EnvironmentDrawer";
import { FindingsDrawer } from "../drawers/FindingsDrawer";
import { FlowDrawer } from "../drawers/FlowDrawer";
import { PrDrawer } from "../drawers/PrDrawer";
import { TerminalDrawer } from "../drawers/TerminalDrawer";
import { AgentOrbit } from "./AgentOrbit";
import { UsagePage } from "./UsagePage";
import { CommandBar } from "./CommandBar";
import { ParticleCore } from "./ParticleCore";
import { StageStrip } from "./StageStrip";
import { TopLeftBrand, TopRightTelemetry } from "./TelemetryCorners";
import { projectMode } from "./theme";

type Page = Tab | "usage";
type RailId = Page | "flow" | "prs" | "findings" | "grid";

const EXTRA: { id: RailId; label: string; icon: ReactNode }[] = [
  { id: "flow", label: "Flow", icon: <path d="M3 6h5v5H3zM16 13h5v5h-5zM8 8.5h3a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h1" /> },
  { id: "prs", label: "PRs", icon: <path d="M6 3v12M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 0v3a3 3 0 0 1-3 3H9" /> },
  { id: "findings", label: "Findings", icon: <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6zM12 8v5M12 16h.01" /> },
  { id: "usage", label: "Usage", icon: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /> },
  { id: "grid", label: "Grid", icon: <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" /> },
];

// Board, Inbox, PRs and Findings are pages: the drawer state says which, so ⌘K and links land on them too.
const PAGE_OF: Partial<Record<string, RailId>> = { boards: "board", actions: "inbox", prs: "prs", findings: "findings", flow: "flow" };

/**
 * Desktop layout (1000 px and up): a top bar (project, ⌘K, telemetry), a slim icon rail, and the page.
 * Home is the HUD: the particle core with the team in orbit around it. Board, Inbox,
 * PRs and Findings are full pages; an agent, a terminal, an environment or projects open in a side drawer.
 */
export function SpatialHud() {
  const snap = useOffice((s) => s.snap);
  const view = useUi((s) => s.view);
  const drawer = useUi((s) => s.drawer);
  const maximized = useUi((s) => s.drawerMaximized);
  const reduce = useReducedMotion();
  const [tab, setTab] = useState<Page>("home");
  const [thread, setThread] = useState<string | null>(null);

  if (!snap) return null;

  const team = selectTeam(snap);
  const workingCount = team.filter((a) => modeOf(a.status) === "working").length;
  const attention = selectAttention(snap).total;
  const activeTasks = snap.tasks.filter((t) => t.status === "in-progress" || t.status === "in-review" || t.status === "blocked").length;
  const security = !!snap.config.rules.findings || (snap.findings?.length ?? 0) > 0;
  const pageId = drawer ? PAGE_OF[drawer.kind] : undefined;

  const go = (id: RailId) => {
    if (id === "board") return ui.openBoards();
    if (id === "inbox") return ui.openActions();
    if (id === "prs") return ui.openPrs();
    if (id === "flow") return ui.openFlow();
    if (id === "findings") return ui.openFindings();
    ui.closeDrawer();
    if (id === "grid") return ui.setView("command");
    setTab(id);
  };

  // Chat is a list beside the open thread; it opens on the lead until you pick someone.
  const chatWith = thread ?? snap.config.team.find((a) => a.isLead)?.id ?? snap.config.team[0]?.id ?? null;
  const main =
    drawer?.kind === "boards" ? <BoardsDrawer initialBoardId={drawer.boardId} />
    : drawer?.kind === "actions" ? <ActionItemsDrawer />
    : drawer?.kind === "prs" ? <PrDrawer />
    : drawer?.kind === "findings" ? <FindingsDrawer />
    : drawer?.kind === "flow" ? <FlowDrawer />
    : tab === "chat" ? (
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[320px] shrink-0 flex-col border-r border-white/[0.08]">
          <ChatList onOpen={setThread} selected={chatWith} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">{chatWith && <Thread key={chatWith} agentId={chatWith} />}</div>
      </div>
    )
    : tab === "agents" ? <AgentList />
    : tab === "more" ? <More />
    : tab === "usage" ? <UsagePage />
    : null;
  const home = main === null;

  const side =
    drawer?.kind === "agent" ? <AgentDrawer id={drawer.id} initialTab={drawer.tab} />
    : drawer?.kind === "env" ? <EnvironmentDrawer name={drawer.name} />
    : drawer?.kind === "terminal" ? <TerminalDrawer />
    : drawer?.kind === "cto" ? <CtoDrawer />
    : null;
  const sideKey = drawer ? (drawer.kind === "agent" ? `agent:${drawer.id}` : drawer.kind === "env" ? `env:${drawer.name}` : drawer.kind) : null;

  const rail = [...NAV.filter((n) => n.id !== "more"), ...EXTRA.filter((n) => n.id !== "findings" || security || pageId === "findings"), ...NAV.filter((n) => n.id === "more")];
  const current: RailId = pageId ?? tab;

  // The Grid is its own full screen; an agent (or a terminal, an environment, projects) opens over it, Esc returns.
  const grid = view === "command" && !pageId;
  const sidePanel = (
    <AnimatePresence mode="wait">
      {side && sideKey && (
        <motion.aside
          key={sideKey}
          initial={reduce ? false : { opacity: 0, x: 28 }}
          animate={{ opacity: 1, x: 0 }}
          exit={reduce ? undefined : { opacity: 0, x: 20 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className={`fixed bottom-4 right-4 ${grid ? "top-4" : "top-[64px]"} z-20 flex flex-col overflow-hidden rounded-2xl hud-drawer ${
            maximized ? (grid ? "left-4" : "left-[92px]") : "w-[min(calc(100vw-120px),760px)]"
          }`}
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
        {sidePanel}
      </>
    );

  return (
    <div className="fixed inset-0 overflow-hidden hud-void" aria-label="ArimaOps">
      {home && <ParticleCore workingCount={workingCount} attentionCount={attention} redTeam={projectMode(snap) === "redteam" || projectMode(snap) === "purpleteam"} />}
      {home && (
        <AgentOrbit
          team={team}
          tasks={snap.tasks}
          activeAgentId={drawer?.kind === "agent" ? drawer.id : null}
          redTeamProject={projectMode(snap) !== "build"}
          lift={!snap.welcome && !snap.config.template} // clear of the read-only note
          caption={team.length ? `${team.length} agent${team.length === 1 ? "" : "s"} · ${workingCount} working${activeTasks ? ` · ${activeTasks} task${activeTasks === 1 ? "" : "s"} in flight` : ""}` : snap.config.template ? "No agents yet. Add a team in Settings → Team." : "No agents in this project."}
        />
      )}

      {home && <StageStrip snap={snap} />}

      <header className="pointer-events-none fixed inset-x-5 top-3 z-30 flex items-center justify-between gap-3">
        <TopLeftBrand snap={snap} mode={projectMode(snap)} />
        <CommandBar snap={snap} />
        <TopRightTelemetry snap={snap} workingCount={workingCount} activeTasks={activeTasks} />
      </header>

      <nav className="fixed bottom-4 left-4 top-[64px] z-20 flex w-[64px] flex-col items-center gap-1 rounded-2xl py-2 hud-glass" aria-label="Sections">
        {rail.map((n) => {
          const on = current === n.id;
          return (
            <button
              key={n.id}
              className={`relative flex w-[54px] cursor-pointer flex-col items-center gap-0.5 rounded-lg py-1.5 text-[11px] transition-colors ${
                on ? "bg-accent/12 text-accent" : "text-muted hover:bg-white/[0.05] hover:text-ink"
              }`}
              aria-current={on ? "page" : undefined}
              onClick={() => go(n.id)}
            >
              <NavIcon>{n.icon}</NavIcon>
              <span>{n.label}</span>
              {n.id === "inbox" && attention > 0 && (
                <span className="absolute right-1 top-0.5 rounded-full bg-amber px-1 font-term text-[11px] font-semibold leading-[15px] text-navy">{attention}</span>
              )}
            </button>
          );
        })}
      </nav>

      {!home && (
        <main className="fixed bottom-4 left-[92px] right-4 top-[64px] z-10 flex min-w-0">
          <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl hud-drawer">{main}</section>
        </main>
      )}

      {sidePanel}
    </div>
  );
}
