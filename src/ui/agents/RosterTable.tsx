// One roster for the Agents page and the Grid: a row per agent with who it is, what it runs on (a "free" tag for
// free models), its status, its task, and today's tokens and cost. Rows can be grouped by project (Grid, several
// projects) and carry their own actions (Agents page).
import type { ReactNode } from "react";
import { freeSourceOf } from "../../data/freeModels";
import type { Mode } from "../../data/mode";
import { CLI_LABEL } from "../../data/types";
import type { AgentUsage } from "../../store/usage";
import { fmtTokens, fmtUsd, Portrait, Sparkline } from "../kit";
import type { Row } from "../command/rank";

export const MODE_COLOR: Record<Mode, string> = {
  "needs-input": "var(--color-amber)",
  alert: "var(--color-red)",
  working: "var(--accent)",
  cheer: "#16a34a",
  starting: "#818cf8",
  idle: "var(--color-muted)",
  stopped: "var(--color-muted)",
};
export const MODE_LABEL: Record<Mode, string> = { "needs-input": "Needs you", alert: "Problem", working: "Working", cheer: "Done", starting: "Starting", idle: "Idle", stopped: "Stopped" };

export function RosterTable({
  rows,
  selected,
  onPick,
  usageOf,
  tokensOf,
  grouped = false,
  narrow = false,
  actions,
  keys = false,
}: {
  rows: Row[];
  selected?: string;
  onPick: (row: Row) => void;
  usageOf: (row: Row) => AgentUsage | undefined;
  tokensOf: (row: Row) => number;
  /** A heading per project (rows already in the order to show). */
  grouped?: boolean;
  /** Fewer columns, for a table that shares the width with a terminal. */
  narrow?: boolean;
  actions?: (row: Row) => ReactNode;
  /** Show the 1–9 focus keys. */
  keys?: boolean;
}) {
  const cols = narrow
    ? "minmax(170px,1.2fr) 110px minmax(0,1.6fr) 96px"
    : "minmax(150px,1.1fr) minmax(135px,1fr) 96px minmax(140px,1.8fr) 120px auto";
  const groups = grouped ? [...new Set(rows.map((r) => r.project))].map((p) => rows.filter((r) => r.project === p)) : [rows];
  return (
    <div role="table" aria-label="Agents" className={`text-[13px] ${narrow ? "min-w-[520px]" : "min-w-[820px]"}`}>
      <div role="row" className="grid items-center gap-3 border-b border-[var(--border-hairline)] px-3 pb-2 text-[12px] font-medium text-muted" style={{ gridTemplateColumns: cols }}>
        <span role="columnheader">Agent</span>
        {!narrow && <span role="columnheader">Runs on</span>}
        <span role="columnheader">Status</span>
        <span role="columnheader">Working on</span>
        <span role="columnheader" className="text-right">
          Today
        </span>
        {!narrow && <span role="columnheader" aria-label="Actions" />}
      </div>
      {groups.map((group) => (
        <div key={group[0]?.project ?? "none"} role="rowgroup">
          {grouped && group[0] && (
            <div className="px-3 pt-4 pb-1 text-[12px] font-semibold text-muted">
              {group[0].projectName}
              {group[0].current && <span className="font-normal"> · this project</span>}
            </div>
          )}
          {group.map((r, ri) => {
            const u = usageOf(r);
            const free = freeSourceOf(r.agent.model);
            const on = r.key === selected;
            const color = MODE_COLOR[r.mode];
            const urgent = r.mode === "needs-input" || r.mode === "alert";
            return (
              <div
                key={r.key}
                role="row"
                tabIndex={0}
                aria-selected={on || undefined}
                onClick={() => onPick(r)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onPick(r))}
                className={`rise-in grid cursor-pointer items-center gap-3 border-b border-[var(--border-hairline)] px-3 py-2.5 outline-none transition-colors focus-visible:bg-cream-2 ${on ? "bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]" : urgent ? "bg-amber/[0.06] hover:bg-amber/[0.1]" : "hover:bg-cream-2/70"}`}
                style={{ gridTemplateColumns: cols, ['--i' as string]: ri }}
              >
                <span role="cell" className="flex min-w-0 items-center gap-2.5">
                  <span className="relative shrink-0">
                    <Portrait name={r.agent.name} color={r.agent.color} lead={r.agent.isLead} size={32} />
                    <i className="absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--surface-card)]" style={{ background: color }} aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate font-semibold text-ink">{r.agent.name}</span>
                      {keys && rows.indexOf(r) < 9 && <kbd className="kbd shrink-0">{rows.indexOf(r) + 1}</kbd>}
                    </span>
                    <span className="block truncate text-[12px] text-muted">
                      {r.agent.role}
                      {narrow && ` · ${CLI_LABEL[r.agent.cli]}`}
                    </span>
                  </span>
                </span>
                {!narrow && (
                  <span role="cell" className="min-w-0">
                    <span className="block truncate text-ink">{CLI_LABEL[r.agent.cli]}</span>
                    <span className="flex items-center gap-1.5 text-[12px] text-muted">
                      <span className="truncate">{r.agent.model || "default model"}</span>
                      {free && <span className="shrink-0 rounded-full bg-green/15 px-1.5 text-[12px] text-green">free</span>}
                    </span>
                  </span>
                )}
                <span role="cell" className="flex items-center gap-1.5 text-[12px] font-medium" style={{ color }}>
                  <span className={`h-2 w-2 shrink-0 rounded-full ${r.mode === "working" || urgent ? "animate-pulse" : ""}`} style={{ background: color }} aria-hidden="true" />
                  {MODE_LABEL[r.mode]}
                </span>
                <span role="cell" className="min-w-0 truncate" title={r.task ? `${r.task.id} ${r.task.title}` : (r.status?.note ?? undefined)}>
                  {r.task ? (
                    <>
                      <span className="mr-1.5 text-[12px] font-medium text-accent">{r.task.id}</span>
                      <span className="text-ink">{r.task.title}</span>
                    </>
                  ) : (
                    <span className="text-muted">{r.status?.note ?? "No task"}</span>
                  )}
                </span>
                <span role="cell" className="flex items-center justify-end gap-2">
                  {u && !narrow && <Sparkline data={u.series} color={color} width={44} height={16} label={`${r.agent.name} today`} />}
                  <span className="text-right">
                    <span className="block font-medium text-ink">{fmtTokens(tokensOf(r))}</span>
                    {u && <span className="block text-[12px] text-muted">{fmtUsd(u.costUsd)}</span>}
                  </span>
                </span>
                {!narrow && (
                  <span role="cell" className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                    {actions?.(r)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
