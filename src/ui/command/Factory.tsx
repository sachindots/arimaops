// Factory Metrics, Native Scorers, Nightly Improvement Proposals & Replay Benchmark Harness (M5.1).
// Exposes both the full FactoryPage workspace (from Ops -> Factory & Benchmarks) and compact FactoryCard (CommandView).

import { useCallback, useEffect, useState } from "react";
import { isViewer, useOffice } from "../../store/office";
import { ui } from "../../store/ui";
import { readPref, writePref } from "../../lib/prefs";
import { Icon } from "../deck/Icon";
import { DrawerHeader, PageTitle } from "../drawers/Drawer";
import { Select } from "../primitives/Select";

export interface FactoryPeriodMetrics {
  completedTasks: number;
  avgScore: number;
  passRate: number;
  totalCostUsd: number;
  avgCycleMins: number;
}

export interface TaskScoreRecord {
  id: string;
  taskId: string;
  score: number;
  passed: boolean;
  rubric?: string;
  summary: string;
  scorerKind?: string;
  createdAt: string;
}

export interface ImprovementProposal {
  id: string;
  projectId: string;
  title: string;
  rationale: string;
  category: string;
  diffHint: string;
  status: "open" | "accepted" | "dismissed";
  createdAt: string;
}

export interface BenchmarkCaseResult {
  id: string;
  prompt: string;
  passed: boolean;
  score: number;
  latencyMs: number;
}

export interface BenchmarkRun {
  id: string;
  name: string;
  passRate: number;
  avgScore: number;
  avgLatencyMs: number;
  cases: BenchmarkCaseResult[];
  createdAt: string;
}

export interface FactoryMetricsPayload {
  days: number;
  current: FactoryPeriodMetrics;
  previous: FactoryPeriodMetrics;
  scores: TaskScoreRecord[];
  proposals: ImprovementProposal[];
  benchmarks: BenchmarkRun[];
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  let tok = "";
  try {
    tok = sessionStorage.getItem("hq-token") ?? "";
  } catch {
    /* ignore */
  }
  return { ...(extra ?? {}), ...(tok ? { Authorization: `Bearer ${tok}` } : {}) };
}

