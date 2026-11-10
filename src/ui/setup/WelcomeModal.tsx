import { BRAND } from "../../data/brand";
import { useState } from "react";
import { LEAD_NAME, nextAgentName, WORKER_NAMES } from "../../data/names";
import { DEPARTMENT_PODS, inferDepartmentForRole, ORG_PRESETS, type DepartmentPodPreset, type OrgPreset } from "../../data/roles";
import { EMPTY_STACK, frameworks, STACK_CATEGORIES, toolsIn, type StackConfig } from "../../data/stack";
import { CLI_MODELS, type AgentCli, type DepartmentId, type ReviewTool, type WorkflowMode } from "../../data/types";
import { officeActions, reviewToolLabel, useOffice } from "../../store/office";
import { agentPalette } from "../../theme/tokens";
import { DepartmentBadge, Field, Portrait } from "../kit";
import { ModelSelect } from "../primitives/ModelSelect";
import { CliSelect, ROLE_SUGGESTIONS } from "../settings/TeamSettings";

interface WorkerDraft {
  name: string;
  role: string;
  department: DepartmentId;
  cli: AgentCli;
  model: string;
}

const MAX_WORKERS = 11;

/** First run on a repo/folder: name the project, pick an organization preset or modular department pods, and choose each operator's CLI & model. */
export function WelcomeModal() {
  const snap = useOffice((s) => s.snap);
  const [projectName, setProjectName] = useState(snap?.config.project.name ?? "");
  const [officeName, setOfficeName] = useState(snap?.config.project.officeName ?? ".HQ");
  const [lead, setLead] = useState<{ name: string; role: string; department: DepartmentId; cli: AgentCli; model: string }>({
    name: LEAD_NAME,
    role: "CTO",
    department: "exec",
    cli: "claude",
    model: "claude-opus-5-5",
  });
  const [workers, setWorkers] = useState<WorkerDraft[]>([
    { name: WORKER_NAMES[0], role: "Senior Dev", department: "eng", cli: "claude", model: "claude-sonnet-5-5" },
    { name: WORKER_NAMES[1], role: "UI/UX Designer", department: "design", cli: "agy", model: "gemini-4-argon-high" },
    { name: WORKER_NAMES[2], role: "QA & CI/CD", department: "qa-ops", cli: "codex", model: "gpt-6.1-sol" },
  ]);
  const [workflowMode, setWorkflowMode] = useState<WorkflowMode>(snap?.config.workflow.mode ?? "github-pr");
  const [reviewEnabled, setReviewEnabled] = useState(snap?.config.workflow.review.enabled ?? true);
  const [reviewTool, setReviewTool] = useState<ReviewTool>(snap?.config.workflow.review.tool ?? "human");
  const [sending, setSending] = useState(false);
  const [stack, setStack] = useState<StackConfig>(EMPTY_STACK);
  if (!snap) return null;

  const setWorker = (i: number, patch: Partial<WorkerDraft>) =>
    setWorkers((ws) => ws.map((w, j) => (j === i ? { ...w, ...patch } : w)));

  const addWorker = () =>
    setWorkers((ws) => [
      ...ws,
      {
        name: nextAgentName([lead.name, ...ws.map((w) => w.name)]),
        role: "Junior Dev",
        department: "eng",
        cli: lead.cli,
        model: CLI_MODELS[lead.cli]?.[0] ?? "",
      },
    ]);

  const applyOrgPreset = (org: OrgPreset) => {
    setWorkflowMode(org.workflowMode);
    setOfficeName(org.officeName);
    setLead({
      name: org.lead.name,
      role: org.lead.role,
      department: org.lead.department,
      cli: org.lead.cli,
      model: org.lead.model,
    });
    setWorkers(
      org.workers.map((w) => ({
        name: w.name,
        role: w.role,
        department: w.department,
        cli: w.cli,
        model: w.model,
      })),
    );
  };

  const appendPod = (pod: DepartmentPodPreset) => {
    setWorkers((ws) => {
      const used = new Set([lead.name.toLowerCase(), ...ws.map((x) => x.name.toLowerCase())]);
      const next = [...ws];
      for (const m of pod.members) {
        if (next.length >= MAX_WORKERS) break;
        let finalName = m.name;
        if (used.has(finalName.toLowerCase())) {
          finalName = nextAgentName([...used]);
        }
        used.add(finalName.toLowerCase());
        next.push({
          name: finalName,
          role: m.role,
          department: m.department,
          cli: m.cli,
          model: m.model,
        });
      }
      return next;
    });
  };

  const valid = lead.name.trim() && workers.length > 0 && workers.every((w) => w.name.trim());

  const submit = () => {
    if (!valid) return;
    setSending(true);
    const hasStack = stack.frameworks.length > 0 || Object.values(stack.tools).some(Boolean);
    officeActions.completeWelcome({
      projectName: projectName.trim(),
      officeName: officeName.trim() || BRAND.officeSign,
      lead,
      workers,
      workflowMode,
      reviewTool,
      reviewEnabled,
      ...(hasStack ? { stack } : {}),
    });
  };

  return (
    <div className="fixed inset-0 z-50 grid grid-cols-[minmax(0,1fr)] place-items-center bg-[rgba(4,5,8,0.75)] p-4" role="dialog" aria-modal="true" aria-label={`Welcome to ${BRAND.name}`}>
      <div className="panel flex max-h-[calc(100dvh-2rem)] w-[min(860px,100%)] flex-col">
        <div className="border-b-[3px] border-ink px-4 py-2">
          <h2 className="m-0 text-[22px] font-bold">
            Welcome to <span className="text-gold">{BRAND.name}</span>
          </h2>
          <p className="m-0 text-[14px] text-muted">
            Assemble your Product Company or Red Team Cybersec War-Room for <b className="text-ink">{snap.config.project.repo || snap.config.project.name}</b>.
          </p>
        </div>

        <div className="scroll-thin flex min-h-0 flex-col gap-4 overflow-y-auto px-4 py-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Project / Mission name">
              <input className="field w-full" value={projectName} maxLength={80} onChange={(e) => setProjectName(e.target.value)} />
            </Field>
            <Field label="War-Room Wall Sign">
              <input className="field w-full font-mono" value={officeName} maxLength={12} placeholder="PRODUCT HQ / RED TEAM SOC" onChange={(e) => setOfficeName(e.target.value)} />
            </Field>
            <Field label="Workflow mode">
              <select className="field w-full" value={workflowMode} onChange={(e) => setWorkflowMode(e.target.value as WorkflowMode)}>
                <option value="github-pr">GitHub Pull Requests (Software Dev)</option>
                <option value="deliverables">Universal Deliverables (Any Task / Non-PR)</option>
              </select>
            </Field>
          </div>

          <section className="border-2 border-ink bg-cream p-2.5">
            <h3 className="mb-1.5 text-[12px] font-bold uppercase tracking-[0.06em] text-muted">
              1. Full Organization Templates (Product HQ &amp; Red Team Cybersec Center)
            </h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {ORG_PRESETS.map((org) => (
                <button
                  key={org.id}
                  type="button"
                  className="flex flex-col items-start border-2 border-ink bg-white p-2 text-left transition hover:border-red"
                  onClick={() => applyOrgPreset(org)}
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <b className="text-[13px]">{org.label}</b>
                    <span className="border border-red bg-[rgba(255,23,68,0.14)] px-1.5 py-0.5 font-mono text-[10px] font-bold text-red">
                      {org.badge}
                    </span>
                  </div>
                  <span className="mt-1 text-[11px] leading-snug text-muted">{org.description}</span>
                </button>
              ))}
            </div>
            <div className="mt-2.5">
              <div className="mb-1 font-mono text-[11px] font-bold uppercase tracking-wider text-muted">
                2. Or Mix-and-Match Department Pods (+ Append)
              </div>
              <div className="flex flex-wrap gap-1.5">
                {DEPARTMENT_PODS.map((pod) => (
                  <button
                    key={pod.id}
                    type="button"
                    className="btn px-2 py-0.5 font-mono text-[11px]"
                    style={{ borderColor: pod.color }}
                    onClick={() => appendPod(pod)}
                  >
                    <span style={{ color: pod.color }}>{pod.short}</span>
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section>
            <h3 className="mb-1 text-[16px] font-bold">Executive Command (CTO / Lead / Red Team Commander)</h3>
            <p className="mb-2 text-[13px] text-muted">
              Architects the plan, assigns tasks to department pods, and has multi-project CTO overwatch tools.
            </p>
            <div className="grid grid-cols-2 items-end gap-2 md:grid-cols-[40px_1fr_1fr_150px_170px]">
              <Portrait color={agentPalette[0]} lead />
              <Field label="Name">
                <input className="field w-full" value={lead.name} maxLength={40} onChange={(e) => setLead({ ...lead, name: e.target.value })} />
              </Field>
              <Field label="Command Role">
                <div className="flex items-center gap-1.5">
                  <DepartmentBadge role={lead.role} isLead department={lead.department} compact />
                  <input
                    className="field w-full"
                    list="welcome-roles"
                    value={lead.role}
                    maxLength={40}
                    onChange={(e) => setLead({ ...lead, role: e.target.value, department: inferDepartmentForRole(e.target.value, true) })}
                  />
                </div>
              </Field>
              <Field label="Agent CLI">
                <CliSelect
                  value={lead.cli}
                  onChange={(cli) => setLead({ ...lead, cli, model: CLI_MODELS[cli]?.[0] ?? "" })}
                />
              </Field>
              <Field label="Model">
                <ModelSelect cli={lead.cli} value={lead.model} className="field w-full" onChange={(model) => setLead({ ...lead, model })} />
              </Field>
            </div>
          </section>

          <section>
            <h3 className="mb-1 text-[16px] font-bold">Department Operators · {workers.length}</h3>
            <p className="mb-2 text-[13px] text-muted">
              Each operator gets its own color-coded department pod desk, isolated workspace, role and persona instructions, and selected model.
            </p>
            <datalist id="welcome-roles">
              {ROLE_SUGGESTIONS.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
            <div className="flex flex-col gap-2">
              {workers.map((w, i) => (
                <div key={i} className="grid grid-cols-2 items-end gap-2 md:grid-cols-[40px_1fr_1.15fr_150px_170px_auto]">
                  <Portrait color={agentPalette[(i + 1) % agentPalette.length]} lead={false} />
                  <Field label="Name">
                    <input className="field w-full" value={w.name} maxLength={40} onChange={(e) => setWorker(i, { name: e.target.value })} />
                  </Field>
                  <Field label="Role / Persona">
                    <div className="flex items-center gap-1.5">
                      <DepartmentBadge role={w.role} department={w.department} compact />
                      <input
                        className="field w-full"
                        list="welcome-roles"
                        value={w.role}
                        maxLength={40}
                        onChange={(e) => setWorker(i, { role: e.target.value, department: inferDepartmentForRole(e.target.value, false) })}
                      />
                    </div>
                  </Field>
                  <Field label="Agent CLI">
                    <CliSelect
                      value={w.cli}
                      onChange={(cli) => setWorker(i, { cli, model: CLI_MODELS[cli]?.[0] ?? "" })}
                    />
                  </Field>
                  <Field label="Model">
                    <ModelSelect cli={w.cli} value={w.model} className="field w-full" onChange={(model) => setWorker(i, { model })} />
                  </Field>
                  <button
                    className="btn px-2 text-[13px]"
                    disabled={workers.length === 1}
                    aria-label={`Remove ${w.name || "worker"}`}
                    onClick={() => setWorkers((ws) => ws.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <button className="btn mt-2 text-[13px]" disabled={workers.length >= MAX_WORKERS} onClick={addWorker}>
              + Add operator
            </button>
          </section>

          <WelcomeStack stack={stack} setStack={setStack} />

          {workflowMode === "github-pr" && (
            <section>
              <h3 className="mb-1 text-[16px] font-bold">Code review</h3>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-[14px]">
                  <input type="checkbox" checked={reviewEnabled} onChange={(e) => setReviewEnabled(e.target.checked)} />
                  Review PRs before merge
                </label>
                <select className="field w-[220px]" value={reviewTool} disabled={!reviewEnabled} onChange={(e) => setReviewTool(e.target.value as ReviewTool)} aria-label="Review tool">
                  {(Object.keys(reviewToolLabel) as ReviewTool[]).map((t) => (
                    <option key={t} value={t}>
                      {reviewToolLabel[t]}
                    </option>
                  ))}
                </select>
              </div>
            </section>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t-[3px] border-ink px-4 py-2">
          <span className="text-[12px] text-muted">Saved to .arima/config.json. Operators don't start until you press Start.</span>
          <button className="btn" disabled={!valid || sending} onClick={submit}>
            {sending ? "Creating…" : "Create team"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Optional, collapsed by default: frameworks and tools. Everything else is in Settings → Stack. */
function WelcomeStack({ stack, setStack }: { stack: StackConfig; setStack: (s: StackConfig) => void }) {
  const [open, setOpen] = useState(false);
  const chosen = (id: string) => stack.frameworks.some((f) => f.id === id);
  return (
    <section>
      <div className="flex items-center gap-3">
        <h3 className="m-0 text-[16px] font-bold">Stack</h3>
        <span className="text-[13px] text-muted">Optional. Agents get the tools' skills and docs access.</span>
        <button className="btn ml-auto px-2 text-[12px]" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Choose"}
        </button>
      </div>
      {open && (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            {frameworks().map((f) => (
              <button
                key={f.id}
                className="btn px-2 py-0.5 text-[12px]"
                aria-pressed={chosen(f.id)}
                onClick={() => setStack({ ...stack, frameworks: chosen(f.id) ? stack.frameworks.filter((x) => x.id !== f.id) : [...stack.frameworks, { id: f.id }] })}
              >
                {f.name}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {STACK_CATEGORIES.map((c) => (
              <label key={c.id} className="flex flex-col gap-0.5 text-[12px] font-semibold">
                {c.label}
                <select
                  className="field"
                  value={stack.tools[c.id]?.id ?? ""}
                  onChange={(e) => {
                    const tools = { ...stack.tools };
                    if (e.target.value) tools[c.id] = { id: e.target.value };
                    else delete tools[c.id];
                    setStack({ ...stack, tools });
                  }}
                >
                  <option value="">None</option>
                  {toolsIn(c.id).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <span className="text-[12px] text-muted">"Other" tools, where each framework lives, and network access are in Settings → Stack.</span>
        </div>
      )}
    </section>
  );
}
