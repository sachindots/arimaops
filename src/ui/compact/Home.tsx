// Home: what needs you first, then the work in progress, the team, and the factory numbers. One glance tells the
// owner what's theirs; everything opens the page or sheet it belongs to.

import { useState } from "react";
import type { ActionItem, Task } from "../../data/types";
import { modeOf } from "../../data/mode";
import { officeActions, selectAttention, useOffice } from "../../store/office";
import { ui } from "../../store/ui";
import { ago, Portrait, useNow } from "../kit";
import { FactoryCard } from "../command/Factory";
import { STATUS, TaskSheet } from "../drawers/TaskSheet";

const KIND: Partial<Record<NonNullable<ActionItem["kind"]>, string>> = {
  plan: "Plan",
  gate: "Approval",
  spec: "Spec",
  approval: "Lead approved",
  lesson: "Lesson",
  proposal: "Template change",
  skills: "Skills",
  memory: "Memories",
  overflow: "Usage limit",
  spend: "Spend",
  request: "Question",
};
const DECIDE = new Set(["plan", "gate", "spec", "lesson", "proposal", "skills"]);

function Section({ title, count, children, action }: { title: string; count?: number; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="m-0 flex items-baseline gap-2 text-[13px] font-semibold text-muted">
        {title}
        {count !== undefined && <span className="font-term text-[12px]">{count}</span>}
        <span className="flex-1" />
        {action}
      </h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="panel m-0 px-4 py-3 text-[13px] text-muted">{children}</p>;
}

export function Home({ onOpen }: { onOpen: (tab: "board" | "inbox" | "agents" | "chat") => void }) {
  const snap = useOffice((s) => s.snap)!;
  const now = useNow(15_000);
  const [sheet, setSheet] = useState<string | null>(null);
  const att = selectAttention(snap);
  const name = (id: string) => snap.config.team.find((a) => a.id === id)?.name ?? (id === "hq" ? "HQ" : id);
  const active: Task[] = snap.tasks.filter((t) => t.status === "in-progress" || t.status === "in-review" || t.status === "blocked");
  const others = att.asking.length + att.access.length + att.blocked.length + att.readyPrs.length;

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[960px] flex-col gap-6 px-4 py-5">
        <Section title="Needs you" count={att.total} action={att.total > 0 ? <button className="text-[12px] text-blue hover:underline" onClick={() => onOpen("inbox")}>Open inbox</button> : undefined}>
          {att.total === 0 ? (
            <Empty>Nothing waits on you. The team carries on.</Empty>
          ) : (
            <ul className="panel m-0 flex list-none flex-col divide-y divide-[#262a33] p-0">
              {att.items.slice(0, 6).map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3">
                  <span className="chip text-[11px]" style={{ ["--c" as string]: i.waiting ? "#d29922" : "#818cf8" }}>{KIND[i.kind ?? "request"] ?? "Request"}</span>
                  <button className="min-w-0 flex-1 truncate text-left text-[14px] font-medium hover:underline" onClick={() => onOpen("inbox")} title={i.title}>
                    {i.title}
                  </button>
                  <span className="text-[12px] text-muted">{name(i.fromId)} · {ago(i.at, now)}</span>
                  {DECIDE.has(i.kind ?? "") && (
                    <span className="flex gap-1.5">
                      <button className="btn btn-primary min-h-[32px] px-3 text-[12px]" onClick={() => officeActions.resolveActionItem(i.id, "done")}>
                        Approve
                      </button>
                      <button className="btn min-h-[32px] px-3 text-[12px]" onClick={() => onOpen("inbox")}>
                        Review
                      </button>
                    </span>
                  )}
                </li>
              ))}
              {att.items.length > 6 && <li className="px-4 py-2 text-[12px] text-muted">and {att.items.length - 6} more in the inbox</li>}
              {others > 0 && (
                <li className="px-4 py-2.5 text-[13px]">
                  <button className="text-left hover:underline" onClick={() => onOpen("inbox")}>
                    {[
                      att.asking.length && `${att.asking.length} agent${att.asking.length === 1 ? "" : "s"} asking in the terminal`,
                      att.access.length && `${att.access.length} access request${att.access.length === 1 ? "" : "s"}`,
                      att.blocked.length && `${att.blocked.length} sandbox block${att.blocked.length === 1 ? "" : "s"}`,
                      att.readyPrs.length && `${att.readyPrs.length} PR${att.readyPrs.length === 1 ? "" : "s"} ready to merge`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </button>
                </li>
              )}
            </ul>
          )}
        </Section>

        <Section title="In progress" count={active.length} action={<button className="text-[12px] text-blue hover:underline" onClick={() => onOpen("board")}>Open board</button>}>
          {active.length === 0 ? (
            <Empty>No task in progress. The lead picks up work from active boards.</Empty>
          ) : (
            <ul className="panel m-0 flex list-none flex-col divide-y divide-[#262a33] p-0">
              {active.map((t) => {
                const owner = snap.config.team.find((a) => a.id === t.ownerId);
                const stage = snap.config.template?.flow.stages.find((s) => s.id === t.stageId);
                return (
                  <li key={t.id}>
                    <button className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-white/[0.02]" onClick={() => setSheet(t.id)}>
                      <span className="w-[64px] shrink-0 font-term text-[12px] text-muted">{t.id}</span>
                      <span className="min-w-0 flex-1 truncate text-[14px]">{t.title}</span>
                      {stage && <span className="hidden text-[12px] text-muted min-[560px]:inline">{stage.name}</span>}
                      <span className="chip text-[11px]" style={{ ["--c" as string]: STATUS[t.status].color }}>{STATUS[t.status].label}</span>
                      {owner && <Portrait name={owner.name} color={owner.color} lead={owner.isLead} size={22} />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section title="Team" count={snap.config.team.length} action={<button className="text-[12px] text-blue hover:underline" onClick={() => onOpen("agents")}>Manage</button>}>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
            {snap.config.team.map((a) => {
              const st = snap.agents.find((s) => s.agentId === a.id);
              const mode = modeOf(st, now);
              const label = { working: "Working", cheer: "Working", idle: "Idle", "needs-input": "Needs you", alert: "Problem", stopped: "Stopped", starting: "Starting" }[mode];
              const color = { working: "#3fb950", cheer: "#3fb950", idle: "#8b919c", "needs-input": "#d29922", alert: "#f85149", stopped: "#4b5160", starting: "#818cf8" }[mode];
              const task = st?.currentTaskId;
              return (
                <button key={a.id} className="panel flex items-center gap-3 px-3 py-2.5 text-left hover:border-[#3a404c]" onClick={() => ui.openAgent(a.id)}>
                  <Portrait name={a.name} color={a.color} lead={a.isLead} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <b className="truncate text-[14px] font-semibold">{a.name}</b>
                      <span className="truncate text-[12px] text-muted">{a.role}</span>
                    </span>
                    <span className="flex items-center gap-1.5 text-[12px]">
                      <i className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                      <span style={{ color: mode === "stopped" ? "#8b919c" : color }}>{label}</span>
                      {task && <span className="truncate font-term text-muted">· {task}</span>}
                    </span>
                  </span>
                  <span className="hidden font-term text-[11px] text-muted min-[700px]:inline" title={`${a.cli}${a.model ? ` · ${a.model}` : ""}`}>{a.cli}</span>
                </button>
              );
            })}
          </div>
        </Section>

        <FactoryCard projects={[{ id: snap.config.project.id, name: snap.config.project.name }]} live={useOffice.getState().live} />
      </div>
      {sheet && <TaskSheet taskId={sheet} onClose={() => setSheet(null)} />}
    </div>
  );
}
