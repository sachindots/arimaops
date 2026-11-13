import { useState } from "react";
import { AGENT_CLIS, CLI_LABEL, CLI_MODELS, type AgentCli, type BoardStatus, type Task, type TaskStatus, cliPickerLabel } from "../../data/types";
import { isViewer, officeActions, useOffice } from "../../store/office";
import { benchmarkKind } from "../../data/suite";
import { Dot, TokensChip } from "../kit";
import { DrawerHeader } from "./Drawer";
import { SCORERS, type TaskScore } from "../../data/scorers";

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

/** The scorers' verdicts on a finished task: a count, and each failed check with why. Signals, never blockers. */
function Checks({ scores }: { scores: TaskScore[] }) {
  const failed = scores.filter((x) => !x.pass);
  const cost = scores.reduce((t, x) => t + (x.costUsd ?? 0), 0);
  return (
    <div className="mt-1 text-[12px]" title={scores.map((x) => `${x.pass ? "✓" : "✗"} ${SCORERS[x.scorer]?.label ?? x.scorer}: ${x.reason}`).join("\n")}>
      <span className={failed.length ? "text-[#F59E0B]" : "text-green"}>
        {failed.length ? "◇" : "✓"} Checks {scores.length - failed.length}/{scores.length}
      </span>
      {cost > 0 && <span className="ml-1.5 font-mono text-[11px] text-muted">${cost.toFixed(3)}</span>}
      {failed.map((x) => (
        <div key={x.scorer} className="leading-tight text-[#F59E0B]">
          ✗ {SCORERS[x.scorer]?.label ?? x.scorer}: <span className="text-muted">{x.reason}</span>
        </div>
      ))}
    </div>
  );
}

/** The URL HQ serves an evidence file at (read-only; the browser's token goes along, as for screen previews). */
function evidenceUrl(projectId: string, taskId: string, sha: string, file: string): string {
  let tok = "";
  try {
    tok = sessionStorage.getItem("hq-token") ?? "";
  } catch {
    /* private window */
  }
  return `/api/projects/${encodeURIComponent(projectId)}/evidence/${encodeURIComponent(taskId)}/${sha}/${encodeURIComponent(file)}${tok ? `?token=${encodeURIComponent(tok)}` : ""}`;
}

/** The verifier's screenshots of the running app for the task's PR: thumbnails that open full size, and its steps. */
function Evidence({ task }: { task: Task }) {
  const ev = task.evidence!;
  const projectId = useOffice((s) => s.snap?.config.project.id ?? "");
  const head = useOffice((s) => s.snap?.pullRequests.find((p) => p.number === task.prNumber)?.headSha);
  const verifier = useOffice((s) => s.snap?.config.team.find((a) => a.id === ev.by)?.name ?? ev.by);
  const [open, setOpen] = useState(false);
  const stale = !!head && head !== ev.sha;
  return (
    <div className="mt-1 text-[12px]">
      <button className="flex w-full items-center gap-1.5 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={stale ? "text-[#F59E0B]" : "text-green"}>▣ Evidence</span>
        <span className="font-mono text-[11px] text-muted">
          {ev.shots.length} · {ev.sha.slice(0, 7)} · {verifier}
        </span>
        <span className="flex-1" />
        <span className="text-muted">{open ? "▾" : "▸"}</span>
      </button>
      {stale && <div className="leading-tight text-[#F59E0B]">New commits since: the verifier takes it again.</div>}
      <div className="mt-1 grid grid-cols-2 gap-1">
        {(open ? ev.shots : ev.shots.slice(0, 2)).map((s) => {
          const url = evidenceUrl(projectId, task.id, ev.sha, s.file);
          const video = /\.(webm|mp4)$/.test(s.file);
          return (
            <a key={s.file} href={url} target="_blank" rel="noreferrer" className="block border border-ink bg-black" title={`${s.label}: open full size`}>
              {video ? <video src={url} className="aspect-[4/3] w-full object-cover object-top" muted /> : <img src={url} alt={s.label} loading="lazy" className="aspect-[4/3] w-full object-cover object-top" />}
              <span className="block truncate px-1 py-0.5 text-[10px] text-muted">{s.label}</span>
            </a>
          );
        })}
      </div>
      {!open && ev.shots.length > 2 && <div className="text-[11px] text-muted">+{ev.shots.length - 2} more</div>}
      {open && ev.steps.length > 0 && (
        <ol className="m-0 mt-1 list-decimal pl-4 leading-snug text-muted">
          {ev.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** A finished Dev or Research task can join the benchmark suite, to be replayed on other models from a terminal. */
function SuiteButton({ task }: { task: Task }) {
  const template = useOffice((s) => s.snap?.config.template);
  if (task.benchmark)
    return (
      <div className="mt-1 truncate font-mono text-[11px] text-muted" title={`Replay it from a terminal (paid, asks first):\npnpm bench task:${task.benchmark} --run --models <role>=<cli>/<model>`}>
        ◆ in the benchmark suite
      </div>
    );
  if (isViewer || !template || !benchmarkKind(template)) return null;
  return (
    <button
      className="btn mt-1 min-h-[32px] px-2 text-[11px]"
      onClick={() => officeActions.addToSuite(task.id)}
      aria-label={`Add ${task.id} to the benchmark suite`}
      title="Save this task (brief, base commit, template, checks) to ~/.arima-bench/suite so it can be replayed on other models. Free."
    >
      Add to benchmark suite
    </button>
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
      {task.scores && task.scores.length > 0 && <Checks scores={task.scores} />}
      {task.evidence && <Evidence task={task} />}
      {task.status === "done" && <SuiteButton task={task} />}
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
