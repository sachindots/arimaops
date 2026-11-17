// The team's token use over today, 7 or 30 days: four tiles (tokens, cost, share on free models, budget left), one
// stacked bar chart of tokens by agent over the range, role budgets, and the per-agent table (also the chart's table
// view); a row opens that agent's Usage tab.

import { useState } from "react";
import { CLI_LABEL } from "../../data/types";
import { useOffice } from "../../store/office";
import { ui } from "../../store/ui";
import { useAgentUsage, type AgentUsage } from "../../store/usage";
import { freeSourceOf } from "../../data/freeModels";
import { fmtTokens, fmtUsd, Meter, Portrait, Sparkline, useCountUp } from "../kit";

const RANGES = [
  { days: 1, label: "Today" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
] as const;

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex min-w-[170px] flex-1 flex-col gap-1.5 rounded-xl border border-[var(--border-hairline)] bg-[var(--surface-card)] px-4 py-3.5">
      <span className="text-[12px] text-muted">{label}</span>
      <span className="text-[28px] font-semibold leading-none tracking-tight text-ink">{value}</span>
      {sub && <span className="text-[12px] text-muted">{sub}</span>}
    </div>
  );
}

/** Tokens per time slice, one stacked segment per agent (its own colour, the same as its avatar). */
function StackedBars({ rows, agents, rangeLabel }: { rows: AgentUsage[]; agents: { id: string; name: string; color: string }[]; rangeLabel: string }) {
  const slices = Math.max(0, ...rows.map((r) => r.series.length));
  const totals = Array.from({ length: slices }, (_, i) => rows.reduce((t, r) => t + (r.series[i] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const who = (id: string) => agents.find((a) => a.id === id);
  if (!slices) return null;
  return (
    <figure className="m-0 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted" aria-label="Legend">
        {rows.map((r) => (
          <span key={r.agentId} className="flex items-center gap-1.5">
            <i className="h-2.5 w-2.5 rounded-sm" style={{ background: who(r.agentId)?.color ?? "#64748b" }} aria-hidden="true" />
            {who(r.agentId)?.name ?? r.agentId}
          </span>
        ))}
      </div>
      <div className="relative">
        <span className="absolute -top-1 left-0 text-[12px] text-muted">{fmtTokens(max)}</span>
        <div className="flex h-[180px] items-end gap-[3px] border-b border-[var(--border-hairline)] pt-5" role="img" aria-label={`Tokens by agent over ${rangeLabel}`}>
          {totals.map((t, i) => (
            <div
              key={i}
              className="group relative flex flex-1 flex-col-reverse gap-[2px]"
              style={{ height: `${(t / max) * 100}%` }}
            >
              {rows.map((r, k) => {
                const v = r.series[i] ?? 0;
                if (!v) return null;
                return (
                  <span
                    key={r.agentId}
                    className={`block min-h-[2px] w-full ${k === rows.length - 1 || rows.slice(k + 1).every((x) => !x.series[i]) ? "rounded-t-[4px]" : ""}`}
                    style={{ height: `${(v / t) * 100}%`, background: who(r.agentId)?.color ?? "#64748b" }}
                    title={`${who(r.agentId)?.name ?? r.agentId}: ${fmtTokens(v)}`}
                  />
                );
              })}
              <span className="pointer-events-none absolute -top-6 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-ink px-1.5 py-0.5 text-[12px] text-[var(--surface-card)] group-hover:block">
                {fmtTokens(t)}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-1 flex justify-between text-[12px] text-muted">
          <span>{rangeLabel === "today" ? "24 h ago" : `${rangeLabel} ago`}</span>
          <span>now</span>
        </div>
      </div>
    </figure>
  );
}

export function UsagePage() {
  const snap = useOffice((s) => s.snap)!;
  const [days, setDays] = useState<number>(1);
  const usage = useAgentUsage(days);
  const team = usage.rows.reduce((sum, r) => sum + usage.total(r), 0);
  const cost = usage.rows.reduce((sum, r) => sum + r.costUsd, 0);
  const shownTeam = useCountUp(team);
  const range = RANGES.find((r) => r.days === days)!;
  const onFree = usage.rows.filter((r) => freeSourceOf(snap.config.team.find((a) => a.id === r.agentId)?.model ?? "")).reduce((t, r) => t + usage.total(r), 0);
  const freeAgents = snap.config.team.filter((a) => freeSourceOf(a.model)).length;
  const day = snap.spend?.day;

  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="m-0 text-[20px] font-semibold tracking-tight text-ink">Usage</h1>
        <span className="text-[13px] text-muted">{snap.config.project.name} · tokens and estimated cost</span>
        <span className="flex-1" />
        <div className="flex gap-1" role="group" aria-label="Range">
          {RANGES.map((r) => (
            <button key={r.days} className="btn text-[13px]" aria-pressed={days === r.days} onClick={() => setDays(r.days)}>
              {r.label}
            </button>
          ))}
        </div>
      </header>

      <div className="flex flex-wrap gap-3">
        <Stat label={`Tokens · ${range.label.toLowerCase()}`} value={fmtTokens(shownTeam)} sub={`${usage.rows.length} of ${snap.config.team.length} agents used some`} />
        <Stat label="Estimated cost" value={fmtUsd(cost)} sub={snap.spend?.unpriced ? `${snap.spend.unpriced} events on unpriced models count as $0` : "List prices"} />
        <Stat label="On free models" value={`${team ? Math.round((onFree / team) * 100) : 0}%`} sub={`${freeAgents} agent${freeAgents === 1 ? "" : "s"} on a free model`} />
        <Stat
          label="Budget left today"
          value={day && day.cap > 0 ? fmtUsd(Math.max(0, day.cap - day.usd)) : "No cap"}
          sub={day && day.cap > 0 ? `${fmtUsd(day.usd)} of ${fmtUsd(day.cap)} spent` : "Set one in Settings → Project"}
        />
      </div>

      <section className="rounded-xl border border-[var(--border-hairline)] bg-[var(--surface-card)] px-5 py-4" aria-label="Tokens over time">
        <h2 className="m-0 mb-3 text-[15px] font-semibold text-ink">Tokens by agent</h2>
        {usage.rows.length ? (
          <StackedBars rows={usage.rows} agents={snap.config.team} rangeLabel={range.days === 1 ? "today" : range.label.toLowerCase()} />
        ) : (
          <p className="m-0 text-[13px] text-muted">No tokens used {days === 1 ? "today" : `in the last ${days} days`}.</p>
        )}
      </section>

      {(snap.spend?.roles?.length ?? 0) > 0 && (
        <section className="flex flex-col gap-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--surface-card)] px-5 py-4" aria-label="Role budgets today">
          <h2 className="m-0 text-[15px] font-semibold text-ink">
            Role budgets today <span className="font-normal text-muted">· API-key accounts; over budget, that role stops until midnight</span>
          </h2>
          {snap.spend!.roles!.map((r) => (
            <div key={r.roleId} className="grid grid-cols-[minmax(120px,1fr)_minmax(120px,2fr)_auto] items-center gap-3 text-[13px]">
              <span>{r.title}</span>
              <Meter value={r.usd} max={r.cap} color={r.paused ? "#ef4444" : r.usd >= r.cap * 0.8 ? "#f59e0b" : "var(--accent)"} label={`${r.title}: ${fmtUsd(r.usd)} of ${fmtUsd(r.cap)}`} />
              <span className={r.paused ? "text-red" : "text-muted"}>
                {fmtUsd(r.usd)} / {fmtUsd(r.cap)}
                {r.paused ? " · stopped" : ""}
              </span>
            </div>
          ))}
        </section>
      )}

      <section className="shrink-0 overflow-hidden rounded-xl border border-[var(--border-hairline)] bg-[var(--surface-card)]" aria-label="By agent">
        <div className="grid grid-cols-[32px_minmax(160px,1.4fr)_minmax(100px,1fr)_90px_80px_minmax(90px,0.8fr)] items-center gap-3 border-b border-[var(--border-hairline)] bg-cream-2/50 px-4 py-2 text-[12px] font-medium text-muted max-[900px]:hidden">
          <span>#</span>
          <span>Agent</span>
          <span>Over {range.label.toLowerCase()}</span>
          <span className="text-right">Tokens</span>
          <span className="text-right">Cost</span>
          <span>Share</span>
        </div>
        {usage.rows.length === 0 && <p className="m-0 px-4 py-6 text-center text-[13px] text-muted">No tokens used {days === 1 ? "today" : `in the last ${days} days`}.</p>}
        {usage.rows.map((r, i) => {
          const a = snap.config.team.find((x) => x.id === r.agentId);
          const n = usage.total(r);
          return (
            <button
              key={r.agentId}
              className="grid w-full cursor-pointer grid-cols-[32px_minmax(160px,1.4fr)_minmax(100px,1fr)_90px_80px_minmax(90px,0.8fr)] items-center gap-3 border-b border-[var(--border-hairline)] px-4 py-2.5 text-left transition-colors last:border-b-0 hover:bg-cream-2/60 max-[900px]:grid-cols-[28px_1fr_auto]"
              onClick={() => a && ui.openAgent(a.id, "usage")}
              title={`${fmtTokens(r.input)} fresh input · ${fmtTokens(r.cached)} from cache · ${fmtTokens(r.output)} output`}
            >
              <span className={`font-display text-[15px] font-semibold ${i === 0 ? "text-accent" : "text-muted"}`}>{i + 1}</span>
              <span className="flex min-w-0 items-center gap-2.5">
                {a && <Portrait name={a.name} color={a.color} lead={a.isLead} size={28} />}
                <span className="min-w-0">
                  <b className="block truncate text-[13px] font-semibold">{a?.name ?? r.agentId}</b>
                  <span className="block truncate text-[12px] text-muted">
                    {a ? `${a.role} · ${CLI_LABEL[a.cli] ?? a.cli}${a.model ? ` · ${a.model}` : ""}` : "Removed agent"}
                  </span>
                </span>
              </span>
              <span className="max-[900px]:hidden">
                <Sparkline data={r.series} width={140} height={26} color={a?.color ?? "#3b82f6"} label={`${a?.name ?? r.agentId} over ${range.label.toLowerCase()}`} />
              </span>
              <span className="text-right font-display text-[15px] font-semibold">{fmtTokens(n)}</span>
              <span className="text-right font-display text-[13px] text-muted max-[900px]:hidden">{fmtUsd(r.costUsd)}</span>
              <span className="flex flex-col gap-1 max-[900px]:hidden">
                <span className="text-[12px] text-muted">{team ? Math.round((n / team) * 100) : 0}%</span>
                <Meter value={n} max={usage.max} color={a?.color ?? "#3b82f6"} label={`${a?.name ?? r.agentId}'s share`} />
              </span>
            </button>
          );
        })}
      </section>
      <p className="m-0 text-[12px] text-muted">Costs are estimates from list prices; models without a price aren't counted. Click an agent for its breakdown.</p>
    </div>
  );
}
