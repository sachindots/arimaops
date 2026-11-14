import { useState } from "react";
import { CLI_LABEL, type BoardStatus, type Task, type TaskStatus } from "../../data/types";
import { officeActions, useOffice } from "../../store/office";
import { readPref, writePref } from "../../lib/prefs";
import { ago, Dot, Meter, TokensChip, useNow } from "../kit";
import { DrawerHeader } from "./Drawer";
import { TaskSheet } from "./TaskSheet";

const COLUMNS: { id: TaskStatus; label: string; color: string }[] = [
  { id: "todo", label: "To do", color: "#6b7280" },
  { id: "in-progress", label: "Doing", color: "#818cf8" },
  { id: "in-review", label: "Review", color: "#a371f7" },
  { id: "done", label: "Done", color: "#3fb950" },
  { id: "blocked", label: "Blocked", color: "#ff2a4b" },
];

const STATUS_LABEL: Record<BoardStatus, string> = { active: "Active", planned: "Planned", done: "Done" };

export function BoardsDrawer({ initialBoardId }: { initialBoardId?: string }) {
  const snap = useOffice((s) => s.snap);
  const now = useNow(30_000);
  const boards = [...(snap?.boards ?? [])].sort((a, b) => a.order - b.order);
  const [boardId, setBoardId] = useState(initialBoardId ?? boards.find((b) => b.status === "active")?.id ?? boards[0]?.id);
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [byAgent, setByAgent] = useState(() => readPref("board.lanes") === "agent");
  if (!snap) return null;
  const board = boards.find((b) => b.id === boardId);
  const tasks = snap.tasks.filter((t) => t.boardId === boardId);
  const cols = COLUMNS.filter((c) => c.id !== "blocked" || tasks.some((t) => t.status === "blocked"));
  const template = cols.map((c) => (tasks.some((t) => t.status === c.id) ? "minmax(min(230px, 86%), 1fr)" : "minmax(96px, 0.35fr)")).join(" ");
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

  return (
    <>
      <DrawerHeader>
        <b className="font-display text-[19px] font-semibold text-ink">Boards</b>
        <span className="text-[13px] text-muted">
          {boards.length} in {snap.config.project.name}
        </span>
      </DrawerHeader>
      <div className="flex flex-wrap gap-1.5 border-b border-white/[0.08] px-4 py-2">
        {boards.map((b) => (
          <button key={b.id} className="btn px-2.5 text-[13px]" aria-pressed={b.id === boardId} onClick={() => setBoardId(b.id)}>
            {b.status === "active" && <span className="mr-1.5 text-accent">●</span>}
            {b.title}
          </button>
        ))}
      </div>
      {board && (
        <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] bg-navy/60 px-4 py-1.5 text-[13px]">
          <span className="text-muted">Status</span>
          <select
            className="field h-7 w-[116px] py-0 text-[13px]"
            value={board.status}
            onChange={(e) => officeActions.updateBoard(board.id, { status: e.target.value as BoardStatus })}
          >
            {(Object.keys(STATUS_LABEL) as BoardStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <span className="text-[12px] text-muted">Agents only pick tasks from active boards.</span>
          <span className="flex-1" />
          {tasks.length > 0 && (
            <span className="flex w-[180px] items-center gap-2" title="Tasks done on this board">
              <span className="shrink-0 font-display text-[13px] text-ink">
                {tasks.filter((t) => t.status === "done").length}/{tasks.length}
              </span>
              <span className="min-w-0 flex-1">
                <Meter value={tasks.filter((t) => t.status === "done").length} max={tasks.length} color="#3fb950" label="Board progress" />
              </span>
            </span>
          )}
          <button className="btn px-2.5 text-[12px]" aria-pressed={byAgent} onClick={toggleLanes} title="One row per agent">
            Group by agent
          </button>
        </div>
      )}
      <div className="scroll-thin flex min-h-0 flex-1 snap-x flex-col gap-3 overflow-auto bg-navy-2/75 p-4 max-[560px]:snap-mandatory">
        <div className="grid gap-3" style={{ gridTemplateColumns: template }}>
          {cols.map((c) => {
            const list = tasks.filter((t) => t.status === c.id);
            // How long the oldest card has sat in this column (done doesn't wait on anyone).
            const oldest = c.id === "done" ? undefined : list.map((t) => t.movedAt).filter((x): x is string => !!x).sort()[0];
            return (
              <h4 key={c.id} className="m-0 flex min-w-0 snap-start items-center gap-2 border-b-2 pb-1.5 font-display text-[14px] font-semibold text-ink" style={{ borderColor: c.color }}>
                <i className="h-2 w-2 shrink-0 rounded-full" style={{ background: c.color, boxShadow: `0 0 8px ${c.color}` }} />
                <span className="truncate">{c.label}</span>
                <span className="text-[13px] font-normal text-muted">{list.length}</span>
                <span className="flex-1" />
                {oldest && (
                  <span className="truncate text-[12px] font-normal text-muted" title="How long the oldest card here has been in this column">
                    oldest {ago(oldest, now)}
                  </span>
                )}
              </h4>
            );
          })}
        </div>
        {lanes.map((l) => (
          <section key={l.id} className="flex flex-col gap-2" aria-label={l.name || "Tasks"}>
            {byAgent && (
              <h5 className="m-0 flex items-center gap-1.5 text-[13px] font-semibold text-muted">
                {l.color && <Dot color={l.color} size={8} />}
                {l.name} <span className="font-term font-normal">{l.tasks.length}</span>
              </h5>
            )}
            <div className="grid items-start gap-3" style={{ gridTemplateColumns: template }}>
              {cols.map((c) => {
                const list = l.tasks.filter((t) => t.status === c.id);
                if (c.id === "done") list.reverse();
                return (
                  <div key={c.id} className="flex min-w-0 flex-col gap-2">
                    {!list.length && !byAgent && <p className="m-0 py-2 text-center text-[12px] text-muted/70">Nothing here</p>}
                    {list.map((t) => (
                      <TaskCard key={t.id} task={t} onOpen={() => setOpenTask(t.id)} />
                    ))}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
        {tasks.length === 0 && <p className="m-0 p-6 text-center text-muted">No tasks on this board yet. The lead adds tasks when a board is active.</p>}
      </div>
      {openTask && <TaskSheet taskId={openTask} onClose={() => setOpenTask(null)} />}
    </>
  );
}

/** A task on the board: who, what, and badges for what's inside. Tap it for the task sheet. */
function TaskCard({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const snap = useOffice((s) => s.snap);
  const owner = snap?.config.team.find((a) => a.id === task.ownerId);
  const blockedBy = task.needs.filter((n) => snap?.tasks.find((t) => t.id === n)?.status !== "done");
  const failed = task.scores?.filter((x) => !x.pass).length ?? 0;
  const done = task.status === "done";
  return (
    <button
      className={`hud-scan group w-full cursor-pointer rounded-xl border px-3 py-2.5 text-left transition-all duration-150 hover:-translate-y-0.5 focus-visible:border-accent ${
        done
          ? "border-white/[0.06] bg-navy/50 hover:border-white/20"
          : "border-white/[0.08] bg-navy/80 hover:border-accent/45 hover:shadow-[0_8px_24px_rgba(0,0,0,0.35)]"
      }`}
      style={{ boxShadow: `inset 3px 0 0 ${COLUMNS.find((c) => c.id === task.status)?.color ?? "#6b7280"}` }}
      onClick={onOpen}
      aria-label={`${task.id} ${task.title}: open`}
    >
      <div className="flex items-center gap-1.5 font-term text-[12px] text-muted">
        <span>{task.id}</span>
        {task.prNumber && <span>#{task.prNumber}</span>}
        <span className="flex-1" />
        {task.usage && <TokensChip usage={task.usage} />}
      </div>
      <div className={`mt-1 text-[13px] font-medium leading-snug ${done ? "text-muted" : "text-ink"}`}>{task.title}</div>
      {task.status === "blocked" && task.note && <div className="mt-0.5 line-clamp-2 text-[12px] text-red">{task.note}</div>}
      {blockedBy.length > 0 && task.status === "todo" && <div className="mt-0.5 text-[12px] text-red">Waits on {blockedBy.join(", ")}</div>}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
        {owner ? (
          <span className="flex items-center gap-1 text-[12px]">
            <Dot color={owner.color} size={8} /> {owner.name}
          </span>
        ) : (
          <span className="text-[12px] text-muted">Unassigned</span>
        )}
        <span className="flex-1" />
        {task.scores && task.scores.length > 0 && (
          <span className={failed ? "text-amber" : "text-green"} title={failed ? `${failed} check${failed === 1 ? "" : "s"} failed` : "Checks passed"}>
            {failed ? `◇ ${failed} failed` : `✓ ${task.scores.length}`}
          </span>
        )}
        {task.evidence && <span className="text-[#4fb3c4]" title={`${task.evidence.shots.length} screenshots at ${task.evidence.sha.slice(0, 7)}`}>▣ {task.evidence.shots.length}</span>}
        {task.benchmark && <span className="text-[#9085e9]" title="In the benchmark suite">◆</span>}
        {task.cli && <span className="text-muted" title="Runs on">{CLI_LABEL[task.cli]}</span>}
      </div>
    </button>
  );
}
