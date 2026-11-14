// An agent's token use: today, 7 or 30 days. Totals and cost, the day's shape, where the tokens went
// (fresh input, cache reads, output) and which of its tasks used the most.

import { useState } from "react";
import type { AgentConfig, OfficeSnapshot } from "../../data/types";
import { useAgentUsage } from "../../store/usage";
import { fmtTokens, fmtUsd, Meter, Sparkline, useCountUp } from "../kit";

const RANGES = [
  { days: 1, label: "Today" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
] as const;

export function UsageTab({ snap, agent }: { snap: OfficeSnapshot; agent: AgentConfig }) {
  const [days, setDays] = useState<number>(1);
  const usage = useAgentUsage(days);
  const mine = usage.byId.get(agent.id);
  const tokens = mine ? usage.total(mine) : 0;
  const team = usage.rows.reduce((sum, r) => sum + usage.total(r), 0);
  const shown = useCountUp(tokens);
  const tasks = snap.tasks
    .filter((t) => t.ownerId === agent.id && t.usage)
    .map((t) => ({ t, n: t.usage!.input + t.usage!.cached + t.usage!.output }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 8);
  const range = RANGES.find((r) => r.days === days)!;
  const parts = [
    { label: "Fresh input", value: mine?.input ?? 0, color: "#00f0ff" },
    { label: "From cache", value: mine?.cached ?? 0, color: "#818cf8" },
    { label: "Output", value: mine?.output ?? 0, color: "#ffb020" },
  ];

  return (
    <div className="scroll-thin flex h-full flex-col gap-4 overflow-y-auto p-4">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Range">
        {RANGES.map((r) => (
          <button key={r.days} className="btn px-2.5 text-[12px]" aria-pressed={days === r.days} onClick={() => setDays(r.days)}>
            {r.label}
          </button>
        ))}
      </div>

      <section className="hud-glass hud-corners rounded-2xl p-4" aria-label="Totals">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
          <div>
            <div className="text-[12px] text-muted">Tokens · {range.label.toLowerCase()}</div>
            <div className="font-display text-[34px] font-semibold leading-none text-ink">{fmtTokens(shown)}</div>
          </div>
          <div>
            <div className="text-[12px] text-muted">Estimated cost</div>
            <div className="font-display text-[22px] font-semibold leading-none text-ink">{fmtUsd(mine?.costUsd ?? 0)}</div>
          </div>
          <div>
            <div className="text-[12px] text-muted">Share of the team</div>
            <div className="font-display text-[22px] font-semibold leading-none text-accent">{team ? Math.round((tokens / team) * 100) : 0}%</div>
          </div>
        </div>
        <div className="mt-4">
          <Sparkline data={mine?.series ?? []} width={560} height={64} label={`${agent.name}'s tokens over ${range.label.toLowerCase()}`} />
          <div className="mt-1 flex justify-between text-[11px] text-muted">
            <span>{days === 1 ? "24 h ago" : `${days} days ago`}</span>
            <span>now</span>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2.5" aria-label="Where the tokens went">
        <h3 className="m-0 text-[13px] font-semibold text-muted">Where the tokens went</h3>
        {parts.map((p) => (
          <div key={p.label} className="flex flex-col gap-1">
            <div className="flex justify-between text-[12px]">
              <span>{p.label}</span>
              <span className="font-display text-muted">{fmtTokens(p.value)}</span>
            </div>
            <Meter value={p.value} max={Math.max(1, tokens)} color={p.color} label={p.label} />
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-2" aria-label="Busiest tasks">
        <h3 className="m-0 text-[13px] font-semibold text-muted">Busiest tasks (all time)</h3>
        {tasks.length === 0 ? (
          <p className="m-0 text-[13px] text-muted">No tokens recorded against {agent.name}'s tasks yet.</p>
        ) : (
          tasks.map(({ t, n }) => (
            <div key={t.id} className="flex flex-col gap-1">
              <div className="flex items-baseline gap-2 text-[12px]">
                <span className="font-term text-muted">{t.id}</span>
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                <span className="font-display text-muted">{fmtTokens(n)}</span>
              </div>
              <Meter value={n} max={tasks[0].n} color="#00f0ff" label={`${t.id} tokens`} />
            </div>
          ))
        )}
      </section>

      <p className="m-0 text-[12px] text-muted">Costs are estimates from list prices; models without a price aren't counted.</p>
    </div>
  );
}
