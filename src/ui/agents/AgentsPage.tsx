// The desktop Agents page: this project's team as one roster (team order, lead first). A row opens the agent's panel;
// Terminal, Chat and Start/Stop sit at the end of each row.
import { isViewer, officeActions, useOffice } from "../../store/office";
import { ui } from "../../store/ui";
import { useAgentUsage } from "../../store/usage";
import { rowsOf } from "../command/rank";
import { Icon } from "../deck/Icon";
import { useNow } from "../kit";
import { RosterTable } from "./RosterTable";

export function AgentsPage() {
  const snap = useOffice((s) => s.snap)!;
  const now = useNow(10_000);
  const usage = useAgentUsage(1);
  const rows = rowsOf(snap.config.project.id, snap.config.project.name, true, snap, now).sort((a, b) => Number(b.agent.isLead) - Number(a.agent.isLead));
  const stopped = rows.filter((r) => r.status?.session.state === "stopped" || r.status?.session.state === "failed");
  const working = rows.filter((r) => r.mode === "working").length;
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 py-5">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="m-0 text-[20px] font-semibold tracking-tight text-ink">Agents</h1>
        <span className="text-[13px] text-muted">
          {rows.length} in {snap.config.project.name} · {working} working
        </span>
        <span className="flex-1" />
        {!isViewer && stopped.length > 0 && (
          <button className="btn btn-primary text-[13px]" onClick={() => stopped.forEach((r) => officeActions.startAgent(r.agent.id))}>
            <Icon name="play_arrow" size={16} /> Start {stopped.length === rows.length ? "the team" : `${stopped.length} stopped`}
          </button>
        )}
        {!isViewer && (
          <button className="btn text-[13px]" onClick={() => ui.openSettings("team")}>
            <Icon name="tune" size={16} /> Team settings
          </button>
        )}
      </header>
      <RosterTable
        rows={rows}
        onPick={(r) => ui.openAgent(r.agent.id)}
        usageOf={(r) => usage.byId.get(r.agent.id)}
        tokensOf={(r) => {
          const u = usage.byId.get(r.agent.id);
          return u ? usage.total(u) : 0;
        }}
        actions={(r) => {
          const running = r.status?.session.state === "running";
          const starting = r.status?.session.state === "starting";
          return (
            <>
              <button className="btn px-2 text-[12px]" onClick={() => ui.openAgent(r.agent.id, "terminal")} aria-label={`${r.agent.name}'s terminal`} title="Terminal">
                <Icon name="terminal" size={16} />
              </button>
              <button className="btn px-2 text-[12px]" onClick={() => ui.openAgent(r.agent.id, "messages")} aria-label={`Chat with ${r.agent.name}`} title="Chat">
                <Icon name="chat" size={16} />
              </button>
              {!isViewer && (
                <button
                  className={`btn px-2.5 text-[12px] ${running ? "text-red" : "text-accent"}`}
                  disabled={starting}
                  onClick={() => (running ? officeActions.stopAgent(r.agent.id) : officeActions.startAgent(r.agent.id))}
                >
                  {running ? "Stop" : starting ? "Starting…" : "Start"}
                </button>
              )}
            </>
          );
        }}
      />
    </div>
  );
}
