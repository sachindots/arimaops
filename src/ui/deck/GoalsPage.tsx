import { isViewer, officeActions, useOffice } from "../../store/office";
import { Goals } from "../settings/ProjectSettings";

/**
 * What the work adds up to: the project's goals with progress and spend (the lead links tasks and records each
 * goal's number), and the open tasks still linked to no goal, so you can link them yourself.
 */
export function GoalsPage() {
  const tasks = useOffice((s) => s.snap?.tasks);
  const goals = useOffice((s) => s.snap?.goals) ?? [];
  const active = goals.filter((g) => g.status === "active");
  const loose = (tasks ?? []).filter((t) => t.status !== "done" && !t.goalId);
  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-5">
      <header>
        <h1 className="m-0 font-display text-[18px] font-bold tracking-tight text-ink">Goals</h1>
        <p className="m-0 mt-1 text-[13px] text-muted">The lead plans against these: every task should move one. Spend counts priced models only.</p>
      </header>
      {isViewer ? <GoalList /> : <Goals headed={false} />}
      {active.length > 0 && loose.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="m-0 text-[14px] font-semibold">
            Open tasks with no goal <span className="font-normal text-muted">· {loose.length}</span>
          </h2>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {loose.slice(0, 40).map((t) => (
              <li key={t.id} className="panel flex items-center gap-3 px-3 py-2 text-[13px]">
                <span className="font-term text-muted">{t.id}</span>
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                {!isViewer && (
                  <select className="field w-auto text-[12px]" value="" aria-label={`Goal for ${t.id}`} onChange={(e) => e.target.value && officeActions.setTaskGoal(t.id, e.target.value)}>
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

/** Read-only list for viewers. */
function GoalList() {
  const goals = useOffice((s) => s.snap?.goals) ?? [];
  if (!goals.length) return <p className="text-[13px] text-muted">No goals yet.</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
      {goals.map((g) => (
        <li key={g.id} className="panel px-3 py-2 text-[13px]">
          <b>{g.title}</b>
          <div className="text-[12px] text-muted">
            {g.done} of {g.total} tasks done · ${g.usd.toFixed(2)} · {g.status}
          </div>
        </li>
      ))}
    </ul>
  );
}
