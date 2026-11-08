import { useState } from "react";
import { nextAgentName } from "../../data/names";
import {
  defaultRoleMdFor,
  defaultSkillsForRole,
  DEPARTMENT_META,
  DEPARTMENT_PODS,
  findRoleTemplate,
  inferDepartmentForRole,
  ORG_PRESETS,
  PERSONA_DOMAINS,
  ROLE_TEMPLATES,
  type DepartmentPodPreset,
  type OrgPreset,
} from "../../data/roles";
import { BUILTIN_SKILLS } from "../../data/skillCatalog";
import {
  AGENT_CLIS,
  CLI_LABEL,
  CLI_MODELS,
  DEPARTMENT_IDS,
  type AgentCli,
  type AgentConfig,
  type AgentMode,
  type DepartmentId,
} from "../../data/types";
import { officeActions, useOffice } from "../../store/office";
import { agentPalette } from "../../theme/tokens";
import { DepartmentBadge, Field, Portrait, SectionTitle } from "../kit";
import { ModelSelect } from "../primitives/ModelSelect";
import { CommitInput } from "./controls";
import { RemoveAgentDialog } from "./RemoveAgentDialog";

export function CliSelect({ value, onChange }: { value: AgentCli; onChange: (v: AgentCli) => void }) {
  return (
    <select className="field" value={value} onChange={(e) => onChange(e.target.value as AgentCli)} aria-label="Agent CLI">
      {AGENT_CLIS.map((c) => (
        <option key={c} value={c}>
          {CLI_LABEL[c]}
        </option>
      ))}
    </select>
  );
}

export function DepartmentSelect({
  value,
  onChange,
}: {
  value: DepartmentId;
  onChange: (v: DepartmentId) => void;
}) {
  return (
    <select
      className="field font-mono text-[12px]"
      value={value}
      onChange={(e) => onChange(e.target.value as DepartmentId)}
      aria-label="Department Pod"
    >
      {DEPARTMENT_IDS.map((id) => (
        <option key={id} value={id}>
          [{DEPARTMENT_META[id].short}] {DEPARTMENT_META[id].label}
        </option>
      ))}
    </select>
  );
}

export const ROLE_SUGGESTIONS = ROLE_TEMPLATES.map((r) => r.title);

