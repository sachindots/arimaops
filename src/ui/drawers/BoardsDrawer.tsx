import { useState } from "react";
import { type BoardStatus, type Task, type TaskStatus } from "../../data/types";
import { officeActions, useOffice } from "../../store/office";
import { readPref, writePref } from "../../lib/prefs";
import { ago, Dot, Meter, Portrait, TokensChip, useNow } from "../kit";
import { Icon } from "../deck/Icon";
import { Select } from "../primitives/Select";
import { DrawerHeader, PageTitle } from "./Drawer";
import { TaskSheet } from "./TaskSheet";

const COLUMNS: { id: TaskStatus; label: string; color: string }[] = [
  { id: "todo", label: "To do", color: "#6b7280" },
  { id: "in-progress", label: "Doing", color: "#818cf8" },
  { id: "in-review", label: "Review", color: "#a371f7" },
  { id: "done", label: "Done", color: "#3fb950" },
  { id: "blocked", label: "Blocked", color: "#ff2a4b" },
];

const STATUS_LABEL: Record<BoardStatus, string> = { active: "Active", planned: "Planned", done: "Done" };

export function BoardsDrawer({ initialBoardId, initialStageId, initialTaskId }: { initialBoardId?: string; initialStageId?: string; initialTaskId?: string }) {
  const snap = useOffice((s) => s.snap);
  const now = useNow(30_000);
  const boards = [...(snap?.boards ?? [])].sort((a, b) => a.order - b.order);
  // Open where the work is: an active board with open tasks, then any active board, then the first.
  const [boardId, setBoardId] = useState(
    initialBoardId ??
      (snap?.tasks ?? []).find((t) => t.id === initialTaskId)?.boardId ??
      boards.find((b) => b.status === "active" && (snap?.tasks ?? []).some((t) => t.boardId === b.id && t.status !== "done"))?.id ??
      boards.find((b) => b.status === "active")?.id ??
      boards[0]?.id,
  );
  const [stageId, setStageId] = useState<string | null>(initialStageId ?? null);
  const [agentId, setAgentId] = useState<string | null>(null); // "" = unassigned
  const [goalId, setGoalId] = useState<string | null>(null);
  const [openTask, setOpenTask] = useState<string | null>(initialTaskId ?? null);
  const [byAgent, setByAgent] = useState(() => readPref("board.lanes") === "agent");
  if (!snap) return null;
  const board = boards.find((b) => b.id === boardId);
  const stages = snap.config.template?.flow.stages ?? [];
  const goals = (snap.goals ?? []).filter((g) => g.status !== "dropped");
  const onBoard = snap.tasks.filter((t) => t.boardId === boardId);
  const tasks = onBoard.filter(
    (t) =>
      (!stageId || t.stageId === stageId) &&
      (agentId === null || (agentId === "" ? !t.ownerId : t.ownerId === agentId)) &&
      (!goalId || t.goalId === goalId),
  );
  const filtered = stageId !== null || agentId !== null || goalId !== null;
  const cols = COLUMNS.filter((c) => c.id !== "blocked" || tasks.some((t) => t.status === "blocked"));
  const template = cols.map((c) => (tasks.some((t) => t.status === c.id) ? "minmax(min(240px, 86%), 1fr)" : "minmax(110px, 0.4fr)")).join(" ");
  const done = onBoard.filter((t) => t.status === "done").length;
  const toggleLanes = () => {
    setByAgent(!byAgent);
    try {
      writePref("board.lanes", byAgent ? "none" : "agent");
    } catch {
      /* private window */
    }
  };

  // One lane for the whole board, or one per owner (team order, then unassigned) when grouped by agent.
  const lanes: { id: string; name: string; color?: string; tasks: Task[] }[] = byAgent
    ? [
        ...snap.config.team.map((a) => ({ id: a.id, name: a.name, color: a.color, tasks: tasks.filter((t) => t.ownerId === a.id) })),
        { id: "", name: "Unassigned", tasks: tasks.filter((t) => !t.ownerId || !snap.config.team.some((a) => a.id === t.ownerId)) },
      ].filter((l) => l.tasks.length)
    : [{ id: "all", name: "", tasks }];
  const selectClass = "w-auto min-w-[120px]";

  return (
    <>
      <DrawerHeader>
        <PageTitle title="Board" context={board ? <>{board.title} · {done}/{onBoard.length} done</> : <>{boards.length} boards</>} />
        {board && (
          <span className="ml-auto flex flex-wrap items-center gap-2">
            <span className="hidden w-[120px] items-center lg:flex" title="Tasks done on this board">
              <Meter value={done} max={Math.max(1, onBoard.length)} color="var(--accent)" label="Board progress" />
            </span>
            <Select
              className="w-auto min-w-[104px]"
              size="sm"
              value={board.status}
              aria-label="Board status (agents only pick tasks from active boards)"
              title="Agents only pick tasks from active boards"
              options={(Object.keys(STATUS_LABEL) as BoardStatus[]).map((st) => ({ value: st, label: STATUS_LABEL[st] }))}
              onChange={(v) => officeActions.updateBoard(board.id, { status: v as BoardStatus })}
            />
            <button className="btn text-[13px]" aria-pressed={byAgent} onClick={toggleLanes} title="One row per agent">
              <Icon name="view_agenda" size={16} /> Group by agent
            </button>
          </span>
        )}
      </DrawerHeader>

      <nav className="scroll-thin flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--border-hairline)] px-4" aria-label="Boards">
        {boards.map((b) => (
          <button
            key={b.id}
            type="button"
            aria-current={b.id === boardId ? "page" : undefined}
            onClick={() => setBoardId(b.id)}
            className={`-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-2 text-[13px] transition-colors ${b.id === boardId ? "border-[var(--accent)] font-medium text-ink" : "border-transparent text-muted hover:text-ink"}`}
          >
            {b.status === "active" && <span className="h-1.5 w-1.5 rounded-full bg-accent" title="Active" />}
            {b.title}
          </button>
        ))}
      </nav>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-hairline)] px-4 py-2">
        <Icon name="filter_list" size={16} className="text-muted" />
        <Select
          className={selectClass}
          size="sm"
          value={agentId ?? "*"}
          aria-label="Filter by agent"
          options={[
            { value: "*", label: "Every agent" },
            ...snap.config.team.map((a) => ({ value: a.id, label: a.name })),
            { value: "", label: "Unassigned" },
          ]}
          onChange={(v) => setAgentId(v === "*" ? null : v)}
        />
        {goals.length > 0 && (
          <Select
            className={selectClass}
            size="sm"
            value={goalId ?? ""}
            aria-label="Filter by goal"
            options={[
              { value: "", label: "Every goal" },
              ...goals.map((g) => ({ value: g.id, label: `${g.id} · ${g.title}` })),
            ]}
            onChange={(v) => setGoalId(v || null)}
          />
        )}
        {stages.length > 0 && (
          <Select
            className={selectClass}
            size="sm"
            value={stageId ?? ""}
            aria-label="Filter by stage"
            options={[
              { value: "", label: "Every stage" },
              ...stages.map((st) => ({ value: st.id, label: st.name })),
            ]}
            onChange={(v) => setStageId(v || null)}
          />
        )}
        {filtered && (
          <button type="button" className="text-[13px] text-accent hover:underline" onClick={() => (setAgentId(null), setGoalId(null), setStageId(null))}>
            Clear
          </button>
        )}
        <span className="ml-auto text-[12px] text-muted">
          {filtered ? `${tasks.length} of ${onBoard.length} tasks` : `${onBoard.length} tasks`}
        </span>
      </div>

      <div className="scroll-thin flex min-h-0 flex-1 snap-x flex-col gap-3 overflow-auto p-4 max-[560px]:snap-mandatory">
        <div className="grid gap-3" style={{ gridTemplateColumns: template }}>
          {cols.map((c) => {
            const list = tasks.filter((t) => t.status === c.id);
            // How long the oldest card has sat in this column (done doesn't wait on anyone).
            const oldest = c.id === "done" ? undefined : list.map((t) => t.movedAt).filter((x): x is string => !!x).sort()[0];
            return (
              <h2 key={c.id} className="m-0 flex min-w-0 snap-start items-center gap-2 px-1 text-[13px] font-semibold text-ink">
                <i className="h-2 w-2 shrink-0 rounded-full" style={{ background: c.color }} aria-hidden="true" />
                <span className="truncate">{c.label}</span>
                <span className="font-normal text-muted">{list.length}</span>
                <span className="flex-1" />
                {oldest && (
                  <span className="truncate text-[12px] font-normal text-muted" title="How long the oldest card here has been in this column">
                    oldest {ago(oldest, now)}
                  </span>
                )}
              </h2>
            );
          })}
        </div>
        {lanes.map((l) => (
          <section key={l.id} className="flex flex-col gap-2" aria-label={l.name || "Tasks"}>
            {byAgent && (
              <h3 className="m-0 flex items-center gap-1.5 px-1 pt-1 text-[13px] font-semibold text-muted">
                {l.color && <Dot color={l.color} size={8} />}
                {l.name} <span className="font-normal">{l.tasks.length}</span>
              </h3>
            )}
            <div className="grid items-start gap-3" style={{ gridTemplateColumns: template }}>
              {cols.map((c) => {
                const list = l.tasks.filter((t) => t.status === c.id);
                if (c.id === "done") list.reverse();
                return (
                  <div key={c.id} className="flex min-h-[48px] min-w-0 flex-col gap-1.5 rounded-xl bg-cream-2/60 p-1.5">
                    {!list.length && !byAgent && <p className="m-0 py-3 text-center text-[12px] text-muted">Nothing here</p>}
                    {list.map((t) => (
                      <TaskCard key={t.id} task={t} now={now} onOpen={() => setOpenTask(t.id)} />
                    ))}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
        {onBoard.length === 0 && <p className="m-0 p-6 text-center text-[13px] text-muted">No tasks on this board yet. The lead adds tasks when a board is active.</p>}
        {onBoard.length > 0 && tasks.length === 0 && <p className="m-0 p-6 text-center text-[13px] text-muted">No task matches these filters.</p>}
      </div>
      {openTask && <TaskSheet taskId={openTask} onClose={() => setOpenTask(null)} />}
    </>
  );
}

/** A task on the board: id, title, owner, goal, how long it has sat here, and badges. Click for the task sheet. */
function TaskCard({ task, now, onOpen }: { task: Task; now: number; onOpen: () => void }) {
  const snap = useOffice((s) => s.snap);
  const owner = snap?.config.team.find((a) => a.id === task.ownerId);
  const goal = task.goalId ? snap?.goals?.find((g) => g.id === task.goalId) : undefined;
  const blockedBy = task.needs.filter((n) => snap?.tasks.find((t) => t.id === n)?.status !== "done");
  const failed = task.scores?.filter((x) => !x.pass).length ?? 0;
  const done = task.status === "done";
  return (
    <button
      className="group w-full cursor-pointer rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-card)] px-3 py-2.5 text-left transition-colors hover:border-[var(--border-strong)] focus-visible:border-[var(--accent)]"
      onClick={onOpen}
      aria-label={`${task.id} ${task.title}: open`}
    >
      <div className="flex items-center gap-1.5 text-[12px] text-muted">
        <span className="font-medium">{task.id}</span>
        {task.prNumber && <span>· #{task.prNumber}</span>}
        <span className="flex-1" />
        {owner ? (
          <span title={owner.name}>
            <Portrait name={owner.name} color={owner.color} lead={owner.isLead} size={20} />
          </span>
        ) : (
          <span className="grid h-5 w-5 place-items-center rounded-md border border-dashed border-[var(--border-strong)]" title="Unassigned">
            <Icon name="person" size={12} />
          </span>
        )}
      </div>
      <div className={`mt-1 text-[13px] font-medium leading-snug ${done ? "text-muted line-through decoration-muted/40" : "text-ink"}`}>{task.title}</div>
      {task.status === "blocked" && task.note && <div className="mt-1 line-clamp-2 text-[12px] text-red">{task.note}</div>}
      {blockedBy.length > 0 && task.status === "todo" && <div className="mt-1 text-[12px] text-amber">Waits on {blockedBy.join(", ")}</div>}
      <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-muted">
        {goal && (
          <span className="flex max-w-[60%] items-center gap-1" title={`Goal ${goal.id}: ${goal.title}`}>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
            <span className="truncate">{goal.title}</span>
          </span>
        )}
        {task.movedAt && !done && <span title="In this column for">{ago(task.movedAt, now)}</span>}
        <span className="flex-1" />
        {task.scores && task.scores.length > 0 && (
          <span className={failed ? "text-amber" : "text-green"} title={failed ? `${failed} check${failed === 1 ? "" : "s"} failed` : "Checks passed"}>
            {failed ? `${failed} failed` : `✓ ${task.scores.length}`}
          </span>
        )}
        {task.evidence && <span title={`${task.evidence.shots.length} screenshots at ${task.evidence.sha.slice(0, 7)}`}>▣ {task.evidence.shots.length}</span>}
        {task.benchmark && <span title="In the benchmark suite">◆</span>}
        {task.usage && <TokensChip usage={task.usage} />}
      </div>
    </button>
  );
}
