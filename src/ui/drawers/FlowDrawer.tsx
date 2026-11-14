// The project's flow as a canvas (ROADMAP 5.2): stages left to right, each with the roles that work it,
// its gates and the tasks in it now. Edited on desktop and tablet; phones and viewers only look.

import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { APPROVAL_REASONS, GATE_KINDS, templateErrors, type Gate, type GateKind, type Role, type Stage, type TeamTemplate } from "../../data/model";
import type { Task } from "../../data/types";
import { isViewer, officeActions, useOffice } from "../../store/office";
import { Dot } from "../kit";
import { DrawerHeader } from "./Drawer";
import { gateText } from "./TaskSheet";

const GATE_NAME: Record<GateKind, string> = {
  "pr-merged": "PR merged",
  "tests-ci": "Tests and green CI",
  "spec-approved": "Spec approved",
  analyze: "Tasks cover the spec",
  reviewer: "Reviewer accepts",
  "second-opinion": "Second opinion",
  "owner-approval": "You approve",
  "file-delivered": "File delivered",
  "findings-report": "Findings report",
  "scope-set": "Scope set",
  evidence: "Screenshots of the app",
};

const NODE_W = 250;
const GAP = 70;
const ROW_H = 230;

type StageData = { stage: Stage; index: number; roles: Role[]; tasks: Task[]; selected: boolean };

