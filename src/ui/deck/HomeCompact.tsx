// Responsive compact Home view (< 1000px): live ParticleCore summary, StageStrip,
// Quick Intent bar, Waiting on You decisions, Team rows, and Today's Activity.
import { modeOf, type Mode } from "../../data/mode";
import { selectAttention, selectTeam, useOffice } from "../../store/office";
import { ui } from "../../store/ui";
import { useAgentUsage } from "../../store/usage";
import { ParticleCore } from "../hud/ParticleCore";
import { StageStrip } from "../hud/StageStrip";
import { fmtTokens, fmtUsd, Portrait, useNow } from "../kit";
import { projectTheme } from "../theme/projectTheme";
import { ActivityPanel, HomeIntentBar, NeedsYouPanel } from "./HomePanels";

const MODE_COLOR: Record<Mode, string> = {
  working: "#3b82f6",
  cheer: "#10b981",
  "needs-input": "#f59e0b",
  alert: "#ef4444",
  starting: "#818cf8",
  idle: "#8b9bb4",
  stopped: "#475569",
};

export function HomeCompact() {
  const snap = useOffice((s) => s.snap);
  const now = useNow(10_000);
  const usage = useAgentUsage(1);
  if (!snap) return null;

  const team = selectTeam(snap);
  const working = team.filter((a) => modeOf(a.status, now) === "working").length;
  const attention = selectAttention(snap).total;
  const inFlight = snap.tasks.filter(
    (t) => t.status === "in-progress" || t.status === "in-review" || t.status === "blocked",
  ).length;
  const strip = (snap.config.template?.flow.stages.length ?? 0) > 1;

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto" aria-label="Home">
      <section
        className="hud-void relative h-[156px] overflow-hidden border-b border-[var(--border-hairline)]"
        aria-label="Team summary"
      >
        <ParticleCore compact workingCount={working} attentionCount={attention} palette={projectTheme(snap).orb} />
        <div className="absolute inset-x-0 bottom-3 flex flex-wrap justify-center gap-1.5 px-3 text-[12px]">
          {[
            [team.length, team.length === 1 ? "agent" : "agents"],
            [working, "working"],
            [inFlight, inFlight === 1 ? "task in flight" : "tasks in flight"],
          ].map(([n, label]) => (
            <span key={String(label)} className="hud-glass rounded-full px-2.5 py-1 text-muted">
              <b className="font-semibold text-ink">{n}</b> {label}
            </span>
          ))}
        </div>
      </section>

      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-3 p-3.5 sm:p-4">
        {strip && (
          <div className="relative h-[52px]">
            <StageStrip compact snap={snap} />
          </div>
        )}

        <HomeIntentBar inline snap={snap} />
        <NeedsYouPanel inline snap={snap} onGoals={() => ui.openGoals()} />

        <section
          className="flex flex-col overflow-hidden rounded-xl border border-[var(--border-hairline)] bg-[var(--surface-card)] shadow-[var(--card-shadow)]"
          aria-label="Team"
        >
          <h2 className="m-0 flex items-center gap-2 px-4 pt-3.5 pb-1 text-[13px] font-semibold text-ink">
            Team <span className="text-[12px] font-normal text-muted">{team.length}</span>
          </h2>
          {team.length === 0 && (
            <p className="m-0 px-4 pb-3 text-[13px] text-muted">
              {snap.config.template ? "No agents yet. Add a team in Settings → Team." : "No agents in this project."}
            </p>
          )}
          <ul className="m-0 list-none p-0 pb-1">
            {team.map(({ config: a, status }) => {
              const mode = modeOf(status, now);
              const use = usage.byId.get(a.id);
              const task = status.currentTaskId ? snap.tasks.find((t) => t.id === status.currentTaskId) : undefined;
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => ui.openAgent(a.id)}
                    className="flex min-h-[56px] w-full cursor-pointer items-center gap-3 border-t border-[var(--border-hairline)] px-4 py-2.5 text-left first:border-t-0 hover:bg-cream-2"
                  >
                    <span className="relative shrink-0">
                      <Portrait name={a.name} color={a.color} lead={a.isLead} size={36} />
                      <i
                        className={`absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-2 border-[var(--surface-card)] ${
                          mode === "working" || mode === "needs-input" ? "animate-pulse" : ""
                        }`}
                        style={{ background: MODE_COLOR[mode] }}
                        aria-hidden="true"
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <b className="truncate text-[15px] font-semibold text-ink">{a.name}</b>
                        <span className="truncate text-[12px] text-muted">{a.role}</span>
                      </span>
                      <span className="block truncate text-[13px]">
                        {task ? (
                          <>
                            <span className="mr-1.5 text-accent">{task.id}</span>
                            <span className="text-ink">{task.title}</span>
                          </>
                        ) : (
                          <span className="text-muted">{status.note ?? "No task"}</span>
                        )}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-[13px] font-medium text-ink">
                        {fmtTokens(use ? usage.total(use) : 0)}
                      </span>
                      <span className="block text-[12px] text-muted">{fmtUsd(use?.costUsd ?? 0)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <ActivityPanel inline snap={snap} />
      </div>
    </div>
  );
}
