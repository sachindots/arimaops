// SPDX-License-Identifier: AGPL-3.0-or-later
// Spend caps (docs/agent-engine.md section 8). Per project, on API-key accounts only (owner's decision: a
// subscription has no bill and its own limits): one alert at 80% of a cap, a pause at 100%. Paused, the
// project's workers are stopped and no worker starts and no HQ model run happens for it, until the period
// rolls over (local midnight, the 1st of the month) or the owner raises the cap. The lead stays up.
// Checked on every usage poll (30 s), so a runaway agent stops within about a minute of crossing the cap.

import type { DatabaseSync } from "node:sqlite";
import type { SpendState } from "../src/data/types";

export const DEFAULT_CAPS = { dailyUsd: 5, monthlyUsd: 50 };
export const ALERT_AT = 0.8;

const paused = new Map<string, "day" | "month">();

/** Why this project is paused for spend ("day" / "month"), or null. Read by session starts and model runs. */
export const spendPaused = (projectId: string) => paused.get(projectId) ?? null;

const pad = (n: number) => String(n).padStart(2, "0");

/** Local start of today and of this month, with keys naming each period. */
export function periods(now: Date) {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const month = new Date(now.getFullYear(), now.getMonth(), 1);
  const ym = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  return { day: day.getTime(), month: month.getTime(), dayKey: `${ym}-${pad(now.getDate())}`, monthKey: ym };
}

/** Estimated USD on these accounts since `since` (ms). */
export function keyedSpend(db: DatabaseSync, projectId: string, accounts: string[], since: number): { usd: number; unpriced: number } {
  if (!accounts.length) return { usd: 0, unpriced: 0 };
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) - COUNT(cost_usd) AS unpriced FROM usage_events
       WHERE project_id = ? AND at >= ? AND account IN (SELECT value FROM json_each(?))`,
    )
    .get(projectId, since, JSON.stringify(accounts)) as { usd: number; unpriced: number };
  return { usd: r.usd, unpriced: r.unpriced };
}

export function spendState(db: DatabaseSync, projectId: string, caps: { dailyUsd: number; monthlyUsd: number }, accounts: string[], now: Date): SpendState {
  const p = periods(now);
  const day = keyedSpend(db, projectId, accounts, p.day);
  const month = keyedSpend(db, projectId, accounts, p.month);
  const over = month.usd >= caps.monthlyUsd ? "month" : day.usd >= caps.dailyUsd ? "day" : null;
  return { day: { usd: day.usd, cap: caps.dailyUsd }, month: { usd: month.usd, cap: caps.monthlyUsd }, paused: over, unpriced: month.unpriced };
}

export interface SpendHooks {
  /** Stops the project's running workers (never the lead). */
  stopWorkers(): Promise<void>;
  tellLead(text: string): void;
  /** Files an Action item (and so a push) once per id. */
  alert(id: string, title: string, details: string): void;
  changed(state: SpendState): void;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

export class SpendGuard {
  private last = "";

  constructor(
    private projectId: string,
    private db: DatabaseSync,
    private caps: () => { dailyUsd: number; monthlyUsd: number },
    /** The API-key accounts: the only ones counted. */
    private keyed: () => string[],
    private hooks: SpendHooks,
  ) {}

  async check(now = new Date()): Promise<SpendState> {
    const s = spendState(this.db, this.projectId, this.caps(), this.keyed(), now);
    const p = periods(now);
    const was = spendPaused(this.projectId);
    if (s.paused) {
      paused.set(this.projectId, s.paused);
      const which = s.paused === "day" ? s.day : s.month;
      const until = s.paused === "day" ? "midnight" : "the 1st of next month";
      if (was !== s.paused)
        this.hooks.tellLead(`HQ paused this project: API-key spend reached the ${s.paused === "day" ? "daily" : "monthly"} cap (${usd(which.usd)} of ${usd(which.cap)}). Workers are stopped until ${until} or until the owner raises the cap. Don't assign work meanwhile.`);
      // Every check (filed once per id): a pause found before Action items are loaded still gets its item.
      this.hooks.alert(
        `spend-pause-${s.paused === "day" ? p.dayKey : p.monthKey}`,
        `Paused: the ${s.paused === "day" ? "daily" : "monthly"} spend cap is reached (${usd(which.usd)} of ${usd(which.cap)})`,
        `Workers are stopped and none starts until ${until}. The lead stays up.\n\nRaise the cap to go on now, or let it resume ${s.paused === "day" ? "tomorrow" : "next month"}.`,
      );
      await this.hooks.stopWorkers(); // every check: nothing slips back in while paused
    } else {
      paused.delete(this.projectId);
      if (was) this.hooks.tellLead("The spend pause is over (new period or a raised cap): workers may start again.");
    }
    for (const [name, x, key] of [["daily", s.day, p.dayKey], ["monthly", s.month, p.monthKey]] as const)
      if (x.cap > 0 && x.usd >= ALERT_AT * x.cap && x.usd < x.cap)
        this.hooks.alert(`spend-80-${key}`, `${Math.round((x.usd / x.cap) * 100)}% of the ${name} spend cap used (${usd(x.usd)} of ${usd(x.cap)})`, `At 100% HQ stops this project's workers until the period ends. Raise the cap in Settings → Project if the work needs more.`);
    const json = JSON.stringify(s);
    if (json !== this.last) {
      this.last = json;
      this.hooks.changed(s);
    }
    return s;
  }
}

/** Caps from the project config, falling back to the defaults for anything not a positive number. */
export function capsOf(raw: { dailyUsd?: unknown; monthlyUsd?: unknown } | undefined) {
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
  return { dailyUsd: n(raw?.dailyUsd, DEFAULT_CAPS.dailyUsd), monthlyUsd: n(raw?.monthlyUsd, DEFAULT_CAPS.monthlyUsd) };
}
