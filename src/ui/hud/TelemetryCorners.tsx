import type { OfficeSnapshot } from "../../data/types";
import { signOut, useAuth } from "../../store/auth";
import { isViewer, officeActions, selectAttention } from "../../store/office";
import { ui } from "../../store/ui";
import { fmtTokens, fmtUsd, Logo, useCountUp } from "../kit";
import { useAgentUsage } from "../../store/usage";
import { TEAM_MODE_COLOR, TEAM_MODE_HINT, TEAM_MODE_LABEL, type TeamMode } from "./theme";

interface TelemetryProps {
  snap: OfficeSnapshot;
  mode: TeamMode;
  workingCount: number;
  activeTasks: number;
}


export function TopLeftBrand({
  snap,
  mode,
}: Pick<TelemetryProps, "snap" | "mode">) {
  return (
    <div className="pointer-events-auto flex shrink-0 items-center gap-2.5">
      <Logo size={24} />
      <div className="leading-tight">
        <button
          type="button"
          onClick={() => ui.openCto()}
          title="Switch, create, or manage projects"
          className="flex cursor-pointer items-center gap-1 text-[13px] font-semibold tracking-tight text-ink transition-colors hover:text-accent"
        >
          <span className="max-w-[160px] truncate">{snap.config.project.name}</span>
          <span className="text-[12px] text-muted">▾</span>
        </button>
        <div className="mt-0.5 flex items-center gap-2">
          <span
            className="flex items-center gap-1.5 text-[12px] text-muted"
            title={TEAM_MODE_HINT[mode]}
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: TEAM_MODE_COLOR[mode] }} />
            {TEAM_MODE_LABEL[mode]}
          </span>
          {isViewer && (
            <span className="rounded border border-white/15 bg-white/[0.06] px-1.5 py-0.2 text-[11px] text-muted">
              VIEWER
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function TopRightTelemetry({
  snap,
  workingCount,
  activeTasks,
}: Pick<TelemetryProps, "snap" | "workingCount" | "activeTasks">) {
  const auth = useAuth((s) => s.status);
  const attention = selectAttention(snap).total;
  const usage = useAgentUsage(1);
  const totalTokens = useCountUp(usage.rows.reduce((sum, a) => sum + usage.total(a), 0));
  const cost = usage.rows.reduce((sum, a) => sum + a.costUsd, 0);
  const setupIssues = snap.setup.checks.filter((c) => c.status !== "ok").length;
  const stoppedAgents = snap.agents.filter((a) => a.session.state === "stopped" || a.session.state === "failed");

  return (
    <div className="pointer-events-auto flex shrink-0 items-center gap-2">
      <div className="hidden items-center gap-2.5 rounded-full border border-accent/20 bg-navy/75 px-3.5 py-1.5 text-[12px] text-muted backdrop-blur-md xl:flex">
        <span>
          Working <strong className="font-display text-accent">{workingCount}</strong>
        </span>
        <span className="text-white/15">|</span>
        <span>
          Tasks <strong className="font-display text-ink">{activeTasks}</strong>
        </span>
        <span className="text-white/15">|</span>
        <span>
          <span title={`Estimated cost today: ${fmtUsd(cost)}`}>
            Today <strong className="font-display text-ink">{fmtTokens(totalTokens)}</strong> · <strong className="font-display text-ink">{fmtUsd(cost)}</strong>
          </span>
        </span>
      </div>

      {!isViewer && stoppedAgents.length > 0 && (
        <button
          type="button"
          onClick={() => stoppedAgents.forEach((a) => officeActions.startAgent(a.agentId))}
          className="cursor-pointer rounded-full border border-accent/35 bg-accent/12 px-3 py-1.5 text-[12px] font-medium text-accent transition-colors hover:bg-accent/22"
          title="Start all stopped agents"
        >
          Start team · {stoppedAgents.length}
        </button>
      )}

      {attention > 0 && (
        <button
          type="button"
          onClick={() => ui.openActions()}
          className="cursor-pointer rounded-full border border-amber/50 bg-amber/15 px-3 py-1.5 text-[12px] font-medium text-amber shadow-[0_0_16px_rgba(255,176,32,0.18)] transition-colors hover:bg-amber/25"
          title="Open the Inbox"
        >
          {attention} need{attention === 1 ? "s" : ""} you
        </button>
      )}

      {setupIssues > 0 && (
        <button
          type="button"
          onClick={() => ui.openSetup()}
          className="cursor-pointer rounded-full border border-amber/40 bg-amber/10 px-3 py-1.5 text-[12px] font-medium text-amber transition-colors hover:bg-amber/25"
          title="Open setup checklist"
        >
          Setup · {setupIssues} to do
        </button>
      )}

      {!isViewer && (
        <button
          type="button"
          onClick={() => ui.openSettings("project")}
          aria-label="Settings"
          title="Settings"
          className="grid h-8 w-8 cursor-pointer place-items-center rounded-full border border-white/10 bg-navy/75 text-muted backdrop-blur-md transition-colors hover:border-white/30 hover:text-white"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      )}

      {auth === "signed-in" && (
        <button
          type="button"
          onClick={() => void signOut()}
          title="Sign out"
          className="cursor-pointer rounded-full border border-white/10 bg-navy/75 px-3 py-1.5 text-[12px] text-muted backdrop-blur-md transition-colors hover:border-white/30 hover:text-white"
        >
          Sign out
        </button>
      )}
    </div>
  );
}
