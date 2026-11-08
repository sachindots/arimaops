import { useState } from "react";
import { DEPARTMENT_META, inferDepartmentForRole } from "../../data/roles";
import { CLI_LABEL, DEPARTMENT_IDS, type DepartmentId } from "../../data/types";
import { selectTeam, useOffice, type AgentView } from "../../store/office";
import { ui, useUi } from "../../store/ui";
import { stateStyle } from "../../theme/tokens";
import { ago, DepartmentBadge, Portrait, StateChip, useNow } from "../kit";

function AgentCard({ a, focused, n, now }: { a: AgentView; focused: boolean; n: number; now: number }) {
  const snap = useOffice((s) => s.snap);
  const task = a.status.currentTaskId ? snap?.tasks.find((t) => t.id === a.status.currentTaskId) : null;
  const st = stateStyle[a.status.state];
  const needs = a.status.state === "needs-input";
  const blocked = useOffice((s) => s.snap?.sbx.agents[a.config.id]?.approvals?.length ?? 0);
  const items = useOffice((s) => (s.snap?.actionItems ?? []).filter((i) => i.status === "open" && i.fromId === a.config.id).length);
  return (
    <button
      className={`panel relative grid w-full cursor-pointer grid-cols-[40px_1fr] gap-x-2.5 gap-y-1 px-2.5 pb-2.5 pt-2 text-left transition-transform hover:-translate-x-px hover:-translate-y-px ${needs ? "outline-[3px] outline-red" : ""}`}
      style={needs ? { outlineStyle: "solid" } : undefined}
      onClick={() => ui.openAgent(a.config.id)}
      aria-label={`${a.config.name}, ${a.config.role}, ${st.label}`}
    >
      {focused && <span className="absolute -left-4 top-4 text-[14px]">▶</span>}
      <div className="row-span-2">
        <Portrait color={a.config.color} lead={a.config.isLead} />
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <b className="text-[16px] leading-tight">{a.config.name}</b>
        <DepartmentBadge role={a.config.role} isLead={a.config.isLead} department={a.config.department} compact />
        <span className="truncate text-[12px] text-muted">{a.config.role}</span>
        <span className="kbd ml-auto px-1 text-[12px] leading-none">{n}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <StateChip state={a.status.state} />
        <span className="truncate font-mono text-[10px] text-muted" title={`${CLI_LABEL[a.config.cli]} ${a.config.model || "(default)"}`}>
          {a.config.cli}:{a.config.model || "default"}
        </span>
        <span className="font-term text-[15px] text-muted">{ago(a.status.stateSince, now)}</span>
        {a.config.mode !== "sandbox" && <span className="chip text-[10px]">{a.config.mode}</span>}
        {a.status.limitedUntil && Date.parse(a.status.limitedUntil) > now && (
          <span className="chip text-[10px]" style={{ ["--c" as string]: "#ff9f1c" }} title="Its subscription hit a usage limit. HQ won't assign it work until then.">
            limit · {new Date(a.status.limitedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
        {items > 0 && (
          <span className="chip text-[10px]" style={{ ["--c" as string]: "#ff1744" }} title="Action items from this agent. Open Action items in the top bar.">
            {items} for you
          </span>
        )}
        {blocked > 0 && (
          <span className="chip text-[10px]" style={{ ["--c" as string]: "#c04dff" }} title="Requests the sandbox blocked. Open the agent to allow or dismiss them.">
            {blocked} blocked
          </span>
        )}
      </div>
      <div className={`col-span-2 mt-0.5 truncate text-[12px] ${task || needs ? "" : "text-muted"}`}>
        {needs ? (
          <span className="text-red">{a.status.note}</span>
        ) : task ? (
          <>
            <span className="mr-1 font-term text-[15px] text-muted">{task.id}</span>
            {task.title}
          </>
        ) : (
          a.status.note ?? "No task"
        )}
      </div>
    </button>
  );
}

export function TeamPanel() {
  const snap = useOffice((s) => s.snap);
  const drawer = useUi((s) => s.drawer);
  const now = useNow(1000);
  const team = selectTeam(snap);
  const needs = team.filter((a) => a.status.state === "needs-input").length;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // Group operators by Department Pod while preserving their 1..N shortcut index
  const indexedTeam = team.map((a, idx) => ({
    a,
    n: idx + 1,
    dept: inferDepartmentForRole(a.config.role, a.config.isLead, a.config.department),
  }));

  const pods = DEPARTMENT_IDS.map((deptId: DepartmentId) => ({
    meta: DEPARTMENT_META[deptId],
    members: indexedTeam.filter((x) => x.dept === deptId),
  })).filter((p) => p.members.length > 0);

  return (
    <section aria-label="Team" className="hq-team fixed bottom-[250px] left-4 top-[74px] z-10 flex w-[288px] flex-col gap-2">
      <div className="flex items-center justify-between px-1 text-[13px] font-semibold uppercase tracking-[0.12em] text-ink [text-shadow:0_2px_0_#040508]">
        <span>
          Org · {team.length} ops · {pods.length} {pods.length === 1 ? "pod" : "pods"}
          {needs > 0 && <span className="ml-2 text-red">{needs} need you</span>}
        </span>
        <button className="btn px-2 text-[11px] normal-case tracking-normal text-ink [text-shadow:none]" onClick={() => ui.openSettings("team")}>
          + Pod / Agent
        </button>
      </div>
      <div className="scroll-thin flex min-h-0 flex-col gap-2.5 overflow-y-auto pb-2 pl-4 -ml-4 pr-1">
        {pods.map(({ meta, members }) => {
          const isCollapsed = !!collapsed[meta.id];
          const workingCount = members.filter((m) => m.a.status.state === "working").length;
          return (
            <div key={meta.id} className="flex flex-col gap-1.5">
              <button
                type="button"
                onClick={() => setCollapsed((c) => ({ ...c, [meta.id]: !c[meta.id] }))}
                className="flex items-center justify-between border-2 border-ink bg-[#0a0d16]/90 px-2 py-1 text-left font-mono text-[10px] font-bold uppercase tracking-wider"
                style={{ borderLeftWidth: 4, borderLeftColor: meta.color }}
              >
                <span className="flex items-center gap-1.5">
                  <span style={{ color: meta.color }}>[{meta.short}]</span>
                  <span className="truncate text-ink">{meta.label}</span>
                </span>
                <span className="text-muted">
                  {workingCount > 0 ? <span className="text-green">{workingCount} active · </span> : null}
                  {members.length} {isCollapsed ? "▸" : "▾"}
                </span>
              </button>
              {!isCollapsed &&
                members.map(({ a, n }) => (
                  <AgentCard key={a.config.id} a={a} n={n} now={now} focused={drawer?.kind === "agent" && drawer.id === a.config.id} />
                ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

