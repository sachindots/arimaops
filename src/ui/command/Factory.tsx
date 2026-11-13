// The Command center's factory card (docs/factory.md section 3): per project, what a finished task costs, how long it
// takes, how often it bounces, and how often you had to step in, against the days before. Read-only.

import { useEffect, useState } from "react";
import type { Cost, FactoryMetrics, MetricsReport, VersionMetrics } from "../../data/metrics";
import { readPref, writePref } from "../../lib/prefs";
import { isScorerId, SCORERS } from "../../data/scorers";

const DAYS = 7;

function token(): string {
  try {
    return sessionStorage.getItem("hq-token") ?? "";
  } catch {
    return "";
  }
}

/** Each project's report, refreshed every minute while the page is visible. Projects the API can't answer are left out. */
function useMetrics(projects: string[], live: boolean, ms = 60_000): Record<string, MetricsReport> {
  const [out, setOut] = useState<Record<string, MetricsReport>>({});
  const key = projects.join(",");
  useEffect(() => {
    if (!live || !key) return;
    let stop = false;
    const tick = async () => {
      if (document.hidden) return;
      const tok = token();
      const next: Record<string, MetricsReport> = {};
      await Promise.all(
        key.split(",").map(async (p) => {
          try {
            const r = await fetch(`/api/projects/${encodeURIComponent(p)}/metrics?days=${DAYS}${tok ? `&token=${encodeURIComponent(tok)}` : ""}`, { credentials: "same-origin" });
            if (r.ok) next[p] = (await r.json()) as MetricsReport;
          } catch {
            /* offline: keep the last numbers */
          }
        }),
      );
      if (!stop) setOut((prev) => ({ ...prev, ...next }));
    };
    void tick();
    const t = window.setInterval(() => void tick(), ms);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [key, live, ms]);
  return out;
}

const short = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
const hours = (ms: number) => (ms < 60_000 ? "<1 min" : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : ms < 48 * 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : `${(ms / 86_400_000).toFixed(1)} d`);
const cost = (c: Cost | null) => (!c ? "—" : c.usd !== null ? `$${c.usd.toFixed(2)}` : `${short(c.tokens)} tok`);
const many = (n: number, one: string, more = `${one}s`) => `${n} ${n === 1 ? one : more}`;
const costNum = (c: Cost | null) => (!c ? null : c.usd ?? c.tokens);

/** Change against the window before. Every metric here is better lower. */
function Delta({ now, before }: { now: number | null; before: number | null }) {
  if (now === null || before === null || before === 0) return null;
  const pct = Math.round(((now - before) / before) * 100);
  if (!pct) return <span className="text-[11px] text-muted">= </span>;
  const better = pct < 0;
  return (
    <span className="font-mono text-[11px]" style={{ color: better ? "#3fb950" : "#d29922" }} title={`Last ${DAYS} days against the ${DAYS} before`}>
      {better ? "▼" : "▲"}
      {Math.abs(pct)}%
    </span>
  );
}

function Metric({ label, value, sub, now, before, title }: { label: string; value: string; sub?: string; now: number | null; before: number | null; title: string }) {
  return (
    <div className="flex min-w-[120px] flex-1 flex-col gap-0.5 border-l-2 border-ink/20 pl-2.5" title={title}>
      <span className="text-[11px] uppercase tracking-wide text-muted">{label}</span>
      <span className="flex items-baseline gap-1.5">
        <b className="font-mono text-[17px] leading-none">{value}</b>
        <Delta now={now} before={before} />
      </span>
      {sub && <span className="text-[11px] leading-tight text-muted">{sub}</span>}
    </div>
  );
}

function Versions({ versions }: { versions: VersionMetrics[] }) {
  if (versions.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]" aria-label="Template versions">
      <span className="text-muted">By template version:</span>
      {versions.map((v) => (
        <span key={`${v.templateId}@${v.version}`} className="chip font-mono text-[11px]" title={`${v.finished} finished; cost per task, median cycle time, failed gates per task, share of checks failed`}>
          {v.templateId} v{v.version} · {v.finished} done · {cost(v.costPerTask)} · {v.cycleCreated === null ? "—" : hours(v.cycleCreated)} · {v.reworkPerTask === null ? "—" : v.reworkPerTask.toFixed(1)} rework{v.checkFailRate === null ? "" : ` · ${Math.round(v.checkFailRate * 100)}% checks failed`}
        </span>
      ))}
    </div>
  );
}

