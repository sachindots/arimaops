import { useState } from "react";
import type { Goal } from "../../data/types";
import { isViewer, officeActions, useOffice } from "../../store/office";
import { ui } from "../../store/ui";
import { fmtUsd } from "../kit";

/**
 * What the work adds up to: one row per goal (its number now and the target, tasks done, the tasks linked to it,
 * spend, status), a form to add one, and the open tasks linked to no goal so you can link them yourself.
 */
export function GoalsPage() {
  const tasks = useOffice((s) => s.snap?.tasks) ?? [];
  const goals = useOffice((s) => s.snap?.goals) ?? [];
  const active = goals.filter((g) => g.status === "active");
  const loose = tasks.filter((t) => t.status !== "done" && !t.goalId);
  const order = [...goals].sort((a, b) => Number(a.status !== "active") - Number(b.status !== "active"));
  const cols = "minmax(220px,1.6fr) minmax(140px,1fr) minmax(150px,1fr) minmax(160px,1.2fr) 80px 110px";
  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-5">
      <header className="flex flex-wrap items-baseline gap-3">
        <h1 className="m-0 text-[20px] font-semibold tracking-tight text-ink">Goals</h1>
        <span className="text-[13px] text-muted">
          {active.length} active · the lead plans against these, so every task should move one. Spend counts priced models only.
        </span>
      </header>

      <section className="shrink-0 overflow-x-auto rounded-xl border border-[var(--border-hairline)] bg-[var(--surface-card)]" aria-label="Goals">
        <div role="table" className="min-w-[860px] text-[13px]">
          <div role="row" className="grid items-center gap-4 border-b border-[var(--border-hairline)] px-5 py-2.5 text-[12px] font-medium text-muted" style={{ gridTemplateColumns: cols }}>
            <span role="columnheader">Goal</span>
            <span role="columnheader">Number</span>
            <span role="columnheader">Progress</span>
            <span role="columnheader">Linked tasks</span>
            <span role="columnheader" className="text-right">
              Spend
            </span>
            <span role="columnheader">Status</span>
          </div>
          {order.length === 0 && <p className="m-0 px-5 py-6 text-[13px] text-muted">No goals yet. Add the few outcomes this project works toward.</p>}
          {order.map((g) => (
            <GoalRow key={g.id} goal={g} cols={cols} />
          ))}
        </div>
      </section>

      {!isViewer && <AddGoal />}

      {active.length > 0 && loose.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="m-0 text-[15px] font-semibold text-ink">
            Open tasks with no goal <span className="text-[13px] font-normal text-muted">· {loose.length}</span>
          </h2>
          <ul className="m-0 flex list-none flex-col divide-y divide-[var(--border-hairline)] rounded-xl border border-[var(--border-hairline)] bg-[var(--surface-card)] p-0">
            {loose.slice(0, 40).map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-4 py-2 text-[13px]">
                <button type="button" className="text-[12px] font-medium text-accent hover:underline" onClick={() => ui.openTask(t.id)}>
                  {t.id}
                </button>
                <span className="min-w-0 flex-1 truncate text-ink">{t.title}</span>
                {!isViewer && (
                  <select className="field w-auto text-[13px]" value="" aria-label={`Goal for ${t.id}`} onChange={(e) => e.target.value && officeActions.setTaskGoal(t.id, e.target.value)}>
                    <option value="">Link to a goal…</option>
                    {active.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.id} {g.title}
                      </option>
                    ))}
                  </select>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function GoalRow({ goal: g, cols }: { goal: Goal; cols: string }) {
  const tasks = useOffice((s) => s.snap?.tasks) ?? [];
  const linked = tasks.filter((t) => t.goalId === g.id);
  const open = linked.filter((t) => t.status !== "done");
  const pct = g.total ? Math.round((g.done / g.total) * 100) : 0;
  return (
    <div role="row" className={`grid items-center gap-4 border-b border-[var(--border-hairline)] px-5 py-3.5 last:border-b-0 ${g.status === "active" ? "" : "opacity-60"}`} style={{ gridTemplateColumns: cols }}>
      <span role="cell" className="min-w-0">
        <span className="block truncate font-semibold text-ink">{g.title}</span>
        <span className="text-[12px] text-muted">{g.id}</span>
      </span>
      <span role="cell" className="min-w-0">
        {g.metric ? (
          <>
            <span className="block truncate text-ink">
              {g.current ?? "—"}
              {g.target && <span className="text-muted"> of {g.target}</span>}
            </span>
            <span className="block truncate text-[12px] text-muted">{g.metric}</span>
          </>
        ) : (
          <span className="text-muted">No metric</span>
        )}
      </span>
      <span role="cell" className="flex items-center gap-2.5">
        <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-cream-3" role="img" aria-label={`${g.done} of ${g.total} tasks done`}>
          <span className="block h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
        </span>
        <span className="shrink-0 text-[12px] text-muted">
          {g.done}/{g.total}
        </span>
      </span>
      <span role="cell" className="flex min-w-0 flex-wrap items-center gap-1.5">
        {open.slice(0, 3).map((t) => (
          <button key={t.id} type="button" title={t.title} className="rounded-md bg-cream-2 px-1.5 py-0.5 text-[12px] font-medium text-accent hover:underline" onClick={() => ui.openTask(t.id)}>
            {t.id}
          </button>
        ))}
        {open.length > 3 && <span className="text-[12px] text-muted">+{open.length - 3}</span>}
        {open.length === 0 && <span className="text-[12px] text-muted">{linked.length ? "All done" : "None yet"}</span>}
      </span>
      <span role="cell" className="text-right font-medium text-ink">
        {fmtUsd(g.usd)}
      </span>
      <span role="cell">
        {isViewer ? (
          <span className="text-[13px] capitalize text-muted">{g.status}</span>
        ) : (
          <select className="field w-full text-[13px]" value={g.status} aria-label={`${g.id} status`} onChange={(e) => officeActions.updateGoal(g.id, { status: e.target.value as Goal["status"] })}>
            <option value="active">Active</option>
            <option value="done">Done</option>
            <option value="dropped">Dropped</option>
          </select>
        )}
      </span>
    </div>
  );
}

function AddGoal() {
  const [draft, setDraft] = useState({ title: "", metric: "", target: "" });
  const add = () => {
    if (!draft.title.trim()) return;
    officeActions.addGoal({ title: draft.title.trim(), metric: draft.metric.trim() || undefined, target: draft.target.trim() || undefined });
    setDraft({ title: "", metric: "", target: "" });
  };
  return (
    <form
      className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        add();
      }}
      aria-label="Add a goal"
    >
      <label className="flex flex-col gap-1 text-[12px] text-muted">
        New goal
        <input className="field text-[13px]" value={draft.title} placeholder="Launch the beta" onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
      </label>
      <label className="flex flex-col gap-1 text-[12px] text-muted">
        Metric
        <input className="field text-[13px]" value={draft.metric} placeholder="Signups" onChange={(e) => setDraft({ ...draft, metric: e.target.value })} />
      </label>
      <label className="flex flex-col gap-1 text-[12px] text-muted">
        Target
        <input className="field text-[13px]" value={draft.target} placeholder="200" onChange={(e) => setDraft({ ...draft, target: e.target.value })} />
      </label>
      <button className="btn btn-primary text-[13px]" type="submit" disabled={!draft.title.trim()}>
        Add goal
      </button>
    </form>
  );
}
