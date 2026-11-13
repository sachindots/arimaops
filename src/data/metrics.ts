// SPDX-License-Identifier: AGPL-3.0-or-later
// Factory metrics as GET /api/projects/<id>/metrics returns them (server/metrics.ts, docs/factory.md section 3).

export interface Cost {
  /** Dollars where the model is priced (API keys); null when none of it was. */
  usd: number | null;
  /** Input plus output tokens: always known. */
  tokens: number;
}

export interface FactoryMetrics {
  finished: number;
  merged: number;
  /** Per finished task and per merged PR; null with nothing finished. */
  costPerTask: Cost | null;
  costPerPr: Cost | null;
  /** Medians in ms; `unknown` finished tasks had no history to measure. */
  cycle: { created: number | null; started: number | null; unknown: number };
  /** Failed gate events on the finished tasks, and per finished task. */
  rework: { failed: number; perTask: number | null };
  stalls: number;
  replans: number;
  interventions: { gates: number; answers: number; messages: number; total: number };
  /** Scorer verdicts on the finished tasks (section 4); `worst` is the scorer that failed most. */
  checks: { run: number; failed: number; worst: { scorer: string; failed: number } | null };
}

export interface VersionMetrics {
  templateId: string;
  version: number;
  finished: number;
  costPerTask: Cost | null;
  cycleCreated: number | null;
  reworkPerTask: number | null;
  /** Share of scorer verdicts that failed; null with none. */
  checkFailRate: number | null;
}

export interface MetricsReport {
  days: number;
  now: FactoryMetrics;
  before: FactoryMetrics;
  versions: VersionMetrics[];
  at: number;
}