export function TeamSettings() {
  const snap = useOffice((s) => s.snap);
  const team = snap?.config.team;
  const [open, setOpen] = useState<string | null>(null);
  const [removing, setRemoving] = useState<AgentConfig | null>(null);
  if (!team || !snap) return null;

  const defaultMode: AgentMode = snap.setup.sandboxReady ? "sandbox" : "local";

  const syncAllPonystackCaveman = () => {
    for (const a of team) {
      const roleMd = defaultRoleMdFor(a.name, a.role, a.isLead);
      const defaultSkills = defaultSkillsForRole(a.role, a.isLead);
      const mergedSkills = [...new Set([...defaultSkills, ...a.skills])];
      const department = inferDepartmentForRole(a.role, a.isLead, a.department);
      officeActions.updateAgent(a.id, { roleMd, skills: mergedSkills, department });
    }
  };

  const addDepartmentPod = (pod: DepartmentPodPreset) => {
    const existingNames = new Set(team.map((a) => a.name.toLowerCase()));
    for (const member of pod.members) {
      let finalName = member.name;
      if (existingNames.has(finalName.toLowerCase())) {
        finalName = nextAgentName([...existingNames]);
      }
      existingNames.add(finalName.toLowerCase());
      officeActions.addAgent({
        name: finalName,
        role: member.role,
        department: member.department,
        cli: member.cli,
        model: member.model,
        mode: defaultMode,
        skills: defaultSkillsForRole(member.role, false),
        roleMd: defaultRoleMdFor(finalName, member.role, false),
      });
    }
  };

  const applyOrgPreset = (org: OrgPreset) => {
    if (
      !window.confirm(
        `Load "${org.label}" (${1 + org.workers.length} operators)?\n\nThis will update your Lead to ${org.lead.name} (${org.lead.role}), replace current non-lead workers with the ${org.label} roster, and set the War-Room sign to "${org.officeName}".`,
      )
    ) {
      return;
    }
    const lead = team.find((a) => a.isLead);
    if (lead) {
      officeActions.updateAgent(lead.id, {
        name: org.lead.name,
        role: org.lead.role,
        department: org.lead.department,
        cli: org.lead.cli,
        model: org.lead.model,
        skills: defaultSkillsForRole(org.lead.role, true),
        roleMd: defaultRoleMdFor(org.lead.name, org.lead.role, true),
      });
    }
    for (const w of team.filter((a) => !a.isLead)) {
      officeActions.removeAgent(w.id, { deleteSandbox: false, deleteFolder: false });
    }
    for (const w of org.workers) {
      officeActions.addAgent({
        name: w.name,
        role: w.role,
        department: w.department,
        cli: w.cli,
        model: w.model,
        mode: defaultMode,
        skills: defaultSkillsForRole(w.role, false),
        roleMd: defaultRoleMdFor(w.name, w.role, false),
      });
    }
    officeActions.updateProject({ officeName: org.officeName });
    officeActions.updateWorkflow({ mode: org.workflowMode });
  };

  return (
    <div className="flex flex-col gap-5">
      <section className="border-[3px] border-ink bg-cream p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div>
            <SectionTitle>Organization War-Room Templates &amp; Department Pods</SectionTitle>
            <p className="text-[12px] text-muted">
              Load a complete Product Company or Red Team Cybersec Center, or click a Department Pod to append specialized operators to your current team.
            </p>
          </div>
          <button
            type="button"
            className="btn px-2.5 py-1 text-[12px]"
            title="Apply pstack (Architect + Deslop + Blast-Radius), Ponytail (YAGNI), and Caveman (Token-Saving) defaults to all operators"
            onClick={syncAllPonystackCaveman}
          >
            ⚡ Sync All to Ponystack + Caveman
          </button>
        </div>

        <div className="mb-3">
          <div className="mb-1 font-mono text-[11px] font-bold uppercase tracking-wider text-muted">
            1. Full Organization Templates (Replaces Roster &amp; Sets War-Room Sign)
          </div>
          <div className="grid grid-cols-2 gap-2">
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
        </div>

        <div>
          <div className="mb-1 font-mono text-[11px] font-bold uppercase tracking-wider text-muted">
            2. Modular Department Pods (Appends Operators to Current Team)
          </div>
          <div className="flex flex-wrap gap-1.5">
            {DEPARTMENT_PODS.map((pod) => (
              <button
                key={pod.id}
                type="button"
                className="btn px-2.5 py-1 font-mono text-[12px]"
                style={{ borderColor: pod.color }}
                title={`${pod.description} (${pod.members.map((m) => `${m.name}: ${m.role}`).join(", ")})`}
                onClick={() => addDepartmentPod(pod)}
              >
                <span style={{ color: pod.color }}>{pod.short}</span>
                <span className="ml-1 text-[10px] text-muted">({pod.members.length})</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      <section>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <SectionTitle>Active Roster · {team.length} operators</SectionTitle>
        </div>
        <p className="mb-3 text-[13px] text-muted">
          Pick any operator's <b>Agent CLI</b> and <b>Model</b> (<code>claude-opus-5-5</code>, <code>claude-sonnet-5-5</code>, <code>gpt-6.1-sol</code>, <code>gemini-4-argon-high</code>, or custom ID) directly below.
        </p>
        <div className="flex flex-col gap-2">
          {team.map((a) => (
            <AgentRow key={a.id} agent={a} expanded={open === a.id} onToggle={() => setOpen(open === a.id ? null : a.id)} onRemove={() => setRemoving(a)} />
          ))}
        </div>
      </section>
      <AddAgent />
      {removing && <RemoveAgentDialog agent={removing} onClose={() => setRemoving(null)} />}
    </div>
  );
}

function AgentRow({ agent, expanded, onToggle, onRemove }: { agent: AgentConfig; expanded: boolean; onToggle: () => void; onRemove: () => void }) {
  const set = (patch: Parameters<typeof officeActions.updateAgent>[1]) => officeActions.updateAgent(agent.id, patch);
  const matchedTemplate = findRoleTemplate(agent.role);
  const domainBadge = matchedTemplate ? PERSONA_DOMAINS.find((d) => d.id === matchedTemplate.domain)?.badge : "USR";
  const deptId = inferDepartmentForRole(agent.role, agent.isLead, agent.department);

  const toggleSkill = (skillId: string) => {
    const has = agent.skills.includes(skillId);
    const next = has ? agent.skills.filter((s) => s !== skillId) : [...agent.skills, skillId];
    set({ skills: next });
  };

  const applyTemplate = (roleTitle: string) => {
    const roleMd = defaultRoleMdFor(agent.name, roleTitle, agent.isLead);
    const skills = defaultSkillsForRole(roleTitle, agent.isLead);
    const department = inferDepartmentForRole(roleTitle, agent.isLead);
    set({ role: roleTitle, department, roleMd, skills });
  };

  return (
    <div className="border-[3px] border-ink bg-white">
      <div className="grid grid-cols-[40px_minmax(100px,1fr)_minmax(130px,1.2fr)_145px_150px_110px_auto] items-end gap-2 p-2.5">
        <Portrait color={agent.color} lead={agent.isLead} />
        <Field label="Name">
          <CommitInput className="field" value={agent.name} onCommit={(v) => v.trim() && set({ name: v.trim() })} />
        </Field>
        <Field label={`Role (${domainBadge})`}>
          <div className="flex items-center gap-1.5">
            <DepartmentBadge role={agent.role} isLead={agent.isLead} department={agent.department} compact />
            <CommitInput
              className="field flex-1"
              value={agent.role}
              list="role-suggestions"
              onCommit={(v) => {
                const nextRole = v.trim();
                if (!nextRole) return;
                set({
                  role: nextRole,
                  department: inferDepartmentForRole(nextRole, agent.isLead),
                });
              }}
            />
          </div>
        </Field>
        <Field label="Agent CLI">
          <CliSelect
            value={agent.cli}
            onChange={(cli) => set({ cli, model: CLI_MODELS[cli]?.[0] ?? "" })}
          />
        </Field>
        <Field label="Model">
          <ModelSelect
            cli={agent.cli}
            value={agent.model}
            className="field"
            ariaLabel={`${agent.name} model`}
            onChange={(model) => set({ model })}
          />
        </Field>
        <Field label="Runs in">
          <select className="field" value={agent.mode} onChange={(e) => set({ mode: e.target.value as AgentMode })}>
            <option value="sandbox">Sandbox</option>
            <option value="container">Container</option>
            <option value="local">Local</option>
          </select>
        </Field>
        <div className="flex gap-1.5">
          <button className="btn px-2 text-[13px]" aria-expanded={expanded} onClick={onToggle}>
            {expanded ? "Less" : "More"}
          </button>
          {!agent.isLead && (
            <button className="btn px-2 text-[13px] text-red" onClick={onRemove}>
              Remove
            </button>
          )}
        </div>
      </div>
      {agent.mode === "local" && (
        <div className="border-t-2 border-dashed border-cream-3 px-3 py-1 text-[12px] text-muted">
          Local mode runs <code>{agent.cli}</code> directly on your host in the agent's folder.
        </div>
      )}
      {expanded && (
        <div className="grid grid-cols-2 gap-3 border-t-[3px] border-ink bg-cream p-3">
          <Field label="Department Pod">
            <DepartmentSelect value={deptId} onChange={(department) => set({ department })} />
          </Field>
          <Field label="Colour">
            <div className="flex flex-wrap gap-1.5 pt-1">
              {agentPalette.map((c) => (
                <button
                  key={c}
                  className="h-6 w-6 border-[3px] border-ink"
                  style={{ background: c, outline: c === agent.color ? "2px solid #00ff66" : undefined, outlineOffset: 1 }}
                  aria-label={`Colour ${c}`}
                  onClick={() => set({ color: c })}
                />
              ))}
            </div>
          </Field>

          <div className="col-span-2">
            <Field label="Persona Preset Templates" hint="Click a preset to load its role title, department pod, specialized instructions (ROLE.md), and default skills.">
              <div className="flex flex-wrap gap-1.5">
                {ROLE_TEMPLATES.filter((r) => (agent.isLead ? r.isLead : !r.isLead)).map((tpl) => {
                  const active = agent.role.toLowerCase() === tpl.title.toLowerCase();
                  return (
                    <button
                      key={tpl.id}
                      type="button"
                      className="btn px-2 py-0.5 text-[12px]"
                      aria-pressed={active}
                      title={tpl.summary}
                      onClick={() => applyTemplate(tpl.title)}
                    >
                      {tpl.title}
                    </button>
                  );
                })}
              </div>
            </Field>
          </div>

          <div className="col-span-2">
            <Field
              label="Skills"
              hint="Comma-separated built-in skill IDs, custom skill names, or external skills.sh specs. Installed into .claude/skills, .agents/skills, and .agent/skills."
            >
              <CommitInput
                className="field mb-2"
                value={agent.skills.join(", ")}
                placeholder="threat-modeling, vuln-triage, deep-research…"
                onCommit={(v) => set({ skills: v.split(",").map((s) => s.trim()).filter(Boolean) })}
              />
              <div className="flex flex-wrap gap-1">
                {BUILTIN_SKILLS.map((sk) => {
                  const on = agent.skills.includes(sk.id);
                  return (
                    <button
                      key={sk.id}
                      type="button"
                      className="btn px-1.5 py-0.5 font-term text-[14px]"
                      aria-pressed={on}
                      title={sk.description}
                      onClick={() => toggleSkill(sk.id)}
                    >
                      {on ? "✓ " : "+ "}
                      {sk.id}
                    </button>
                  );
                })}
              </div>
            </Field>
          </div>

          <div className="col-span-2">
            <Field label="Folder" hint="Leave empty and .hq keeps its own isolated workspace for this agent. Or enter an existing folder path.">
              <CommitInput
                className="field font-term text-[17px]"
                value={agent.workspacePath ?? ""}
                placeholder={`HQ-managed: ~/.hq/…/${agent.id}`}
                onCommit={(v) => set({ workspacePath: v.trim() || null })}
              />
            </Field>
          </div>
          <div className="col-span-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[12px] font-bold uppercase tracking-[0.04em] text-muted">ROLE.md (Persona Instructions)</span>
              <button
                type="button"
                className="text-[12px] text-green underline"
                onClick={() => set({ roleMd: defaultRoleMdFor(agent.name, agent.role, agent.isLead) })}
              >
                Reset to {agent.role} template
              </button>
            </div>
            <Field
              label=""
              hint="Who this agent is and how they operate. .hq adds the team, workflow rules and MCP tools, writes it to .hq-role.md and .agent/rules/hq-role.md (never committed), and loads it when the session starts."
            >
              <CommitInput multiline className="field h-[140px] resize-y font-term text-[17px] leading-tight" value={agent.roleMd} onCommit={(v) => set({ roleMd: v })} />
            </Field>
          </div>
        </div>
      )}
    </div>
  );
}

function AddAgent() {
  const [name, setName] = useState("");
  const [role, setRole] = useState("Senior Dev");
  const [department, setDepartment] = useState<DepartmentId>("eng");
  const [cli, setCli] = useState<AgentCli>("claude");
  const [model, setModel] = useState<string>("claude-sonnet-5-5");
  const [mode, setMode] = useState<AgentMode>("sandbox");
  const team = useOffice((s) => s.snap?.config.team) ?? [];
  const suggested = nextAgentName(team.map((a) => a.name));
  const add = () => {
    officeActions.addAgent({
      name: name.trim() || suggested,
      role,
      department,
      cli,
      model,
      mode,
    });
    setName("");
  };
  return (
    <section className="border-[3px] border-dashed border-ink p-3">
      <SectionTitle>Add an operator</SectionTitle>
      <form
        className="grid grid-cols-[minmax(100px,1fr)_minmax(120px,1.1fr)_150px_145px_150px_105px_auto] items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Field label="Name">
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder={suggested} />
        </Field>
        <Field label="Role / Persona">
          <input
            className="field"
            value={role}
            list="role-suggestions"
            onChange={(e) => {
              const r = e.target.value;
              setRole(r);
              setDepartment(inferDepartmentForRole(r, false));
            }}
            placeholder="Senior Dev, UI/UX Designer, Red Teamer…"
          />
        </Field>
        <Field label="Department Pod">
          <DepartmentSelect value={department} onChange={setDepartment} />
        </Field>
        <Field label="Agent CLI">
          <CliSelect
            value={cli}
            onChange={(nextCli) => {
              setCli(nextCli);
              setModel(CLI_MODELS[nextCli]?.[0] ?? "");
            }}
          />
        </Field>
        <Field label="Model">
          <ModelSelect cli={cli} value={model} className="field" onChange={setModel} />
        </Field>
        <Field label="Runs in">
          <select className="field" value={mode} onChange={(e) => setMode(e.target.value as AgentMode)}>
            <option value="sandbox">Sandbox</option>
            <option value="container">Container</option>
            <option value="local">Local</option>
          </select>
        </Field>
        <button className="btn" type="submit">
          Add
        </button>
      </form>
      <p className="mt-2 text-[12px] text-muted">
        Selecting a built-in role automatically populates tailored instructions, department pod, and default skills for that persona.
      </p>
      <datalist id="role-suggestions">
        {ROLE_SUGGESTIONS.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
    </section>
  );
}

