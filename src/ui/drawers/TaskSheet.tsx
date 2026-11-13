// The task sheet: everything about one task in one place, opened from its card on the board. The flow as a stepper
// (where the task is, what its stage needs to let it go), the brief, who's on it and what it runs on, its checks, the
// verifier's evidence and its history. The board card stays small; this is where the detail lives.

import { useEffect, useRef, useState } from "react";
import type { Gate } from "../../data/model";
import { SCORERS, type TaskScore } from "../../data/scorers";
import { benchmarkKind } from "../../data/suite";
import { AGENT_CLIS, CLI_LABEL, CLI_MODELS, cliPickerLabel, type AgentCli, type Task, type TaskStatus } from "../../data/types";
import { isViewer, officeActions, useOffice } from "../../store/office";
import { ago, Dot, TokensChip, useNow } from "../kit";

export const STATUS: Record<TaskStatus, { label: string; color: string }> = {
  todo: { label: "To do", color: "#6e7b94" },
  "in-progress": { label: "Doing", color: "#00e5ff" },
  "in-review": { label: "Review", color: "#c04dff" },
  done: { label: "Done", color: "#00ff66" },
  blocked: { label: "Blocked", color: "#ff1744" },
};

/** What a gate asks for, in words. */
export function gateText(g: Gate): string {
  switch (g.kind) {
    case "pr-merged": return "The PR is merged";
    case "tests-ci": return "Tests changed and CI green";
    case "spec-approved": return "You approve the spec";
    case "analyze": return "Every spec item has a task";
    case "reviewer": return g.roleId ? `A ${g.roleId} accepts it` : "Someone else accepts it";
    case "second-opinion": return g.when === "always" ? "A second opinion from another maker's model" : "A second opinion, when high-stakes";
    case "owner-approval": return `You approve (${g.reason})`;
    case "file-delivered": return "A deliverable and a summary";
    case "findings-report": return "The findings report is current";
    case "scope-set": return "The scope is set";
    case "evidence": return "Screenshots of the running app, for UI changes";
  }
}

const token = () => {
  try {
    return sessionStorage.getItem("hq-token") ?? "";
  } catch {
    return "";
  }
};
const withToken = (url: string) => (token() ? `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token())}` : url);

/** The URL HQ serves an evidence file at (read-only; the browser's token goes along, as for screen previews). */
export const evidenceUrl = (projectId: string, taskId: string, sha: string, file: string) =>
  withToken(`/api/projects/${encodeURIComponent(projectId)}/evidence/${encodeURIComponent(taskId)}/${sha}/${encodeURIComponent(file)}`);

interface History {
  events: { at: number; status: string; stageId: string; ownerId: string | null }[];
  gates: { at: number; gateId: string; state: string; by: string; note: string | null }[];
}

