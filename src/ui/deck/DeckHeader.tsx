import type { OfficeSnapshot } from "../../data/types";
import { isViewer, selectAttention, setupToDo, useOffice } from "../../store/office";
import { ui } from "../../store/ui";
import { useAgentUsage } from "../../store/usage";
import { CommandBar } from "../hud/CommandBar";
import { fmtTokens, fmtUsd, Logo, useCountUp } from "../kit";
import type { Theme } from "../theme/projectTheme";
import { DECK } from "./frame";
import { Icon } from "./Icon";

/**
 * The deck's top bar: brand and project switcher with the project's type, the ⌘K command bar in the middle, and on
 * the right what's running, today's burn, what needs you (opens the Inbox), Setup while something is left, Settings.
 */
export function DeckHeader({ snap, theme, workingCount, activeTasks }: { snap: OfficeSnapshot; theme: Theme; workingCount: number; activeTasks: number }) {
  const live = useOffice((s) => s.live);
  const connection = useOffice((s) => s.connection);
  const attention = selectAttention(snap).total;
  const setup = setupToDo(snap);
  const usage = useAgentUsage(1);
  const tokens = useCountUp(usage.rows.reduce((sum, a) => sum + usage.total(a), 0));
  const cost = usage.rows.reduce((sum, a) => sum + a.costUsd, 0);
  const online = !live || connection === "open";

  return (
    <header
      className="deck-bar fixed inset-x-0 top-0 z-30 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 border-b px-4"
      style={{ height: DECK.header }}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <Logo size={26} />
        <span className="hidden text-[14px] font-semibold tracking-tight lg:inline">ArimaOps</span>
        <span className="hidden text-white/20 lg:inline" aria-hidden="true">
          /
        </span>
        <button
          type="button"
          onClick={() => ui.openCto()}
          title="Switch, create or manage projects, and see all of them at once"
          className="deck-pill flex min-w-0 items-center gap-2 rounded-full px-3 py-1.5 text-[13px] font-semibold"
        >
          <span className={`h-2 w-2 shrink-0 rounded-full ${online ? "bg-green" : "bg-amber"}`} aria-label={online ? "Connected" : "Reconnecting"} />
          <span className="max-w-[180px] truncate">{snap.config.project.name}</span>
          <Icon name="expand_more" size={18} className="text-muted" />
        </button>
        <span className="chip shrink-0 text-[12px]" style={{ ["--c" as string]: "var(--accent)" }} title={`${theme.label} project: ${theme.pipeline}`}>
          {theme.label}
        </span>
        {isViewer && <span className="chip shrink-0 text-[11px]">Viewer</span>}
        {!live && (
          <span className="chip shrink-0 text-[11px]" style={{ ["--c" as string]: "var(--accent)" }} title="Sample projects and agents, running in your browser. Run npx arimaops in a git repo for your own team.">
            Demo
          </span>
        )}
      </div>

      <div className="w-[min(440px,36vw)]">
        <CommandBar snap={snap} />
      </div>

      <div className="flex min-w-0 items-center justify-end gap-2">
        <div className="deck-pill hidden items-center gap-3 rounded-full px-3.5 py-1.5 text-[12px] text-muted xl:flex">
          <span>
            <b className="font-display text-[14px] text-accent">{workingCount}</b> working
          </span>
          <span>
            <b className="font-display text-[14px] text-ink">{activeTasks}</b> in flight
          </span>
          <span title={`Estimated cost today: ${fmtUsd(cost)}`}>
            <b className="font-display text-[14px] text-ink">{fmtTokens(tokens)}</b> · <b className="font-display text-[14px] text-ink">{fmtUsd(cost)}</b> today
          </span>
        </div>
        {attention > 0 && (
          <button type="button" onClick={() => ui.openActions()} className="deck-need flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold" title="Open the Inbox">
            <Icon name="notifications_active" size={16} />
            {attention} need{attention === 1 ? "s" : ""} you
          </button>
        )}
        {setup > 0 && (
          <button type="button" onClick={() => ui.openSetup()} className="deck-pill flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] text-amber" title="Open the setup checklist">
            <Icon name="checklist" size={16} />
            Setup · {setup}
          </button>
        )}
        {!isViewer && (
          <button type="button" onClick={() => ui.openSettings("project")} aria-label="Settings" title="Settings" className="deck-icon-btn grid h-9 w-9 place-items-center rounded-full">
            <Icon name="settings" size={19} />
          </button>
        )}
      </div>
    </header>
  );
}
