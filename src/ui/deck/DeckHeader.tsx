import type { OfficeSnapshot } from "../../data/types";
import { isViewer, selectAttention, setupToDo, useOffice } from "../../store/office";
import { ui } from "../../store/ui";
import { useAgentUsage } from "../../store/usage";
import { CommandBar } from "../hud/CommandBar";
import { fmtUsd, Logo } from "../kit";
import type { Theme } from "../theme/projectTheme";
import { DECK } from "./frame";
import { Icon } from "./Icon";

/**
 * Top header matching the Spatial Multi-Agent Command Deck specification:
 * Left: lion + ArimaOps / project name with its type chip (opens the project switcher) + online dot.
 * Center: ⌘K Command Bar. The theme follows the project, so there is no domain toggle.
 * Right: Working count · Burn + Need You pill + Settings gear.
 */
export function DeckHeader({ snap, theme, workingCount }: { snap: OfficeSnapshot; theme: Theme; workingCount: number; activeTasks: number }) {
  const live = useOffice((s) => s.live);
  const connection = useOffice((s) => s.connection);
  const attention = selectAttention(snap).total;
  const setup = setupToDo(snap);
  const usage = useAgentUsage(1);
  const cost = usage.rows.reduce((sum, a) => sum + a.costUsd, 0);
  const online = !live || connection === "open";
  // Build projects show their template ("Dev team", "Marketing"); security ones their team colour ("Red team").
  const kind = theme.security ? theme.label : (snap.config.template?.name ?? theme.label);

  return (
    <header
      className="deck-bar fixed inset-x-0 top-0 z-40 flex items-center justify-between border-b px-6"
      style={{ height: DECK.header }}
    >
      {/* Left: Brand & Project Switcher */}
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex items-center gap-2.5">
          <Logo size={32} />
          <div className="flex items-center gap-2">
            <span className="hidden text-[14px] font-extrabold tracking-tight text-ink sm:inline">ArimaOps</span>
            <span className="hidden text-muted/40 sm:inline" aria-hidden="true">
              /
            </span>
            <button
              type="button"
              onClick={() => ui.openCto()}
              title="Switch, create or manage projects"
              className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 font-semibold text-ink transition-colors hover:bg-cream-2"
            >
              <span className="max-w-[200px] truncate text-[13px]">{snap.config.project.name}</span>
              <span className="rounded-full px-2 py-px text-[12px] font-medium" style={{ color: "var(--accent)", background: "color-mix(in srgb, var(--accent) 12%, transparent)" }}>
                {kind}
              </span>
              <Icon name="expand_more" size={16} className="text-muted" />
            </button>
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${online ? "bg-green" : "bg-amber"}`}
              title={online ? "HQ Online" : "Reconnecting"}
              aria-label={online ? "Connected" : "Reconnecting"}
            />
          </div>
        </div>
        {isViewer && <span className="chip shrink-0 text-[12px]">Viewer</span>}
        {!live && (
          <span className="chip shrink-0 text-[12px]" style={{ ["--c" as string]: "var(--accent)" }} title="Sample projects and agents running in your browser.">
            Demo
          </span>
        )}
      </div>

      {/* Center: Command Bar */}
      <div className="w-[min(360px,30vw)]">
        <CommandBar snap={snap} />
      </div>

      {/* Right: Telemetry & Operator Approval Queue */}
      <div className="flex items-center gap-3">
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
            className="deck-need flex cursor-pointer items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-bold transition-colors"
            title="Open the Operator Inbox"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-amber animate-pulse" />
            <span>
              {attention} Need{attention === 1 ? "s" : ""} You
            </span>
          </button>
        )}

        {setup > 0 && (
          <button
            type="button"
            onClick={() => ui.openSetup()}
            className="deck-pill flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold text-amber"
            title="Open the setup checklist"
          >
            <Icon name="checklist" size={16} />
            <span>Setup · {setup}</span>
          </button>
        )}

        {!isViewer && (
          <button
            type="button"
            onClick={() => ui.openSettings("project")}
            aria-label="Settings"
            title="Settings"
            className="cursor-pointer rounded-md p-1.5 text-muted transition-colors hover:bg-cream-2 hover:text-ink"
          >
            <Icon name="settings" size={18} />
          </button>
        )}
      </div>
    </header>
  );
}