/** The task's status history and gate events from HQ; null while loading or offline (the demo has none). */
function useHistory(projectId: string, taskId: string, stamp: string): History | null {
  const [h, setH] = useState<History | null>(null);
  useEffect(() => {
    let stop = false;
    fetch(withToken(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/history`), { credentials: "same-origin" })
      .then((r) => (r.ok ? (r.json() as Promise<History>) : null))
      .then((x) => !stop && setH(x))
      .catch(() => !stop && setH(null));
    return () => {
      stop = true;
    };
  }, [projectId, taskId, stamp]);
  return h;
}

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="border-t-2 border-ink/60 px-4 py-3">
      <h3 className="m-0 mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
        {title}
        <span className="flex-1" />
        {aside}
      </h3>
      {children}
    </section>
  );
}

/** Where the task is in its flow: done stages, the current one with what it needs, the ones after. */
function Stepper({ task }: { task: Task }) {
  const flow = useOffice((s) => s.snap?.config.template?.flow);
  if (!flow?.stages.length) return null;
  const at = task.status === "done" ? flow.stages.length : Math.max(0, flow.stages.findIndex((s) => s.id === task.stageId));
  const current = flow.stages[at];
  return (
    <>
      <ol className="m-0 flex list-none items-center gap-0 p-0" aria-label="Flow">
        {flow.stages.map((s, i) => {
          const state = i < at ? "done" : i === at ? "now" : "next";
          return (
            <li key={s.id} className="flex min-w-0 flex-1 items-center" aria-current={state === "now" ? "step" : undefined}>
              <span
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-[11px] font-bold"
                style={{
                  borderColor: state === "next" ? "#3a4560" : state === "done" ? "#00c853" : "#00e5ff",
                  background: state === "done" ? "#00c853" : "transparent",
                  color: state === "done" ? "#04060a" : state === "now" ? "#00e5ff" : "#8A97B0",
                }}
              >
                {state === "done" ? "✓" : i + 1}
              </span>
              <span className={`ml-1.5 truncate text-[12px] ${state === "now" ? "font-semibold text-ink" : "text-muted"}`}>{s.name}</span>
              {i < flow.stages.length - 1 && <span className="mx-1.5 h-[2px] min-w-[8px] flex-1" style={{ background: i < at ? "#00c853" : "#3a4560" }} />}
            </li>
          );
        })}
      </ol>
      {current && current.gates.length > 0 && (
        <div className="mt-2.5 text-[12px]">
          <span className="text-muted">To leave {current.name}:</span>
          <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0">
            {current.gates.map((g) => (
              <li key={g.id} className="flex items-baseline gap-1.5">
                <span className="text-muted">○</span> {gateText(g)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function Checks({ scores }: { scores: TaskScore[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px]">
      {scores.map((x) => (
        <li key={x.scorer} className="flex items-baseline gap-2">
          <span className={x.pass ? "text-green" : "text-[#F59E0B]"} aria-label={x.pass ? "passed" : "failed"}>
            {x.pass ? "✓" : "✗"}
          </span>
          <span className="min-w-0">
            <b className="font-semibold">{SCORERS[x.scorer]?.label ?? x.scorer}</b>
            <span className="text-muted"> · {x.reason}</span>
            {x.costUsd ? <span className="ml-1 font-mono text-[11px] text-muted">${x.costUsd.toFixed(3)}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Evidence({ task, projectId }: { task: Task; projectId: string }) {
  const ev = task.evidence!;
  const head = useOffice((s) => s.snap?.pullRequests.find((p) => p.number === task.prNumber)?.headSha);
  const verifier = useOffice((s) => s.snap?.config.team.find((a) => a.id === ev.by)?.name ?? ev.by);
  const now = useNow(30_000);
  const stale = !!head && head !== ev.sha;
  return (
    <>
      <p className="m-0 mb-2 text-[12px] text-muted">
        {verifier} at <span className="font-mono">{ev.sha.slice(0, 7)}</span>, {ago(ev.at, now)} ago
        {stale && <span className="ml-1 text-[#F59E0B]">· the PR has new commits: the verifier takes it again</span>}
      </p>
      <div className="grid grid-cols-2 gap-2">
        {ev.shots.map((s) => {
          const url = evidenceUrl(projectId, task.id, ev.sha, s.file);
          const video = /\.(webm|mp4)$/.test(s.file);
          return (
            <a key={s.file} href={url} target="_blank" rel="noreferrer" className="group block border-2 border-ink bg-black" title={`${s.label}: open full size`}>
              {video ? <video src={url} className="aspect-[4/3] w-full object-cover object-top" muted controls /> : <img src={url} alt={s.label} loading="lazy" className="aspect-[4/3] w-full object-cover object-top transition-opacity group-hover:opacity-90" />}
              <span className="block truncate px-1.5 py-1 text-[11px] text-muted">{s.label}</span>
            </a>
          );
        })}
      </div>
      {ev.steps.length > 0 && (
        <ol className="m-0 mt-2 list-decimal pl-5 text-[12px] leading-snug text-muted">
          {ev.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      )}
    </>
  );
}

function Timeline({ history, name }: { history: History; name: (id: string | null) => string }) {
  const now = useNow(30_000);
  const rows = [
    ...history.events.map((e) => ({ at: e.at, dot: STATUS[e.status as TaskStatus]?.color ?? "#8A97B0", text: `${STATUS[e.status as TaskStatus]?.label ?? e.status}${e.ownerId ? ` · ${name(e.ownerId)}` : ""}` })),
    ...history.gates.map((g) => ({ at: g.at, dot: g.state === "failed" ? "#ff1744" : g.state === "passed" ? "#00c853" : "#8A97B0", text: `Gate ${g.gateId} ${g.state} by ${name(g.by)}${g.note ? `: ${g.note}` : ""}` })),
  ].sort((a, b) => b.at - a.at);
  if (!rows.length) return <p className="m-0 text-[12px] text-muted">No history: this task is older than HQ's task history.</p>;
  return (
    <ol className="m-0 flex list-none flex-col gap-1 p-0 text-[12px]">
      {rows.map((r, i) => (
        <li key={i} className="flex items-baseline gap-2">
          <span className="inline-block h-2 w-2 shrink-0 translate-y-[-1px] rounded-full" style={{ background: r.dot }} />
          <span className="min-w-0 flex-1">{r.text}</span>
          <span className="shrink-0 font-mono text-[11px] text-muted" title={new Date(r.at).toLocaleString()}>
            {ago(new Date(r.at).toISOString(), now)}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Who's on it, and (before it starts) which seat and CLI may take it. */
function People({ task }: { task: Task }) {
  const snap = useOffice((s) => s.snap);
  const owner = snap?.config.team.find((a) => a.id === task.ownerId);
  const workers = snap?.config.team.filter((a) => !a.isLead && (!task.cli || a.cli === task.cli)) ?? [];
  const limitedUntil = (id: string) => {
    const u = snap?.agents.find((s) => s.agentId === id)?.limitedUntil;
    return u && Date.parse(u) > Date.now() ? new Date(u).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  };
  const editable = task.status === "todo" && !isViewer;
  return (
    <div className="flex flex-col gap-2 text-[13px]">
      <div className="flex items-center gap-2">
        {owner ? (
          <>
            <Dot color={owner.color} size={10} /> <b>{owner.name}</b> <span className="text-muted">{owner.role}</span>
          </>
        ) : (
          <span className="text-muted">Unassigned</span>
        )}
        <span className="flex-1" />
        {task.usage && <TokensChip usage={task.usage} />}
      </div>
      {(task.cli || task.model) && !editable && (
        <div className="font-mono text-[12px] text-muted">
          runs on {task.cli ? CLI_LABEL[task.cli] : "any CLI"}
          {task.model ? ` · ${task.model}` : ""}
        </div>
      )}
      {editable && (
        <div className="grid grid-cols-1 gap-1.5 min-[480px]:grid-cols-3">
          <select className="field min-h-[40px] text-[13px]" value="" onChange={(e) => e.target.value && officeActions.assignTask(task.id, e.target.value)} aria-label={`Assign ${task.id}`}>
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
          <select className="field min-h-[40px] text-[13px]" value={task.cli ?? ""} onChange={(e) => officeActions.setTaskRunsOn(task.id, (e.target.value || null) as AgentCli | null, task.model ?? null)} aria-label={`${task.id} runs on`}>
            <option value="">Runs on: any CLI</option>
            {AGENT_CLIS.map((c) => (
              <option key={c} value={c}>
                Runs on: {cliPickerLabel(c)}
              </option>
            ))}
          </select>
          <select className="field min-h-[40px] text-[13px]" value={task.model ?? ""} disabled={!task.cli} onChange={(e) => officeActions.setTaskRunsOn(task.id, task.cli ?? null, e.target.value || null)} aria-label={`${task.id} model`}>
            <option value="">Model: agent's default</option>
            {task.cli &&
              CLI_MODELS[task.cli].map((m) => (
                <option key={m} value={m}>
                  Model: {m}
                </option>
              ))}
          </select>
        </div>
      )}
    </div>
  );
}

/** The sheet: a panel from the right (the whole screen on a phone). Esc or the backdrop closes it. */
export function TaskSheet({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const snap = useOffice((s) => s.snap);
  const task = snap?.tasks.find((t) => t.id === taskId);
  const panel = useRef<HTMLDivElement>(null);
  const projectId = snap?.config.project.id ?? "";
  const history = useHistory(projectId, taskId, `${task?.status}|${task?.stageId}`);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    window.addEventListener("keydown", onKey, true);
    panel.current?.focus();
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  if (!snap || !task) return null;
  const name = (id: string | null) => (id === "you" ? "you" : (snap.config.team.find((a) => a.id === id)?.name ?? id ?? "HQ"));
  const st = STATUS[task.status];
  const blockedBy = task.needs.filter((n) => snap.tasks.find((t) => t.id === n)?.status !== "done");
  const pr = snap.pullRequests.find((p) => p.number === task.prNumber);
  const failed = task.scores?.filter((s) => !s.pass).length ?? 0;
  const template = snap.config.template;

  return (
    <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-modal="true" aria-label={`${task.id} ${task.title}`}>
      <button className="absolute inset-0 cursor-default bg-black/55" aria-label="Close" onClick={onClose} tabIndex={-1} />
      <div ref={panel} tabIndex={-1} className="relative flex h-full w-full max-w-[600px] flex-col border-l-[3px] border-ink bg-[#0d111b] shadow-[-8px_0_24px_rgba(0,0,0,0.5)] outline-none">
        <header className="flex items-start gap-3 border-b-[3px] border-ink px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 font-mono text-[12px] text-muted">
              <span>{task.id}</span>
              {task.prNumber && (pr?.url ? <a className="underline" href={pr.url} target="_blank" rel="noreferrer">PR #{task.prNumber}</a> : <span>PR #{task.prNumber}</span>)}
              {task.templateVersion && template && <span title="The template version it ran under">{template.id} v{task.templateVersion}</span>}
            </div>
            <h2 className="m-0 mt-1 text-[19px] font-semibold leading-snug">{task.title}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="chip text-[11px]" style={{ ["--c" as string]: st.color }}>{st.label}</span>
              {failed > 0 && <span className="chip text-[11px]" style={{ ["--c" as string]: "#F59E0B" }}>{failed} check{failed === 1 ? "" : "s"} failed</span>}
              {task.evidence && <span className="chip text-[11px]" style={{ ["--c" as string]: "#26c6da" }}>evidence</span>}
              {task.benchmark && <span className="chip text-[11px]" style={{ ["--c" as string]: "#9085e9" }}>in suite</span>}
              {task.highStakes && <span className="chip text-[11px]" style={{ ["--c" as string]: "#ff5252" }}>high-stakes</span>}
            </div>
          </div>
          <button className="btn min-h-[40px] w-10 shrink-0 px-0 text-[16px]" onClick={onClose} aria-label="Close the task">
            ✕
          </button>
        </header>

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <section className="px-4 py-3">
            <Stepper task={task} />
          </section>

          {(task.status === "blocked" && task.note) || blockedBy.length > 0 ? (
            <div className="mx-4 mb-3 border-2 border-red/70 bg-red/10 px-3 py-2 text-[13px] text-red">
              {task.status === "blocked" && task.note ? task.note : `Waits on ${blockedBy.join(", ")}`}
            </div>
          ) : null}

          <Section title="Who">
            <People task={task} />
          </Section>

          {(task.description || task.doneWhen || task.files?.length || task.deliverablePath) && (
            <Section title="The brief">
              {task.description && <p className="m-0 whitespace-pre-wrap text-[13px] leading-relaxed">{task.description}</p>}
              {task.doneWhen && (
                <p className="m-0 mt-2 text-[13px]">
                  <span className="text-muted">Done when </span>
                  {task.doneWhen}
                </p>
              )}
              {(task.files?.length ?? 0) > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {task.files!.map((f) => (
                    <code key={f} className="border border-ink/70 bg-black/30 px-1.5 py-0.5 text-[11px]">{f}</code>
                  ))}
                </div>
              )}
              {task.deliverablePath && <div className="mt-2 font-mono text-[12px] text-green">↳ {task.deliverablePath}</div>}
            </Section>
          )}

          {task.note && task.status !== "blocked" && (
            <Section title="Handoff note">
              <p className="m-0 whitespace-pre-wrap text-[13px] leading-relaxed">{task.note}</p>
            </Section>
          )}

          {task.scores && task.scores.length > 0 && (
            <Section title="Checks" aside={<span className="normal-case tracking-normal">{task.scores.length - failed} of {task.scores.length} passed</span>}>
              <Checks scores={task.scores} />
            </Section>
          )}

          {task.evidence && (
            <Section title="Evidence">
              <Evidence task={task} projectId={projectId} />
            </Section>
          )}

          {history && (
            <Section title="History">
              <Timeline history={history} name={name} />
            </Section>
          )}

          {task.status === "done" && template && benchmarkKind(template) && (
            <Section title="Benchmark">
              {task.benchmark ? (
                <p className="m-0 text-[12px] text-muted">
                  In the suite. Replay it on other models from a terminal (paid, asks first):
                  <code className="mt-1 block break-all bg-black/40 px-2 py-1 text-[11px] text-ink">pnpm bench task:{task.benchmark} --run --models &lt;role&gt;=&lt;cli&gt;/&lt;model&gt;</code>
                </p>
              ) : isViewer ? null : (
                <button className="btn min-h-[40px] px-3 text-[12px]" onClick={() => officeActions.addToSuite(task.id)} title="Save this task (brief, base commit, template, checks) to ~/.arima-bench/suite so it can be replayed on other models. Free.">
                  Add to benchmark suite
                </button>
              )}
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}
