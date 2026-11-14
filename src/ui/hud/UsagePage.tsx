// The team's token use, ranked: today, 7 or 30 days. Totals across the top, one row per agent with its
// day shape, tokens, cost and share; a row opens that agent's Usage tab.

import { useState } from "react";
import { CLI_LABEL } from "../../data/types";
import { useOffice } from "../../store/office";
import { ui } from "../../store/ui";
import { useAgentUsage } from "../../store/usage";
import { fmtTokens, fmtUsd, Meter, Portrait, Sparkline, useCountUp } from "../kit";

const RANGES = [
  { days: 1, label: "Today" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
] as const;

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="hud-glass hud-corners hud-scan flex min-w-[150px] flex-1 flex-col gap-1 rounded-2xl px-4 py-3">
      <span className="text-[12px] text-muted">{label}</span>
      <span className={`font-display text-[28px] font-semibold leading-none ${accent ? "text-accent" : "text-ink"}`}>{value}</span>
    </div>
  );
}

export function UsagePage() {
  const snap = useOffice((s) => s.snap)!;
  const [days, setDays] = useState<number>(1);
  const usage = useAgentUsage(days);
  const team = usage.rows.reduce((sum, r) => sum + usage.total(r), 0);
  const cost = usage.rows.reduce((sum, r) => sum + r.costUsd, 0);
  const shownTeam = useCountUp(team);
  const top = usage.rows[0];
  const name = (id: string) => snap.config.team.find((a) => a.id === id)?.name ?? id;
  const range = RANGES.find((r) => r.days === days)!;

  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="m-0 font-display text-[22px] font-semibold">Usage</h1>
        <span className="text-[13px] text-muted">{snap.config.project.name} · tokens and estimated cost per agent</span>
        <span className="flex-1" />
        <div className="flex gap-1.5" role="group" aria-label="Range">
          {RANGES.map((r) => (
            <button key={r.days} className="btn px-2.5 text-[12px]" aria-pressed={days === r.days} onClick={() => setDays(r.days)}>
              {r.label}
            </button>
          ))}
        </div>
      </header>

      <div className="flex flex-wrap gap-3">
        <Stat label={`Team tokens · ${range.label.toLowerCase()}`} value={fmtTokens(shownTeam)} accent />
        <Stat label="Estimated cost" value={fmtUsd(cost)} />
        <Stat label="Busiest agent" value={top ? name(top.agentId) : "—"} />
        <Stat label="Agents with usage" value={`${usage.rows.length} / ${snap.config.team.length}`} />
      </div>

      <section className="hud-glass overflow-hidden rounded-2xl" aria-label="Leaderboard">
        <div className="grid grid-cols-[32px_minmax(160px,1.4fr)_minmax(100px,1fr)_90px_80px_minmax(90px,0.8fr)] items-center gap-3 border-b border-white/[0.08] px-4 py-2 text-[12px] text-muted max-[900px]:hidden">
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
              className="hud-scan grid w-full grid-cols-[32px_minmax(160px,1.4fr)_minmax(100px,1fr)_90px_80px_minmax(90px,0.8fr)] items-center gap-3 border-b border-white/[0.05] px-4 py-2.5 text-left transition-colors hover:bg-white/[0.03] max-[900px]:grid-cols-[28px_1fr_auto]"
              onClick={() => a && ui.openAgent(a.id, "usage")}
              title={`${fmtTokens(r.input)} fresh input · ${fmtTokens(r.cached)} from cache · ${fmtTokens(r.output)} output`}
            >
              <span className={`font-display text-[16px] font-semibold ${i === 0 ? "text-accent" : "text-muted"}`}>{i + 1}</span>
              <span className="flex min-w-0 items-center gap-2.5">
                {a && <Portrait name={a.name} color={a.color} lead={a.isLead} size={28} />}
                <span className="min-w-0">
                  <b className="block truncate text-[14px] font-semibold">{a?.name ?? r.agentId}</b>
                  <span className="block truncate text-[12px] text-muted">
                    {a ? `${a.role} · ${CLI_LABEL[a.cli] ?? a.cli}${a.model ? ` · ${a.model}` : ""}` : "Removed agent"}
                  </span>
                </span>
              </span>
              <span className="max-[900px]:hidden">
                <Sparkline data={r.series} width={140} height={26} color={a?.color ?? "#00f0ff"} label={`${a?.name ?? r.agentId} over ${range.label.toLowerCase()}`} />
              </span>
              <span className="text-right font-display text-[15px] font-semibold">{fmtTokens(n)}</span>
              <span className="text-right font-display text-[13px] text-muted max-[900px]:hidden">{fmtUsd(r.costUsd)}</span>
              <span className="flex flex-col gap-1 max-[900px]:hidden">
                <span className="text-[11px] text-muted">{team ? Math.round((n / team) * 100) : 0}%</span>
                <Meter value={n} max={usage.max} color={a?.color ?? "#00f0ff"} label={`${a?.name ?? r.agentId}'s share`} />
              </span>
            </button>
          );
        })}
      </section>
      <p className="m-0 text-[12px] text-muted">Costs are estimates from list prices; models without a price aren't counted. Click an agent for its breakdown.</p>
    </div>
  );
}