async function readApiJson<T>(res: Response): Promise<T> {
  const txt = await res.text();
  let data: unknown = {};
  try {
    data = txt ? JSON.parse(txt) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    const msg =
      typeof data === "object" && data !== null && "error" in data && typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

const DEFAULT_BENCHMARK_CASES = [
  {
    id: "case-auth-rbac",
    prompt: "Verify viewer role cannot execute destructive API mutations and audit log records denial.",
    expectedKeywords: ["viewer", "403", "audit"],
  },
  {
    id: "case-preview-iso",
    prompt: "Confirm isolated preview proxy rejects hq_sid cookies and injects origin-locked ArimaBridge.",
    expectedKeywords: ["arima_preview_sid", "401", "origin"],
  },
  {
    id: "case-fts5-memory",
    prompt: "Search certified team memory with punctuation queries without FTS5 syntax errors.",
    expectedKeywords: ["fts5", "certified", "sanitize"],
  },
];

function initialMockFactory(projectId: string): FactoryMetricsPayload {
  const now = Date.now();
  const iso = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();
  return {
    days: 14,
    current: {
      completedTasks: 18,
      avgScore: 91.4,
      passRate: 0.94,
      totalCostUsd: 14.8,
      avgCycleMins: 34,
    },
    previous: {
      completedTasks: 14,
      avgScore: 86.2,
      passRate: 0.85,
      totalCostUsd: 19.4,
      avgCycleMins: 48,
    },
    scores: [
      {
        id: "sc-1",
        taskId: "P0-T01",
        score: 96,
        passed: true,
        rubric: "Tests + CI green, zero regressions, clean PR diff",
        summary: "All unit checks passed and diff stayed scoped to target modules.",
        scorerKind: "rubric",
        createdAt: iso(95),
      },
      {
        id: "sc-2",
        taskId: "P3-T01",
        score: 88,
        passed: true,
        rubric: "Streaming upload chunk bounds & table preservation",
        summary: "Handles 25 MB streamed uploads; minor retry hint noted for slow connections.",
        scorerKind: "rubric",
        createdAt: iso(240),
      },
    ],
    proposals: [
      {
        id: "prop-1",
        projectId,
        title: "Add automatic schema typecheck pre-hook before PR creation",
        rationale: "3 of the last 4 CI rework cycles came from stale generated types caught only after push.",
        category: "workflow",
        diffHint: "flow.stages[build].gates += { kind: 'tests-ci', prePush: 'pnpm build' }",
        status: "open",
        createdAt: iso(360),
      },
      {
        id: "prop-2",
        projectId,
        title: "Route low-risk docs tasks to fast flash model tier",
        rationale: "Reduces median task spend by 31% with zero pass-rate degradation across 14-day window.",
        category: "cost",
        diffHint: "roles.docs.model = 'gemini-3-flash'",
        status: "open",
        createdAt: iso(720),
      },
    ],
    benchmarks: [
      {
        id: "bm-1",
        name: "Core Security & Orchestration Replay",
        passRate: 1.0,
        avgScore: 94.7,
        avgLatencyMs: 142,
        cases: [
          { id: "case-auth-rbac", prompt: DEFAULT_BENCHMARK_CASES[0].prompt, passed: true, score: 96, latencyMs: 128 },
          { id: "case-preview-iso", prompt: DEFAULT_BENCHMARK_CASES[1].prompt, passed: true, score: 95, latencyMs: 154 },
          { id: "case-fts5-memory", prompt: DEFAULT_BENCHMARK_CASES[2].prompt, passed: true, score: 93, latencyMs: 144 },
        ],
        createdAt: iso(180),
      },
    ],
  };
}

function pctLabel(rate: number): string {
  const normalized = rate <= 1 ? rate * 100 : rate;
  return `${Math.round(normalized)}%`;
}

function DeltaPill({
  current,
  previous,
  higherIsBetter = true,
}: {
  current: number;
  previous: number;
  higherIsBetter?: boolean;
}) {
  if (!previous) return null;
  const pct = Math.round(((current - previous) / Math.abs(previous)) * 100);
  if (pct === 0) return <span className="text-[12px] text-muted">0%</span>;
  const improved = higherIsBetter ? pct > 0 : pct < 0;
  return (
    <span
      className="font-term text-[12px] font-semibold"
      style={{ color: improved ? "var(--color-green)" : "var(--color-amber)" }}
    >
      {pct > 0 ? "▲" : "▼"} {Math.abs(pct)}%
    </span>
  );
}

function MetricBox({
  label,
  value,
  sub,
  current,
  previous,
  higherIsBetter = true,
}: {
  label: string;
  value: string;
  sub: string;
  current: number;
  previous: number;
  higherIsBetter?: boolean;
}) {
  return (
    <div className="panel flex min-w-[155px] flex-1 flex-col gap-1 p-3.5">
      <span className="text-[12px] font-medium text-muted">{label}</span>
      <div className="flex items-baseline gap-2">
        <span className="font-display text-[20px] font-semibold leading-none text-ink">{value}</span>
        <DeltaPill current={current} previous={previous} higherIsBetter={higherIsBetter} />
      </div>
      <span className="text-[12px] text-muted">{sub}</span>
    </div>
  );
}

/** Full Factory Metrics, Native Scorers, Nightly Improvement Proposals & Replay Benchmark Harness workspace. */
export function FactoryPage() {
  const snap = useOffice((s) => s.snap);
  const live = useOffice((s) => s.live);
  const projectId = snap?.config.project.id ?? "";
  const tasks = snap?.tasks ?? [];

  const [data, setData] = useState<FactoryMetricsPayload>(() => initialMockFactory(projectId || "demo"));
  const [selectedTaskId, setSelectedTaskId] = useState<string>(tasks[0]?.id ?? "P3-T01");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (tasks.length > 0 && !tasks.some((t) => t.id === selectedTaskId)) {
      setSelectedTaskId(tasks[0].id);
    }
  }, [tasks, selectedTaskId]);

  const loadLiveMetrics = useCallback(async () => {
    if (!live || !projectId) return;
    setError(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/factory/metrics?days=14`, {
        credentials: "same-origin",
        headers: authHeaders(),
      });
      const payload = await readApiJson<FactoryMetricsPayload>(res);
      setData(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [live, projectId]);

  useEffect(() => {
    if (live && projectId) void loadLiveMetrics();
  }, [live, projectId, loadLiveMetrics]);

  if (!snap) return null;

  const handleScoreTask = async () => {
    const tid = selectedTaskId || tasks[0]?.id || "P3-T01";
    setBusy("score");
    setError(null);
    setNotice(null);
    try {
      if (live && projectId) {
        const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/factory/score`, {
          method: "POST",
          credentials: "same-origin",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ taskId: tid, useLlm: true }),
        });
        const body = await readApiJson<{ score: TaskScoreRecord }>(res);
        setData((prev) => ({
          ...prev,
          scores: [body.score, ...prev.scores.filter((s) => s.id !== body.score.id)],
        }));
        setNotice(`Scored ${tid}: ${body.score.score}/100 (${body.score.passed ? "passed" : "needs work"}).`);
        await loadLiveMetrics();
      } else {
        const score: TaskScoreRecord = {
          id: `sc-${Date.now()}`,
          taskId: tid,
          score: 93,
          passed: true,
          rubric: "Automated rubric + diff hygiene check",
          summary: `Verified ${tid} acceptance criteria, zero regressions, and clean build output.`,
          scorerKind: "deterministic-rubric",
          createdAt: new Date().toISOString(),
        };
        setData((prev) => ({
          ...prev,
          scores: [score, ...prev.scores],
          current: {
            ...prev.current,
            avgScore: Number(((prev.current.avgScore * 4 + score.score) / 5).toFixed(1)),
          },
        }));
        setNotice(`Scored ${tid}: ${score.score}/100 (passed).`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleRunProposals = async () => {
    setBusy("proposals");
    setError(null);
    setNotice(null);
    try {
      if (live && projectId) {
        await readApiJson(
          await fetch(`/api/projects/${encodeURIComponent(projectId)}/factory/proposals/run`, {
            method: "POST",
            credentials: "same-origin",
            headers: authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({}),
          }),
        );
        await loadLiveMetrics();
        setNotice("Nightly analysis completed and generated improvement proposals.");
      } else {
        const nextId = `prop-${Date.now()}`;
        const fresh: ImprovementProposal = {
          id: nextId,
          projectId,
          title: "Cache preview build artifacts between verifier runs",
          rationale: "Saves ~4.5 min average cycle time on UI pull requests with repeated verification passes.",
          category: "velocity",
          diffHint: "verifier.cacheBuildArtifacts = true",
          status: "open",
          createdAt: new Date().toISOString(),
        };
        setData((prev) => ({ ...prev, proposals: [fresh, ...prev.proposals] }));
        setNotice("Nightly analysis generated 1 new improvement proposal.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleDecideProposal = async (proposal: ImprovementProposal, decision: "accept" | "dismiss") => {
    setBusy(`decide:${proposal.id}`);
    setError(null);
    setNotice(null);
    try {
      const nextStatus: ImprovementProposal["status"] = decision === "accept" ? "accepted" : "dismissed";
      if (live && projectId) {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/factory/proposals/${encodeURIComponent(proposal.id)}/decide`,
          {
            method: "POST",
            credentials: "same-origin",
            headers: authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ decision }),
          },
        );
        const body = await readApiJson<{ proposal?: ImprovementProposal }>(res);
        setData((prev) => ({
          ...prev,
          proposals: prev.proposals.map((p) => (p.id === proposal.id ? body.proposal ?? { ...p, status: nextStatus } : p)),
        }));
      } else {
        setData((prev) => ({
          ...prev,
          proposals: prev.proposals.map((p) => (p.id === proposal.id ? { ...p, status: nextStatus } : p)),
        }));
      }
      setNotice(`Proposal "${proposal.title}" ${nextStatus}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleRunBenchmark = async () => {
    setBusy("benchmark");
    setError(null);
    setNotice(null);
    try {
      if (live && projectId) {
        const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/factory/benchmark`, {
          method: "POST",
          credentials: "same-origin",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            name: "v2.0 Replay Regression Suite",
            cases: DEFAULT_BENCHMARK_CASES,
          }),
        });
        const body = await readApiJson<{ benchmark: BenchmarkRun }>(res);
        setData((prev) => ({
          ...prev,
          benchmarks: [body.benchmark, ...prev.benchmarks],
        }));
        setNotice(
          `Replay benchmark finished: ${pctLabel(body.benchmark.passRate)} pass rate · avg score ${body.benchmark.avgScore.toFixed(1)}.`,
        );
      } else {
        const run: BenchmarkRun = {
          id: `bm-${Date.now()}`,
          name: "v2.0 Replay Regression Suite",
          passRate: 1.0,
          avgScore: 95.3,
          avgLatencyMs: 131,
          cases: [
            { id: "case-auth-rbac", prompt: DEFAULT_BENCHMARK_CASES[0].prompt, passed: true, score: 97, latencyMs: 118 },
            { id: "case-preview-iso", prompt: DEFAULT_BENCHMARK_CASES[1].prompt, passed: true, score: 95, latencyMs: 141 },
            { id: "case-fts5-memory", prompt: DEFAULT_BENCHMARK_CASES[2].prompt, passed: true, score: 94, latencyMs: 134 },
          ],
          createdAt: new Date().toISOString(),
        };
        setData((prev) => ({ ...prev, benchmarks: [run, ...prev.benchmarks] }));
        setNotice(`Replay benchmark finished: 100% pass rate · avg score ${run.avgScore.toFixed(1)}.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const latestBenchmark = data.benchmarks[0] ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DrawerHeader>
        <PageTitle
          title="Factory & Benchmarks"
          context={`${data.days}-day metrics window · native task scorers, nightly improvement proposals & replay harness`}
        />
        {!isViewer && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Select
              size="sm"
              className="w-auto min-w-[170px] max-w-[240px]"
              value={selectedTaskId}
              aria-label="Task to score"
              options={
                tasks.length > 0
                  ? tasks.map((t) => ({ value: t.id, label: `${t.id} · ${t.title}` }))
                  : [{ value: "P3-T01", label: "P3-T01 · Sample task" }]
              }
              onChange={setSelectedTaskId}
            />
            <button
              type="button"
              className="btn btn-primary text-[13px]"
              disabled={busy === "score"}
              onClick={() => void handleScoreTask()}
            >
              <Icon name="grading" size={16} />
              {busy === "score" ? "Scoring…" : "Score task"}
            </button>
          </div>
        )}
      </DrawerHeader>

      <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto flex w-full max-w-[1160px] flex-col gap-5">
          {error && (
            <div className="rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-[12px] text-red" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div
              className="flex items-center justify-between gap-2 rounded-lg border border-green/40 bg-green/10 px-3 py-2 text-[12px] font-medium text-green"
              role="status"
            >
              <span className="flex items-center gap-1.5">
                <Icon name="check_circle" size={16} />
                {notice}
              </span>
              <button
                type="button"
                className="cursor-pointer text-[12px] text-muted hover:text-ink"
                onClick={() => setNotice(null)}
              >
                Dismiss
              </button>
            </div>
          )}

          {/* 1. 14-Day Factory Metrics Window */}
          <section className="flex flex-col gap-2.5" aria-label="Factory metrics window">
            <div className="flex items-center justify-between gap-2">
              <h2 className="m-0 text-[15px] font-semibold text-ink">
                {data.days}-Day Factory Metrics (Current vs Prior)
              </h2>
              <span className="text-[12px] text-muted">{snap.config.project.name}</span>
            </div>
            <div className="flex flex-wrap gap-3">
              <MetricBox
                label="Completed Tasks"
                value={String(data.current.completedTasks)}
                sub={`Prior ${data.days}d: ${data.previous.completedTasks}`}
                current={data.current.completedTasks}
                previous={data.previous.completedTasks}
              />
              <MetricBox
                label="Avg Score"
                value={`${data.current.avgScore.toFixed(1)}`}
                sub={`Prior ${data.days}d: ${data.previous.avgScore.toFixed(1)}`}
                current={data.current.avgScore}
                previous={data.previous.avgScore}
              />
              <MetricBox
                label="Pass Rate"
                value={pctLabel(data.current.passRate)}
                sub={`Prior ${data.days}d: ${pctLabel(data.previous.passRate)}`}
                current={data.current.passRate}
                previous={data.previous.passRate}
              />
              <MetricBox
                label="Total Cost"
                value={`$${data.current.totalCostUsd.toFixed(2)}`}
                sub={`Prior ${data.days}d: $${data.previous.totalCostUsd.toFixed(2)}`}
                current={data.current.totalCostUsd}
                previous={data.previous.totalCostUsd}
                higherIsBetter={false}
              />
              <MetricBox
                label="Avg Cycle Time"
                value={`${Math.round(data.current.avgCycleMins)} min`}
                sub={`Prior ${data.days}d: ${Math.round(data.previous.avgCycleMins)} min`}
                current={data.current.avgCycleMins}
                previous={data.previous.avgCycleMins}
                higherIsBetter={false}
              />
            </div>
          </section>

          {/* 2. Nightly Improvement Proposals + Replay Benchmark Harness */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            {/* Nightly Improvement Proposals */}
            <section
              className="panel flex flex-col gap-3 p-4 sm:p-5"
              aria-label="Nightly improvement proposals"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="m-0 text-[15px] font-semibold text-ink">Nightly Improvement Proposals</h2>
                  <p className="m-0 text-[12px] text-muted">
                    Automated workflow and cost tuning generated from score &amp; rework telemetry.
                  </p>
                </div>
                {!isViewer && (
                  <button
                    type="button"
                    className="btn text-[12px]"
                    disabled={busy === "proposals"}
                    onClick={() => void handleRunProposals()}
                  >
                    <Icon name="auto_awesome" size={16} />
                    {busy === "proposals" ? "Analyzing…" : "Run nightly analysis"}
                  </button>
                )}
              </div>

              {data.proposals.length === 0 ? (
                <p className="m-0 py-4 text-[13px] text-muted">No proposals yet. Run nightly analysis to inspect recent scores.</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
                  {data.proposals.map((p) => (
                    <li
                      key={p.id}
                      className="flex flex-col gap-2 rounded-xl border border-[var(--border-hairline)] bg-cream-2/40 p-3.5"
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="chip text-[12px] capitalize" style={{ ["--c" as string]: "var(--accent)" }}>
                          {p.category}
                        </span>
                        <span
                          className="chip text-[12px] capitalize"
                          style={{
                            ["--c" as string]:
                              p.status === "accepted"
                                ? "var(--color-green)"
                                : p.status === "dismissed"
                                  ? "var(--color-muted)"
                                  : "var(--color-amber)",
                          }}
                        >
                          {p.status}
                        </span>
                      </div>
                      <h3 className="m-0 text-[13px] font-semibold text-ink">{p.title}</h3>
                      <p className="m-0 text-[12px] leading-relaxed text-muted">{p.rationale}</p>
                      {p.diffHint && (
                        <code className="block overflow-x-auto rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-card)] px-2.5 py-1.5 font-term text-[12px] text-accent">
                          {p.diffHint}
                        </code>
                      )}
                      {!isViewer && p.status === "open" && (
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                          <button
                            type="button"
                            className="btn border-green/40 px-2.5 py-1 text-[12px] text-green"
                            disabled={busy === `decide:${p.id}`}
                            onClick={() => void handleDecideProposal(p, "accept")}
                          >
                            <Icon name="check" size={15} />
                            Accept
                          </button>
                          <button
                            type="button"
                            className="btn px-2.5 py-1 text-[12px]"
                            disabled={busy === `decide:${p.id}`}
                            onClick={() => void handleDecideProposal(p, "dismiss")}
                          >
                            <Icon name="close" size={15} />
                            Dismiss
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Replay Benchmark Harness */}
            <section
              className="panel flex flex-col gap-3 p-4 sm:p-5"
              aria-label="Replay benchmark harness"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="m-0 text-[15px] font-semibold text-ink">Replay Benchmark Harness</h2>
                  <p className="m-0 text-[12px] text-muted">
                    Replay golden regression prompts to measure pass rate, score, and latency.
                  </p>
                </div>
                {!isViewer && (
                  <button
                    type="button"
                    className="btn btn-primary text-[12px]"
                    disabled={busy === "benchmark"}
                    onClick={() => void handleRunBenchmark()}
                  >
                    <Icon name="play_arrow" size={16} />
                    {busy === "benchmark" ? "Running…" : "Run replay benchmark"}
                  </button>
                )}
              </div>

              {latestBenchmark ? (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border-hairline)] bg-cream-2/50 p-3">
                    <span className="text-[13px] font-semibold text-ink">{latestBenchmark.name}</span>
                    <div className="ml-auto flex flex-wrap items-center gap-1.5">
                      <span className="chip text-[12px]" style={{ ["--c" as string]: "var(--color-green)" }}>
                        Pass {pctLabel(latestBenchmark.passRate)}
                      </span>
                      <span className="chip text-[12px]" style={{ ["--c" as string]: "var(--accent)" }}>
                        Score {latestBenchmark.avgScore.toFixed(1)}
                      </span>
                      <span className="chip text-[12px]">{Math.round(latestBenchmark.avgLatencyMs)} ms</span>
                    </div>
                  </div>

                  <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Benchmark cases">
                    {latestBenchmark.cases.map((c) => (
                      <li
                        key={c.id}
                        className="flex items-start gap-2.5 rounded-lg border border-[var(--border-hairline)] bg-cream-2/30 px-3 py-2 text-[12px]"
                      >
                        <Icon
                          name={c.passed ? "check_circle" : "cancel"}
                          size={16}
                          className={`mt-0.5 shrink-0 ${c.passed ? "text-green" : "text-red"}`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <code className="font-term font-semibold text-ink">{c.id}</code>
                            <span className="text-muted">
                              {c.score}/100 · {Math.round(c.latencyMs)} ms
                            </span>
                          </div>
                          <p className="m-0 mt-0.5 text-muted">{c.prompt}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="m-0 py-4 text-[13px] text-muted">No benchmark runs yet. Click Run replay benchmark above.</p>
              )}
            </section>
          </div>

          {/* 3. Recent Task Scores */}
          <section className="panel flex flex-col gap-3 p-4 sm:p-5" aria-label="Recent task scores">
            <h2 className="m-0 text-[15px] font-semibold text-ink">Recent Task Scores · {data.scores.length}</h2>
            {data.scores.length === 0 ? (
              <p className="m-0 text-[13px] text-muted">No tasks scored yet.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {data.scores.slice(0, 8).map((s) => (
                  <li
                    key={s.id}
                    className="flex flex-wrap items-center gap-2.5 rounded-lg border border-[var(--border-hairline)] bg-cream-2/30 px-3 py-2 text-[13px]"
                  >
                    <span
                      className="chip font-term text-[12px] font-semibold"
                      style={{ ["--c" as string]: s.passed ? "var(--color-green)" : "var(--color-amber)" }}
                    >
                      {s.score}/100
                    </span>
                    <code className="font-term text-[12px] font-semibold text-accent">{s.taskId}</code>
                    <span className="min-w-0 flex-1 text-ink">{s.summary}</span>
                    {s.scorerKind && <span className="text-[12px] text-muted">{s.scorerKind}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/** Compact collapsible Factory summary card inside CommandView linking to the full FactoryPage workspace. */
export function FactoryCard({
  projects,
  live,
  defaultOpen = true,
}: {
  projects: { id: string; name: string }[];
  live: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(() => (readPref("cmd.factory") ?? (defaultOpen ? "open" : "closed")) === "open");
  const primaryId = projects[0]?.id ?? "";
  const [summary, setSummary] = useState<FactoryMetricsPayload | null>(() =>
    live ? null : initialMockFactory(primaryId || "demo"),
  );

  useEffect(() => {
    if (!live || !primaryId) return;
    let stop = false;
    fetch(`/api/projects/${encodeURIComponent(primaryId)}/factory/metrics?days=14`, {
      credentials: "same-origin",
      headers: authHeaders(),
    })
      .then((r) => (r.ok ? (r.json() as Promise<FactoryMetricsPayload>) : null))
      .then((payload) => {
        if (!stop && payload) setSummary(payload);
      })
      .catch(() => {
        /* offline */
      });
    return () => {
      stop = true;
    };
  }, [live, primaryId]);

  if (!summary) return null;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      writePref("cmd.factory", next ? "open" : "closed");
    } catch {
      /* ignore */
    }
  };

  return (
    <section
      className={`hud-glass flex flex-col gap-2.5 rounded-2xl px-4 ${open ? "py-3" : "py-1.5"}`}
      aria-label="Factory"
    >
      <div className="flex items-center gap-2">
        <button type="button" className="flex flex-1 cursor-pointer items-center gap-2 text-left" onClick={toggle} aria-expanded={open}>
          <b className="text-[13px] font-semibold text-ink">Factory</b>
          <span className="text-[12px] text-muted">last {summary.days} days vs prior</span>
          <span className="font-term text-[12px] text-muted">{open ? "▾" : "▸"}</span>
        </button>
        <button
          type="button"
          className="btn px-2.5 py-1 text-[12px]"
          onClick={() => ui.openFactory()}
        >
          Open Factory &amp; Benchmarks
        </button>
      </div>
      {open && (
        <div className="flex flex-wrap gap-2.5">
          <MetricBox
            label="Completed"
            value={String(summary.current.completedTasks)}
            sub={`Prior: ${summary.previous.completedTasks}`}
            current={summary.current.completedTasks}
            previous={summary.previous.completedTasks}
          />
          <MetricBox
            label="Avg Score"
            value={summary.current.avgScore.toFixed(1)}
            sub={`Pass ${pctLabel(summary.current.passRate)}`}
            current={summary.current.avgScore}
            previous={summary.previous.avgScore}
          />
          <MetricBox
            label="Total Cost"
            value={`$${summary.current.totalCostUsd.toFixed(2)}`}
            sub={`Cycle ${Math.round(summary.current.avgCycleMins)} min`}
            current={summary.current.totalCostUsd}
            previous={summary.previous.totalCostUsd}
            higherIsBetter={false}
          />
        </div>
      )}
    </section>
  );
}
