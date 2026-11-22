import type { OfficeSnapshot } from "../../data/types";
import { isViewer, selectAttention, setupToDo, useOffice } from "../../store/office";
import { ui, useUi } from "../../store/ui";
import { useAgentUsage } from "../../store/usage";
import { CommandBar } from "../hud/CommandBar";
import { fmtUsd, Logo } from "../kit";
import type { Theme } from "../theme/projectTheme";
import { DECK } from "./frame";
import { Icon } from "./Icon";

/**
 * Single responsive top header across Desktop (>=1000px), Tablet (900px), and Phone (390px):
 * Left: Logo + ArimaOps / Project Switcher + status dot + Grid (sm+).
 * Center: ⌘K Command Bar (desktop >=1000px).
 * Right: Telemetry (xl+), Needs You pill, Pick team, Setup (sm+), Ops (<1000px), Dark/Light toggle, Settings.
 */
export function DeckHeader({
  snap,
  theme,
  workingCount,
}: {
  snap: OfficeSnapshot;
  theme: Theme;
  workingCount: number;
  activeTasks: number;
}) {
  const live = useOffice((s) => s.live);
  const connection = useOffice((s) => s.connection);
  const attention = selectAttention(snap).total;
  const setup = setupToDo(snap);
  const welcomeDismissed = useUi((s) => s.welcomeDismissed);
  const scheme = useUi((s) => s.scheme);
  const workspace = useUi((s) => s.workspace);
  const settingsOpen = useUi((s) => s.settings !== null);
  const usage = useAgentUsage(1);
  const cost = usage.rows.reduce((sum, a) => sum + a.costUsd, 0);
  const online = !live || connection === "open";
  const kind = theme.security ? theme.label : (snap.config.template?.name ?? theme.label);
  const opsActive = !settingsOpen && (workspace === "ops" || workspace === "usage" || workspace === "factory");

  return (
    <header
      className="deck-bar fixed inset-x-0 top-0 z-40 flex items-center justify-between gap-2 border-b px-3 sm:px-5 lg:px-6"
      style={{ height: DECK.header }}
    >
      {/* Left: Brand & Project Switcher */}
      <div className="flex min-w-0 items-center gap-2 sm:gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Logo size={28} />
          <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
            <span className="hidden text-[13px] font-semibold tracking-tight text-ink min-[1000px]:inline">
              ArimaOps
            </span>
            <span className="hidden text-muted/40 min-[1000px]:inline" aria-hidden="true">
              /
            </span>
            <button
              type="button"
              onClick={() => ui.openCto()}
              title="Switch, create or manage projects"
              className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-lg px-1.5 py-1 font-semibold text-ink transition-colors hover:bg-cream-2 sm:gap-2 sm:px-2"
            >
              <span className="max-w-[116px] truncate text-[13px] sm:max-w-[180px] lg:max-w-[200px]">
                {snap.config.project.name}
              </span>
              <span
                className="hidden shrink-0 rounded-full px-2 py-px text-[12px] font-medium sm:inline-block"
                style={{
                  color: "var(--accent)",
                  background: "color-mix(in srgb, var(--accent) 12%, transparent)",
                }}
              >
                {kind}
              </span>
              <Icon name="expand_more" size={16} className="shrink-0 text-muted" />
            </button>
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${online ? "bg-green" : "bg-amber"}`}
              title={online ? "HQ Online" : "Reconnecting"}
              aria-label={online ? "Connected" : "Reconnecting"}
            />
            <button
              type="button"
              onClick={() => {
                ui.closeDrawer();
                ui.setView("command", false);
              }}
              title="Open Multi-Project Command Grid"
              className="deck-pill hidden cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-cream-2 sm:flex"
            >
              <Icon name="grid_view" size={16} className="text-muted" />
              <span className="hidden md:inline">Grid</span>
            </button>
          </div>
        </div>
        {isViewer && <span className="chip hidden shrink-0 text-[12px] sm:inline-flex">Viewer</span>}
        {!live && (
          <span
            className="chip hidden shrink-0 text-[12px] sm:inline-flex"
            style={{ ["--c" as string]: "var(--accent)" }}
            title="Sample projects and agents running in your browser."
          >
            Demo
          </span>
        )}
      </div>

      {/* Center: Command Bar (desktop >= 1000px) */}
      <div className="hidden w-[min(360px,30vw)] min-[1000px]:block">
        <CommandBar snap={snap} />
      </div>

      {/* Right: Telemetry, Attention Queue, Ops (<1000px), Theme & Settings */}
      <div className="flex shrink-0 items-center gap-1.5 sm:gap-2.5">
        <div className="hidden items-center gap-2.5 text-[12px] text-muted xl:flex">
          <span>
            <strong className="font-semibold text-ink">{workingCount}</strong> Working
          </span>
          <span className="text-muted/40">·</span>
          <span>
            Burn: <strong className="font-semibold text-ink">{fmtUsd(cost)}</strong>
          </span>
        </div>

        {attention > 0 && (
          <button
            type="button"
            onClick={() => ui.openActions()}
            className="deck-need flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold transition-colors sm:px-3.5 sm:py-1.5"
            title="Open the Operator Inbox"
            aria-label={`${attention} Need${attention === 1 ? "s" : ""} You — Open Inbox`}
          >
            <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber" />
            <span className="sm:hidden">{attention}</span>
            <span className="hidden sm:inline">
              {attention} Need{attention === 1 ? "s" : ""} You
            </span>
          </button>
        )}

        {live && snap.welcome && welcomeDismissed && !isViewer && (
          <button
            type="button"
            onClick={() => ui.openWelcome()}
            className="deck-pill flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold text-accent sm:px-3 sm:py-1.5"
            title="Pick a team template"
          >
            <Icon name="groups" size={16} />
            <span className="hidden sm:inline">Pick team</span>
          </button>
        )}

        {live && !snap.welcome && !isViewer && !snap.agents.some((a) => a.session.state === "running") && (
          <button
            type="button"
            onClick={() => ui.openWizard()}
            className="deck-pill flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold text-accent sm:px-3 sm:py-1.5"
            title="Sign in, check this machine and start your first agent"
          >
            <Icon name="rocket_launch" size={16} />
            <span className="hidden sm:inline">Guided setup</span>
          </button>
        )}

        {setup > 0 && (
          <button
            type="button"
            onClick={() => ui.openSetup()}
            className="deck-pill hidden items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold text-amber sm:flex"
            title="Open the setup checklist"
          >
            <Icon name="checklist" size={16} />
            <span>Setup · {setup}</span>
          </button>
        )}

        {/* Compact Ops button (< 1000px): 1 tap to Usage, Host Terminal, Environments, Grid & Switch Server */}
        <button
          type="button"
          onClick={() => (opsActive ? ui.setWorkspace("home") : ui.openOps())}
          aria-label="Ops menu: Usage, Terminal, Environments and Grid"
          aria-pressed={opsActive}
          title="Ops: Usage, Terminal, Environments, Grid"
          className={`deck-pill flex h-8 cursor-pointer items-center justify-center gap-1 rounded-lg px-2 text-[12px] font-medium transition-colors hover:bg-cream-2 min-[1000px]:hidden ${
            opsActive ? "border-[var(--accent)] text-accent" : "text-muted hover:text-ink"
          }`}
        >
          <Icon name="tune" size={17} />
          <span className="hidden sm:inline">Ops</span>
        </button>

        <button
          type="button"
          onClick={() => ui.toggleScheme()}
          aria-label={scheme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          title={scheme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          className="deck-pill flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors hover:bg-cream-2 hover:text-ink"
        >
          <Icon name={scheme === "dark" ? "light_mode" : "dark_mode"} size={18} />
        </button>

        {!isViewer && (
          <button
            type="button"
            onClick={() => ui.openSettings("project")}
            aria-label="Settings"
            title="Settings"
            className="deck-pill flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors hover:bg-cream-2 hover:text-ink"
          >
            <Icon name="settings" size={18} />
          </button>
        )}
      </div>
    </header>
  );
}
