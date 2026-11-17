// The project's flow as a pipeline: stages in one row, left to right, each with the roles that work it, its gates
// and the tasks in it now. Click a stage to edit it in a slide-over; drag stages to reorder. Edited on desktop and
// tablet; phones and viewers only look.

import { useEffect, useMemo, useState } from "react";
import { APPROVAL_REASONS, GATE_KINDS, templateErrors, type Gate, type GateKind, type Stage, type TeamTemplate } from "../../data/model";
import { isViewer, officeActions, useOffice } from "../../store/office";
import { ui } from "../../store/ui";
import { Icon } from "../deck/Icon";
import { Dot } from "../kit";
import { DrawerHeader, PageTitle } from "./Drawer";
import { SlideOver } from "./SlideOver";
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
  const [selected, setSelected] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  // A save (or a change from elsewhere) resets the draft while nothing is being edited.
  const dirty = !!draft && !!saved && JSON.stringify(draft.flow) !== JSON.stringify(saved.flow);
  useEffect(() => {
    if (!dirty) setDraft(saved);
  }, [saved]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = useMemo(() => tasks.filter((t) => t.status !== "done"), [tasks]);
  const stages = draft?.flow.stages ?? [];
  const roles = draft?.roles ?? [];
  const errors = draft && dirty ? templateErrors(draft) : [];

  if (!saved || !draft)
    return (
      <>
        <DrawerHeader>
          <PageTitle title="Flow" />
        </DrawerHeader>
        <p className="p-4 text-[13px] text-muted">This project was made before templates, so it has no flow. New projects get one from their team template.</p>
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
  /** Drag and drop: put `id` where `onto` is. */
  const drop = (id: string, onto: string) => {
    if (id === onto) return;
    setStages((all) => {
      const from = all.findIndex((x) => x.id === id);
      const to = all.findIndex((x) => x.id === onto);
      const next = all.filter((x) => x.id !== id);
      next.splice(to, 0, all[from]);
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
        <PageTitle title="Flow" context={<>{saved.name} v{saved.version} · {stages.length} stage{stages.length === 1 ? "" : "s"} · {placed} open task{placed === 1 ? "" : "s"}</>} />
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
      <div className="scroll-thin min-h-0 flex-1 overflow-auto px-6 py-5">
        <ol className="m-0 flex list-none items-stretch gap-0 p-0" aria-label="Flow stages">
          {stages.map((stage, index) => {
            const who = roles.filter((r) => stage.roleIds.includes(r.id));
            const here = open.filter((t) => t.stageId === stage.id);
            const busy = here.filter((t) => t.status === "in-progress" || t.status === "in-review").length;
            const on = stage.id === selected;
            return (
              <li key={stage.id} className="flex items-stretch">
                {index > 0 && (
                  <span className="flex w-8 shrink-0 items-center justify-center text-muted" aria-hidden="true">
                    <Icon name="chevron_right" size={20} />
                  </span>
                )}
                <div
                  role="button"
                  tabIndex={0}
                  draggable={canEdit}
                  onDragStart={(e) => (setDragging(stage.id), e.dataTransfer.setData("text/plain", stage.id))}
                  onDragEnd={() => setDragging(null)}
                  onDragOver={(e) => canEdit && dragging && e.preventDefault()}
                  onDrop={(e) => (e.preventDefault(), dragging && drop(dragging, stage.id), setDragging(null))}
                  onClick={() => setSelected(stage.id)}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setSelected(stage.id))}
                  aria-label={`Stage ${index + 1}: ${stage.name}. ${here.length} open tasks. Open to edit.`}
                  className={`flex w-[250px] shrink-0 cursor-pointer flex-col gap-3 rounded-xl border bg-[var(--surface-card)] p-4 text-left transition-colors outline-none focus-visible:border-[var(--accent)] ${on ? "border-[var(--accent)]" : "border-[var(--border-hairline)] hover:border-[var(--border-strong)]"} ${dragging === stage.id ? "opacity-50" : ""}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[12px] font-semibold text-accent">{index + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">{stage.name || stage.id}</span>
                    {canEdit && <Icon name="drag_indicator" size={16} className="text-muted" />}
                  </div>
                  <button
                    type="button"
                    className="flex items-center gap-1.5 self-start rounded-md text-[13px] text-muted hover:text-ink"
                    onClick={(e) => (e.stopPropagation(), ui.openBoards(undefined, stage.id))}
                    title="Open the board filtered to this stage"
                  >
                    {busy > 0 && <i className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />}
                    <span className="font-semibold text-ink">{here.length}</span> open task{here.length === 1 ? "" : "s"}
                  </button>
                  <div>
                    <div className="mb-1.5 text-[12px] text-muted">Who works it</div>
                    {who.length ? (
                      <div className="flex flex-wrap gap-1.5">
                        {who.map((r) => (
                          <span key={r.id} className="flex items-center gap-1.5 rounded-full border border-[var(--border-hairline)] py-0.5 pr-2 pl-0.5 text-[12px] text-ink">
                            <span className="grid h-5 w-5 place-items-center rounded-full text-[12px] font-semibold text-white" style={{ background: r.color }} aria-hidden="true">
                              {r.title.slice(0, 1)}
                            </span>
                            {r.title}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-[12px] text-red">No roles: nobody can take its tasks</span>
                    )}
                  </div>
                  <div className="border-t border-[var(--border-hairline)] pt-3">
                    <div className="mb-1.5 text-[12px] text-muted">To leave this stage</div>
                    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                      {stage.gates.map((g) => (
                        <li key={g.id} className="flex items-start gap-1.5 text-[13px] text-ink" title={gateText(g)}>
                          <Icon name="check_circle" size={16} className="mt-px text-accent" />
                          <span className="min-w-0">{GATE_NAME[g.kind]}</span>
                        </li>
                      ))}
                      {!stage.gates.length && <li className="text-[12px] text-muted">No gate: tasks move on when done</li>}
                    </ul>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
        {canEdit && stages.length > 1 && <p className="mt-4 text-[12px] text-muted">Drag a stage to reorder it, or click it to edit. Save to apply.</p>}
      </div>
      {cur && <SlideOver title={`Stage ${curIndex + 1} · ${cur.name}`} onClose={() => setSelected(null)} width={420}><>
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
                    <li key={g.id} className="rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-card)] px-3 py-2">
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
</></SlideOver>}
    </>
  );
}
