import type { OfficeSnapshot } from "../../data/types";
import { isViewer, officeActions, selectAttention, setupToDo, useOffice } from "../../store/office";
import { ui, useUi } from "../../store/ui";
import { useAgentUsage } from "../../store/usage";
import { CommandBar } from "../hud/CommandBar";
import { fmtUsd, Logo } from "../kit";
import type { Theme } from "../theme/projectTheme";
import { DECK } from "./frame";
import { Icon } from "./Icon";

/**
 * Top header matching the Spatial Multi-Agent Command Deck specification:
 * Left: AO badge + ArimaOps / Project switcher + online dot.
 * Center: Domain Toggle Pill (Software & Marketing vs Cybersecurity Red-Team) + ⌘K Command Bar.
 * Right: Working count · Burn + Need You pill + Settings gear.
 */
export function DeckHeader({ snap, theme, workingCount, activeTasks }: { snap: OfficeSnapshot; theme: Theme; workingCount: number; activeTasks: number }) {
  const live = useOffice((s) => s.live);
  const connection = useOffice((s) => s.connection);
  const scheme = useUi((s) => s.scheme);
  const attention = selectAttention(snap).total;
  const setup = setupToDo(snap);
  const usage = useAgentUsage(1);
  const cost = usage.rows.reduce((sum, a) => sum + a.costUsd, 0);
  const online = !live || connection === "open";
  const isCyber = theme.security || scheme === "dark";
  const findingsCount = (snap.findings ?? []).filter((f) => f.status === "open" || f.status === "confirmed").length;

  const selectDomain = (domain: "software" | "cybersec") => {
    if (domain === "cybersec") {
      ui.setScheme("dark", false);
      if (!live && snap.config.project.id !== "redcell-ops") officeActions.loadPreset("red-cell");
    } else {
      ui.setScheme("light", false);
      if (!live && snap.config.project.id === "redcell-ops") officeActions.loadPreset("askwell");
    }
  };

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
              className="flex cursor-pointer items-center gap-1 rounded bg-cream-2 px-2 py-0.5 text-[12px] font-semibold text-ink transition-colors hover:bg-cream-3"
            >
              <span className="max-w-[180px] truncate">{snap.config.project.name}</span>
              <Icon name="expand_more" size={14} className="text-muted" />
            </button>
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${online ? "bg-green" : "bg-amber"}`}
              title={online ? "HQ Online" : "Reconnecting"}
              aria-label={online ? "Connected" : "Reconnecting"}
            />
          </div>
        </div>
        {isViewer && <span className="chip shrink-0 text-[11px]">Viewer</span>}
        {!live && (
          <span className="chip shrink-0 text-[11px]" style={{ ["--c" as string]: "var(--accent)" }} title="Sample projects and agents running in your browser.">
            Demo
          </span>
        )}
      </div>

      {/* Center: Domain Toggle Pill + Command Bar */}
      <div className="flex items-center gap-2.5">
        <div className="hidden items-center gap-1 rounded-full border border-[var(--border-hairline)] bg-cream-2 p-1 shadow-inner lg:flex">
          <button
            type="button"
            onClick={() => selectDomain("software")}
            className={`flex cursor-pointer items-center gap-2 rounded-full px-3.5 py-1 text-[12px] font-semibold transition-all ${
              !isCyber ? "bg-cream text-ink shadow-xs" : "text-muted hover:text-ink"
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${!isCyber ? "bg-cyan-500" : "bg-slate-400"}`} />
            <span>Software &amp; Marketing</span>
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                !isCyber ? "bg-cyan-50 text-cyan-700" : "bg-cream-3 text-muted"
              }`}
            >
              {workingCount || activeTasks || 3} Active
            </span>
          </button>

          <button
            type="button"
            onClick={() => selectDomain("cybersec")}
            className={`flex cursor-pointer items-center gap-2 rounded-full px-3.5 py-1 text-[12px] font-semibold transition-all ${
              isCyber ? "bg-red-600 text-white shadow-sm" : "text-muted hover:text-red-600"
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${isCyber ? "bg-white" : "bg-slate-400"}`} />
            <span>Cybersecurity Red-Team</span>
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                isCyber ? "bg-red-800 text-white" : "bg-cream-3 text-muted"
              }`}
            >
              {findingsCount || 1} Alert{findingsCount === 1 || !findingsCount ? "" : "s"}
            </span>
          </button>
        </div>

        <div className="w-[min(220px,22vw)]">
          <CommandBar snap={snap} />
        </div>
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