function StageNode({ data }: NodeProps<Node<StageData>>) {
  const { stage, index, roles, tasks, selected } = data;
  const busy = tasks.filter((t) => t.status === "in-progress" || t.status === "in-review").length;
  return (
    <div
      className="hud-glass hud-corners w-[250px] rounded-2xl px-3.5 py-3 text-left transition-shadow"
      style={selected ? { ["--corner" as string]: "#00f0ff", borderColor: "rgba(0,240,255,0.7)", boxShadow: "0 0 0 1px #00f0ff, 0 0 26px rgba(0,240,255,0.28)" } : undefined}
    >
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-accent/60 !opacity-0" isConnectable={false} />
      <Handle id="up" type="target" position={Position.Top} className="!h-1.5 !w-1.5 !border-0 !bg-accent/60 !opacity-0" isConnectable={false} />
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent/15 font-display text-[12px] font-semibold text-accent">{index + 1}</span>
        <b className="min-w-0 flex-1 truncate font-display text-[17px] font-semibold text-ink">{stage.name || stage.id}</b>
        {tasks.length > 0 && (
          <span className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-muted" title={`${tasks.length} open task${tasks.length === 1 ? "" : "s"} in this stage`}>
            {busy > 0 && <i className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-green align-middle shadow-[0_0_6px_#3fb950]" />}
            {tasks.length}
          </span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {roles.map((r) => (
          <span key={r.id} className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]" style={{ color: r.color, borderColor: `${r.color}55`, background: `${r.color}14` }}>
            {r.title}
          </span>
        ))}
        {!roles.length && <span className="text-[12px] text-red">No roles</span>}
      </div>
      <ul className="m-0 mt-2.5 flex list-none flex-col gap-1 border-t border-white/[0.07] p-0 pt-2">
        {stage.gates.map((g) => (
          <li key={g.id} className="flex items-start gap-1.5 text-[12px] text-ink/90" title={gateText(g)}>
            <span className="mt-[3px] h-2 w-2 shrink-0 rotate-45 border border-accent/70" aria-hidden />
            <span className="min-w-0">{GATE_NAME[g.kind]}</span>
          </li>
        ))}
        {!stage.gates.length && <li className="text-[12px] text-muted">No gate: tasks move on when done</li>}
      </ul>
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-0 !bg-accent/60 !opacity-0" isConnectable={false} />
      <Handle id="down" type="source" position={Position.Bottom} className="!h-1.5 !w-1.5 !border-0 !bg-accent/60 !opacity-0" isConnectable={false} />
    </div>
  );
}

const nodeTypes = { stage: StageNode };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "stage";
const uniqueId = (base: string, taken: string[]) => {
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
};

function newGate(kind: GateKind, taken: string[]): Gate {
  const id = uniqueId(kind, taken);
  if (kind === "second-opinion") return { id, kind, when: "high-stakes" };
  if (kind === "owner-approval") return { id, kind, reason: "merge" };
  return { id, kind } as Gate;
}

/** Phones only look: the canvas is too small to edit on. */
function usePhone() {
  const q = "(max-width: 639px)";
  const [phone, setPhone] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setPhone(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return phone;
}

export function FlowDrawer() {
  const saved = useOffice((s) => s.snap?.config.template ?? null);
  const tasks = useOffice((s) => s.snap?.tasks ?? []);
  const phone = usePhone();
  const canEdit = !isViewer && !phone;
  const [draft, setDraft] = useState<TeamTemplate | null>(saved);
  const [selected, setSelected] = useState<string | null>(saved?.flow.stages[0]?.id ?? null);
  // Stages wrap into rows that fit the canvas, so it opens at a readable size instead of zoomed out.
  const box = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(4);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCols(Math.max(1, Math.floor((el.clientWidth - 48 + GAP) / (NODE_W + GAP)))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [saved]);

  // A save (or a change from elsewhere) resets the draft while nothing is being edited.
  const dirty = !!draft && !!saved && JSON.stringify(draft.flow) !== JSON.stringify(saved.flow);
  useEffect(() => {
    if (!dirty) setDraft(saved);
  }, [saved]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = useMemo(() => tasks.filter((t) => t.status !== "done"), [tasks]);
  const stages = draft?.flow.stages ?? [];
  const roles = draft?.roles ?? [];
  const errors = draft && dirty ? templateErrors(draft) : [];

  const nodes: Node<StageData>[] = stages.map((stage, index) => ({
    id: stage.id,
    type: "stage",
    position: { x: (index % cols) * (NODE_W + GAP), y: Math.floor(index / cols) * ROW_H },
    draggable: false,
    data: { stage, index, roles: roles.filter((r) => stage.roleIds.includes(r.id)), tasks: open.filter((t) => t.stageId === stage.id), selected: stage.id === selected },
  }));
  const edges: Edge[] = stages.slice(1).map((s, i) => ({
    id: `${stages[i].id}->${s.id}`,
    source: stages[i].id,
    target: s.id,
    type: "smoothstep",
    animated: open.some((t) => t.stageId === s.id),
    // A row's last stage hands down to the next row's first.
    sourceHandle: (i + 1) % cols === 0 ? "down" : undefined,
    targetHandle: (i + 1) % cols === 0 ? "up" : undefined,
    style: { stroke: "rgba(0,240,255,0.55)", strokeWidth: 1.5 },
  }));

  if (!saved || !draft)
    return (
      <>
        <DrawerHeader>
          <b className="font-display text-[19px] font-semibold">Flow</b>
        </DrawerHeader>
        <p className="p-4 text-[14px] text-muted">This project was made before templates, so it has no flow. New projects get one from their team template.</p>
      </>
    );

  // Always from the latest draft: two edits in one moment (a blur and a pick) must both land.
  const setStages = (f: (all: Stage[]) => Stage[]) => setDraft((d) => d && { ...d, flow: { stages: f(d.flow.stages) } });
  const patchStage = (id: string, f: (s: Stage) => Partial<Stage>) => setStages((all) => all.map((s) => (s.id === id ? { ...s, ...f(s) } : s)));
  const allGateIds = stages.flatMap((s) => s.gates.map((g) => g.id));
  const cur = stages.find((s) => s.id === selected) ?? null;
  const curIndex = cur ? stages.indexOf(cur) : -1;
  const tasksIn = (id: string) => open.filter((t) => t.stageId === id).length;
  const placed = open.filter((t) => t.stageId).length;

  const addStage = () => {
    const id = uniqueId("stage", stages.map((s) => s.id));
    const lead = roles.find((r) => r.isLead)?.id;
    const at = curIndex >= 0 ? curIndex + 1 : stages.length;
    setStages((all) => [...all.slice(0, at), { id, name: "New stage", roleIds: lead ? [lead] : [], gates: [] }, ...all.slice(at)]);
    setSelected(id);
  };
  const move = (d: -1 | 1) => {
    if (!cur) return;
    setStages((all) => {
      const next = all.filter((s) => s.id !== cur.id);
      next.splice(curIndex + d, 0, all[curIndex]);
      return next;
    });
  };
  const remove = () => {
    if (!cur) return;
    setStages((all) => all.filter((s) => s.id !== cur.id));
    setSelected(stages[curIndex - 1]?.id ?? stages[curIndex + 1]?.id ?? null);
  };
  // New stages take their id from their name when saved; saved ones keep theirs (tasks point at it).
  const save = () => {
    const known = new Set(saved.flow.stages.map((s) => s.id));
    const ids = stages.filter((s) => known.has(s.id)).map((s) => s.id);
    const named = stages.map((s) => {
      if (known.has(s.id)) return s;
      const id = uniqueId(slug(s.name), ids);
      ids.push(id);
      return { ...s, id };
    });
    const t = { ...draft, flow: { stages: named } };
    officeActions.updateProjectTemplate(t);
    setDraft(t);
    if (cur && !known.has(cur.id)) setSelected(named[curIndex].id);
  };

  return (
    <>
      <DrawerHeader>
        <b className="font-display text-[19px] font-semibold">Flow</b>
        <span className="truncate text-[14px] text-muted">
          {saved.name} v{saved.version} · {stages.length} stage{stages.length === 1 ? "" : "s"} · {placed} open task{placed === 1 ? "" : "s"}
        </span>
        {canEdit && (
          <span className="ml-auto flex items-center gap-2">
            <button className="btn px-3 text-[13px]" onClick={addStage}>
              + Stage
            </button>
            {dirty && (
              <button className="btn px-3 text-[13px]" onClick={() => setDraft(saved)}>
                Discard
              </button>
            )}
            <button className="btn btn-primary px-3 text-[13px]" disabled={!dirty || errors.length > 0} onClick={save} title={errors[0]}>
              Save flow
            </button>
          </span>
        )}
      </DrawerHeader>
      {!canEdit && (
        <p className="m-0 border-b border-white/[0.06] px-4 py-1.5 text-[12px] text-muted">{isViewer ? "View only: this link can't change the flow." : "View only on a phone. Edit the flow on a tablet or computer."}</p>
      )}
      {errors.length > 0 && (
        <ul className="m-0 list-none border-b border-red/30 bg-red/[0.08] px-4 py-2 text-[13px] text-red">
          {errors.slice(0, 3).map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <div className="flex min-h-0 flex-1 max-[900px]:flex-col">
        <div ref={box} className="relative min-h-[300px] min-w-0 flex-1 max-[640px]:min-h-[55vh]">
          <ReactFlow
            key={cols}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            colorMode="dark"
            fitView
            fitViewOptions={{ padding: 0.15, maxZoom: 1.15, minZoom: 0.8 }}
            minZoom={0.3}
            maxZoom={1.6}
            nodesConnectable={false}
            nodesDraggable={false}
            onNodeClick={(_, n) => setSelected(n.id)}
            proOptions={{ hideAttribution: true }}
            aria-label="Flow stages"
          >
            <Background gap={24} size={1} color="rgba(0,240,255,0.12)" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        {cur && (
          <aside className="scroll-thin flex w-[340px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-white/[0.08] p-4 max-[900px]:max-h-[45%] max-[900px]:w-full max-[900px]:border-l-0 max-[900px]:border-t" aria-label={`Stage ${cur.name}`}>
            <div className="flex items-center gap-2">
              <span className="font-display text-[13px] text-muted">Stage {curIndex + 1}</span>
              {canEdit && (
                <span className="ml-auto flex gap-1">
                  <button className="btn px-2 text-[12px]" disabled={curIndex === 0} onClick={() => move(-1)} aria-label="Move earlier">
                    ←
                  </button>
                  <button className="btn px-2 text-[12px]" disabled={curIndex === stages.length - 1} onClick={() => move(1)} aria-label="Move later">
                    →
                  </button>
                  <button
                    className="btn px-2 text-[12px] text-red"
                    disabled={stages.length === 1 || tasksIn(cur.id) > 0}
                    title={tasksIn(cur.id) ? "Tasks are in this stage: move them first" : stages.length === 1 ? "A flow needs one stage" : "Remove this stage"}
                    onClick={remove}
                  >
                    Remove
                  </button>
                </span>
              )}
            </div>

            <label className="flex flex-col gap-1 text-[13px] text-muted">
              Name
              <input
                className="field"
                value={cur.name}
                disabled={!canEdit}
                onChange={(e) => patchStage(cur.id, () => ({ name: e.target.value }))}
              />
            </label>

            <div>
              <div className="mb-1.5 text-[13px] text-muted">Who works it</div>
              <div className="flex flex-wrap gap-1.5">
                {roles.map((r) => {
                  const on = cur.roleIds.includes(r.id);
                  return (
                    <button
                      key={r.id}
                      className="btn flex items-center gap-1.5 px-2 text-[12px]"
                      aria-pressed={on}
                      disabled={!canEdit}
                      onClick={() => patchStage(cur.id, (s) => ({ roleIds: on ? s.roleIds.filter((x) => x !== r.id) : [...s.roleIds, r.id] }))}
                    >
                      <Dot color={r.color} size={8} />
                      {r.title}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="mb-1.5 text-[13px] text-muted">Gates · all must pass before a task leaves</div>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {cur.gates.map((g) => {
                  const set = (patch: Partial<Gate>) => patchStage(cur.id, (s) => ({ gates: s.gates.map((x) => (x.id === g.id ? ({ ...x, ...patch } as Gate) : x)) }));
                  return (
                    <li key={g.id} className="rounded-xl border border-white/10 bg-navy/50 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <b className="flex-1 text-[13px] font-semibold">{GATE_NAME[g.kind]}</b>
                        {canEdit && (
                          <button className="text-[12px] text-muted hover:text-red" aria-label={`Remove gate ${GATE_NAME[g.kind]}`} onClick={() => patchStage(cur.id, (s) => ({ gates: s.gates.filter((x) => x.id !== g.id) }))}>
                            ✕
                          </button>
                        )}
                      </div>
                      <div className="text-[12px] text-muted">{gateText(g)}</div>
                      {g.kind === "reviewer" && (
                        <select className="field mt-1.5 h-8 w-full py-0 text-[12px]" disabled={!canEdit} value={g.roleId ?? ""} onChange={(e) => set({ roleId: e.target.value || undefined } as Partial<Gate>)} aria-label="Reviewer role">
                          <option value="">Anyone but the task's owner</option>
                          {roles.map((r) => (
                            <option key={r.id} value={r.id}>
                              A {r.title}
                            </option>
                          ))}
                        </select>
                      )}
                      {g.kind === "second-opinion" && (
                        <select className="field mt-1.5 h-8 w-full py-0 text-[12px]" disabled={!canEdit} value={g.when} onChange={(e) => set({ when: e.target.value } as Partial<Gate>)} aria-label="When">
                          <option value="high-stakes">Only for high-stakes tasks</option>
                          <option value="always">Always</option>
                        </select>
                      )}
                      {g.kind === "owner-approval" && (
                        <select className="field mt-1.5 h-8 w-full py-0 text-[12px]" disabled={!canEdit} value={g.reason} onChange={(e) => set({ reason: e.target.value } as Partial<Gate>)} aria-label="What you approve">
                          {APPROVAL_REASONS.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      )}
                    </li>
                  );
                })}
              </ul>
              {canEdit && (
                <select
                  className="field mt-2 h-8 w-full py-0 text-[12px]"
                  value=""
                  aria-label="Add a gate"
                  onChange={(e) => e.target.value && patchStage(cur.id, (s) => ({ gates: [...s.gates, newGate(e.target.value as GateKind, allGateIds)] }))}
                >
                  <option value="">+ Add a gate…</option>
                  {GATE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {GATE_NAME[k]}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <p className="m-0 text-[12px] text-muted">
              {tasksIn(cur.id)} open task{tasksIn(cur.id) === 1 ? "" : "s"} here. Changes reach running agents at their next start.
            </p>
          </aside>
        )}
      </div>
    </>
  );
}
