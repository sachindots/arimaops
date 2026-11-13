import { useState } from "react";
import { CLI_LABEL, type BoardStatus, type Task, type TaskStatus } from "../../data/types";
import { officeActions, useOffice } from "../../store/office";
import { Dot, TokensChip } from "../kit";
import { DrawerHeader } from "./Drawer";
import { TaskSheet } from "./TaskSheet";

const COLUMNS: { id: TaskStatus; label: string; color: string }[] = [
  { id: "todo", label: "To do", color: "#6b7280" },
  { id: "in-progress", label: "Doing", color: "#818cf8" },
  { id: "in-review", label: "Review", color: "#a371f7" },
  { id: "done", label: "Done", color: "#3fb950" },
  { id: "blocked", label: "Blocked", color: "#f85149" },
];

const STATUS_LABEL: Record<BoardStatus, string> = { active: "Active", planned: "Planned", done: "Done" };

export function BoardsDrawer({ initialBoardId }: { initialBoardId?: string }) {
  const snap = useOffice((s) => s.snap);
  const boards = [...(snap?.boards ?? [])].sort((a, b) => a.order - b.order);
  const [boardId, setBoardId] = useState(initialBoardId ?? boards.find((b) => b.status === "active")?.id ?? boards[0]?.id);
  const [openTask, setOpenTask] = useState<string | null>(null);
  if (!snap) return null;
  const board = boards.find((b) => b.id === boardId);
  const tasks = snap.tasks.filter((t) => t.boardId === boardId);
  const cols = COLUMNS.filter((c) => c.id !== "blocked" || tasks.some((t) => t.status === "blocked"));

  return (
    <>
      <DrawerHeader>
        <b className="text-[18px]">Boards</b>
        <span className="text-[14px] text-muted">{boards.length} in {snap.config.project.name}</span>
      </DrawerHeader>
      <div className="flex flex-wrap gap-1.5 border-b border-ink px-3 py-2">
        {boards.map((b) => (
          <button key={b.id} className="btn px-2 text-[13px]" aria-pressed={b.id === boardId} onClick={() => setBoardId(b.id)}>
            {b.status === "active" && <span className="mr-1 text-green">●</span>}
            {b.title}
          </button>
        ))}
      </div>
      {board && (
        <div className="flex items-center gap-2 border-b border-ink bg-cream-2 px-3 py-1.5 text-[14px]">
          <span className="text-muted">Status</span>
          <select
            className="field w-[120px] py-0 text-[14px]"
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
        </div>
      )}
      <div
        className="scroll-thin grid min-h-0 flex-1 snap-x content-start gap-3 overflow-auto bg-[#0b0c0f] p-3 max-[560px]:snap-mandatory"
        style={{ gridTemplateColumns: cols.map((c) => (tasks.some((t) => t.status === c.id) ? "minmax(min(230px, 86%), 1fr)" : "minmax(92px, 0.35fr)")).join(" ") }}
      >
        {cols.map((c) => {
          const list = tasks.filter((t) => t.status === c.id);
          if (c.id === "done") list.reverse();
          return (
            <div key={c.id} className="min-w-0 snap-start">
              <h4 className="mb-2 flex justify-between border-b pb-0.5 text-[14px] font-semibold" style={{ borderColor: c.color }}>
                {c.label} <span className="font-term text-[17px] text-muted">{list.length}</span>
              </h4>
              <div className="flex flex-col gap-2">
                {!list.length && <p className="m-0 text-[12px] text-muted/70">Nothing here</p>}
                {list.map((t) => (
                  <TaskCard key={t.id} task={t} onOpen={() => setOpenTask(t.id)} />
                ))}
              </div>
            </div>
          );
        })}
        {tasks.length === 0 && <p className="col-span-full p-6 text-center text-muted">No tasks on this board yet. The lead adds tasks when a board is active.</p>}
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
      className={`group w-full border-2 border-ink px-2.5 py-2 text-left transition-colors hover:border-[#3a404c] focus-visible:border-cyan ${done ? "bg-[#121419]" : "bg-[#16181d]"}`}
      onClick={onOpen}
      aria-label={`${task.id} ${task.title}: open`}
    >
      <div className="flex items-center gap-1.5 font-mono text-[11px] text-muted">
        <span>{task.id}</span>
        {task.prNumber && <span>#{task.prNumber}</span>}
        <span className="flex-1" />
        {task.usage && <TokensChip usage={task.usage} />}
      </div>
      <div className={`mt-0.5 text-[14px] font-semibold leading-snug ${done ? "text-muted" : ""}`}>{task.title}</div>
      {task.status === "blocked" && task.note && <div className="mt-0.5 line-clamp-2 text-[12px] text-red">{task.note}</div>}
      {blockedBy.length > 0 && task.status === "todo" && <div className="mt-0.5 text-[12px] text-red">Waits on {blockedBy.join(", ")}</div>}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
        {owner ? (
          <span className="flex items-center gap-1 text-[12px]">
            <Dot color={owner.color} size={8} /> {owner.name}
          </span>
        ) : (
          <span className="text-[12px] text-muted">Unassigned</span>
        )}
        <span className="flex-1" />
        {task.scores && task.scores.length > 0 && (
          <span className={failed ? "text-[#d29922]" : "text-green"} title={failed ? `${failed} check${failed === 1 ? "" : "s"} failed` : "Checks passed"}>
            {failed ? `◇ ${failed} failed` : `✓ ${task.scores.length}`}
          </span>
        )}
        {task.evidence && <span className="text-[#4fb3c4]" title={`${task.evidence.shots.length} screenshots at ${task.evidence.sha.slice(0, 7)}`}>▣ {task.evidence.shots.length}</span>}
        {task.benchmark && <span className="text-[#9085e9]" title="In the benchmark suite">◆</span>}
        {task.cli && <span className="font-mono text-muted" title="Runs on">{CLI_LABEL[task.cli]}</span>}
      </div>
    </button>
  );
}
