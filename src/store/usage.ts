// Per-agent tokens and cost for the HUD: GET /api/projects/<id>/usage?days=N, polled while the page is visible.
// The demo has no HQ, so it shows each agent's own token count with a made-up (but steady) activity series.

import { useEffect, useState } from "react";
import type { Tokens } from "../data/types";
import { mulberry32 } from "../lib/random";
import { useOffice } from "./office";

export interface AgentUsage extends Tokens {
  agentId: string;
  costUsd: number;
  /** Tokens per slice of the window, oldest first (24 slices). */
  series: number[];
}

const total = (t: Tokens) => t.input + t.cached + t.output;

function token(): string {
  try {
    return sessionStorage.getItem("hq-token") ?? "";
  } catch {
    return "";
  }
}

/** Demo numbers: each agent's live token count spread over 24 slices by a seeded generator, rough cost at $3/M. */
function demoUsage(agents: { agentId: string; usage?: Tokens | null }[], days: number): AgentUsage[] {
  return agents
    .map((a) => {
      const rand = mulberry32([...a.agentId].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, days));
      // The demo's agents mostly report no tokens: give each a steady made-up day (40k–400k) so meters have something to show.
      const base = 40_000 + Math.floor(rand() * 360_000);
      const t = a.usage && total(a.usage) > 0 ? a.usage : { input: Math.round(base * 0.35), cached: Math.round(base * 0.55), output: Math.round(base * 0.1) };
      const weights = Array.from({ length: 24 }, (_, i) => rand() * (0.4 + i / 24));
      const sum = weights.reduce((x, y) => x + y, 0) || 1;
      const scale = total(t) * Math.min(days, 7);
      return { agentId: a.agentId, input: t.input * Math.min(days, 7), cached: t.cached * Math.min(days, 7), output: t.output * Math.min(days, 7), costUsd: (scale / 1e6) * 3, series: weights.map((w) => (w / sum) * scale) };
    })
    .sort((a, b) => total(b) - total(a));
}

/** Usage per agent over the last `days` (1, 7 or 30). `byId` for quick lookups; `max` to scale meters. */
export function useAgentUsage(days = 1) {
  const live = useOffice((s) => s.live);
  const projectId = useOffice((s) => s.snap?.config.project.id ?? "");
  const agents = useOffice((s) => s.snap?.agents);
  const [rows, setRows] = useState<AgentUsage[]>([]);

  useEffect(() => {
    if (!live || !projectId) return;
    let stop = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const tok = token();
        const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/usage?days=${days}${tok ? `&token=${encodeURIComponent(tok)}` : ""}`, { credentials: "same-origin" });
        if (r.ok && !stop) setRows(((await r.json()) as { agents: AgentUsage[] }).agents);
      } catch {
        /* offline: keep the last numbers */
      }
    };
    void tick();
    const t = window.setInterval(() => void tick(), 30_000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [live, projectId, days]);

  const list = live ? rows : demoUsage(agents ?? [], days);
  return { rows: list, byId: new Map(list.map((r) => [r.agentId, r])), max: Math.max(1, ...list.map(total)), total };
}
