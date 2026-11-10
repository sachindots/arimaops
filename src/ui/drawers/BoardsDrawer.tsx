import { useState } from "react";
import { AGENT_CLIS, CLI_LABEL, CLI_MODELS, type AgentCli, type BoardStatus, type Task, type TaskStatus, cliPickerLabel } from "../../data/types";
import { officeActions, useOffice } from "../../store/office";
import { Dot, TokensChip } from "../kit";
import { DrawerHeader } from "./Drawer";

const COLUMNS: { id: TaskStatus; label: string; color: string }[] = [
  { id: "todo", label: "To do", color: "#6e7b94" },
  { id: "in-progress", label: "Doing", color: "#00e5ff" },
  { id: "in-review", label: "Review", color: "#c04dff" },
  { id: "done", label: "Done", color: "#00ff66" },
  { id: "blocked", label: "Blocked", color: "#ff1744" },
];

const STATUS_LABEL: Record<BoardStatus, string> = { active: "Active", planned: "Planned", done: "Done" };

export function BoardsDrawer({ initialBoardId }: { initialBoardId?: string }) {
  const snap = useOffice((s) => s.snap);
  const boards = [...(snap?.boards ?? [])].sort((a, b) => a.order - b.order);
  const [boardId, setBoardId] = useState(initialBoardId ?? boards.find((b) => b.status === "active")?.id ?? boards[0]?.id);
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
      <div className="flex flex-wrap gap-1.5 border-b-[3px] border-ink px-3 py-2">
        {boards.map((b) => (
          <button key={b.id} className="btn px-2 text-[13px]" aria-pressed={b.id === boardId} onClick={() => setBoardId(b.id)}>
            {b.status === "active" && <span className="mr-1 text-green">●</span>}
            {b.title}
          </button>
        ))}
      </div>
      {board && (
        <div className="flex items-center gap-2 border-b-[3px] border-ink bg-cream-2 px-3 py-1.5 text-[14px]">
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
      <div className="scroll-thin grid min-h-0 flex-1 snap-x auto-cols-[minmax(200px,1fr)] grid-flow-col gap-2 overflow-auto bg-[#07090e] p-3 max-[560px]:snap-mandatory max-[560px]:auto-cols-[86%]">
        {cols.map((c) => {
          const list = tasks.filter((t) => t.status === c.id);
          if (c.id === "done") list.reverse();
          return (
            <div key={c.id} className="min-w-0 snap-start">
              <h4 className="mb-2 flex justify-between border-b-[3px] pb-0.5 text-[14px] font-semibold" style={{ borderColor: c.color }}>
                {c.label} <span className="font-term text-[17px] text-muted">{list.length}</span>
              </h4>
              <div className="flex flex-col gap-2">
                {list.map((t) => (
                  <TaskCard key={t.id} task={t} />
                ))}
              </div>
            </div>
          );
        })}
        {tasks.length === 0 && <p className="col-span-full p-6 text-center text-muted">No tasks on this board yet. The lead adds tasks when a board is active.</p>}
      </div>
    </>
  );
}

function TaskCard({ task }: { task: Task }) {
  const snap = useOffice((s) => s.snap);
  const owner = snap?.config.team.find((a) => a.id === task.ownerId);
  const limitedUntil = (id: string) => {
    const u = snap?.agents.find((s) => s.agentId === id)?.limitedUntil;
    return u && Date.parse(u) > Date.now() ? new Date(u).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  };
  // Only agents on the task's CLI can take it; limited ones are listed but disabled.
  const workers = snap?.config.team.filter((a) => !a.isLead && (!task.cli || a.cli === task.cli)) ?? [];
  const blockedBy = task.needs.filter((n) => snap?.tasks.find((t) => t.id === n)?.status !== "done");
  return (
    <div className={`border border-ink px-2 py-1.5 shadow-[0_3px_0_rgba(0,0,0,0.6)] ${task.status === "done" ? "bg-[#0a0d14] text-muted" : "bg-[#111520]"}`}>
      <div className="font-term text-[16px] leading-none text-muted">
        {task.id}
        {task.prNumber && <span className="ml-1.5">#{task.prNumber}</span>}
        {task.usage && <span className="ml-1.5"><TokensChip usage={task.usage} /></span>}
      </div>
      <div
        className={`text-[14px] font-semibold leading-tight ${task.status === "done" ? "line-through" : ""}`}
        title={[task.description, task.files?.length ? `Files: ${task.files.join(", ")}` : "", task.doneWhen ? `Done when: ${task.doneWhen}` : ""].filter(Boolean).join("\n\n") || undefined}
      >
        {task.title}
      </div>
      {task.deliverablePath && <div className="mt-0.5 truncate font-term text-[14px] text-green">↳ {task.deliverablePath}</div>}
      {task.status === "blocked" && task.note && <div className="text-[12px] text-red">{task.note}</div>}
      <div className="mt-1 flex items-center gap-1.5 text-[12px]">
        {owner ? (
          <>
            <Dot color={owner.color} size={8} /> {owner.name}
          </>
        ) : (
          <span className="text-muted">Unassigned</span>
        )}
      </div>
      {blockedBy.length > 0 && task.status === "todo" && <div className="text-[12px] text-red">Waits on {blockedBy.join(", ")}</div>}
      {(task.cli || task.model) && (
        <div className="mt-0.5 font-mono text-[11px] text-muted" title="Runs on: only an agent with this CLI can take the task">
          runs on {task.cli ? CLI_LABEL[task.cli] : "any CLI"}
          {task.model ? ` · ${task.model}` : ""}
        </div>
      )}
      {task.status === "todo" && (
        <select
          className="field mt-1 py-0 text-[12px]"
          value={task.cli ?? ""}
          onChange={(e) => officeActions.setTaskRunsOn(task.id, (e.target.value || null) as AgentCli | null, task.model ?? null)}
          aria-label={`${task.id} runs on`}
        >
          <option value="">Runs on: any CLI</option>
          {AGENT_CLIS.map((c) => (
            <option key={c} value={c}>
              Runs on: {cliPickerLabel(c)}
            </option>
          ))}
        </select>
      )}
      {task.status === "todo" && task.cli && (
        <select
          className="field mt-1 py-0 text-[12px]"
          value={task.model ?? ""}
          onChange={(e) => officeActions.setTaskRunsOn(task.id, task.cli ?? null, e.target.value || null)}
          aria-label={`${task.id} model`}
        >
          <option value="">Model: agent's default</option>
          {CLI_MODELS[task.cli].map((m) => (
            <option key={m} value={m}>
              Model: {m}
            </option>
          ))}
        </select>
      )}
      {task.status === "todo" && (
        <select
          className="field mt-1 py-0 text-[12px]"
          value=""
          onChange={(e) => e.target.value && officeActions.assignTask(task.id, e.target.value)}
          aria-label={`Assign ${task.id}`}
        >
          <option value="">Assign to…</option>
          {workers.map((a) => {
            const limit = limitedUntil(a.id);
            return (
              <option key={a.id} value={a.id} disabled={!!limit}>
                {a.name} ({a.role}, {a.cli}){limit ? ` · limited until ${limit}` : ""}
              </option>
            );
          })}
        </select>
      )}
    </div>
  );
}