function Row({ name, multi, r }: { name: string; multi: boolean; r: MetricsReport }) {
  const n: FactoryMetrics = r.now;
  const b: FactoryMetrics = r.before;
  const nothing = n.finished === 0 && b.finished === 0 && n.interventions.total === 0 && n.stalls + n.replans === 0;
  return (
    <div className="flex flex-col gap-1.5">
      {multi && <b className="text-[13px]">{name}</b>}
      {nothing ? (
        <p className="m-0 text-[12px] text-muted">No tasks finished in the last {DAYS * 2} days yet. Numbers start with the first task made from now on.</p>
      ) : (
        <div className="flex flex-wrap gap-y-2">
          <Metric
            label="Cost / task"
            value={cost(n.costPerTask)}
            sub={`${n.finished} done${n.merged ? ` · ${many(n.merged, "PR")}, ${cost(n.costPerPr)} each` : ""}`}
            now={costNum(n.costPerTask)}
            before={costNum(b.costPerTask)}
            title="Everything spent on the tasks finished in the window, per task. Dollars where the model is priced (API keys), tokens otherwise."
          />
          <Metric
            label="Cycle time"
            value={n.cycle.created === null ? "—" : hours(n.cycle.created)}
            sub={[n.cycle.started !== null && `${hours(n.cycle.started)} once started`, n.cycle.unknown > 0 && `${n.cycle.unknown} unknown`].filter(Boolean).join(" · ") || undefined}
            now={n.cycle.created}
            before={b.cycle.created}
            title="Median time from a task being made to done. Tasks made before HQ kept their history are counted as unknown, not guessed."
          />
          <Metric
            label="Rework"
            value={n.rework.perTask === null ? "—" : n.rework.perTask.toFixed(1)}
            sub={`${many(n.rework.failed, "failed gate")}`}
            now={n.rework.perTask}
            before={b.rework.perTask}
            title="Failed gates per finished task"
          />
          <Metric
            label="Checks failed"
            value={n.checks.run ? `${n.checks.failed} of ${n.checks.run}` : "—"}
            sub={n.checks.worst ? `most failed: ${isScorerId(n.checks.worst.scorer) ? SCORERS[n.checks.worst.scorer].label : n.checks.worst.scorer} (${n.checks.worst.failed})` : undefined}
            now={n.checks.run ? n.checks.failed / n.checks.run : null}
            before={b.checks.run ? b.checks.failed / b.checks.run : null}
            title="Scorer verdicts on the finished tasks: rules always, model checks when memory extraction is on. A failed check never blocks a task."
          />
          <Metric
            label="Stalls · replans"
            value={`${n.stalls} · ${n.replans}`}
            now={n.stalls + n.replans}
            before={b.stalls + b.replans}
            title="Times the lead's progress ledger recorded a stall or a replan"
          />
          <Metric
            label="You stepped in"
            value={`${n.interventions.total}×`}
            sub={`${many(n.interventions.gates, "gate")} · ${many(n.interventions.answers, "answer")} · ${many(n.interventions.messages, "message")}`}
            now={n.interventions.total}
            before={b.interventions.total}
            title="Gates you recorded, Action items you answered, and messages you sent agents"
          />
        </div>
      )}
      <Versions versions={r.versions} />
    </div>
  );
}

/** The factory card: hidden until a project answers; folds to one line, remembered per browser. */
export function FactoryCard({ projects, live }: { projects: { id: string; name: string }[]; live: boolean }) {
  const [open, setOpen] = useState(() => readPref("cmd.factory") !== "closed");
  const reports = useMetrics(
    projects.map((p) => p.id),
    live,
  );
  const shown = projects.filter((p) => reports[p.id]);
  if (!shown.length) return null;
  const toggle = () => {
    setOpen(!open);
    try {
      writePref("cmd.factory", open ? "closed" : "open");
    } catch {
      /* private window */
    }
  };
  return (
    <section className="panel flex flex-col gap-2 px-3 py-2" aria-label="Factory">
      <button className="flex items-center gap-2 text-left" onClick={toggle} aria-expanded={open}>
        <b className="text-[14px]">Factory</b>
        <span className="text-[12px] text-muted">last {DAYS} days, against the {DAYS} before</span>
        <span className="flex-1" />
        <span className="text-[12px] text-muted">{open ? "▾" : "▸"}</span>
      </button>
      {open && shown.map((p) => <Row key={p.id} name={p.name} multi={shown.length > 1} r={reports[p.id]} />)}
    </section>
  );
}
