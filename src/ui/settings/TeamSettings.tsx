import { BRAND } from "../../data/brand";
import { TemplateImport } from "../setup/TemplateImport";
import { useState } from "react";
import type { Role } from "../../data/model";
import { nextAgentName } from "../../data/names";
import { BUILTIN_SKILLS } from "../../data/skillCatalog";
import { AGENT_CLIS, CLI_MODELS, type AgentCli, type AgentConfig, type AgentMode, cliPickerLabel } from "../../data/types";
import { officeActions, useOffice } from "../../store/office";
import { agentPalette } from "../../theme/tokens";
import { Field, Portrait, RoleBadge, SectionTitle } from "../kit";
import { ModelSelect } from "../primitives/ModelSelect";
import { CommitInput } from "./controls";
import { RemoveAgentDialog } from "./RemoveAgentDialog";

export function CliSelect({ value, onChange }: { value: AgentCli; onChange: (v: AgentCli) => void }) {
  return (
    <select className="field" value={value} onChange={(e) => onChange(e.target.value as AgentCli)} aria-label="Agent CLI">
      {AGENT_CLIS.map((c) => (
        <option key={c} value={c}>
          {cliPickerLabel(c)}
        </option>
      ))}
    </select>
  );
}

function ModeSelect({ value, onChange }: { value: AgentMode; onChange: (v: AgentMode) => void }) {
  return (
    <select className="field" value={value} onChange={(e) => onChange(e.target.value as AgentMode)} aria-label="Runs in">
      <option value="sandbox">Sandbox</option>
      <option value="container">Container</option>
      <option value="local">Local</option>
    </select>
  );
}

const MODE_LABEL: Record<AgentMode, string> = { local: "Local", sandbox: "Sandbox", container: "Container" };

/** The whole team in one mode, e.g. Container on a server without nested virtualization (docs/agent-engine.md section 9). */
function TeamMode() {
  const team = useOffice((s) => s.snap?.config.team) ?? [];
  const containerReady = useOffice((s) => s.snap?.setup.containerReady);
  const [mode, setMode] = useState<AgentMode>("container");
  const counts = team.reduce<Record<string, number>>((m, a) => ({ ...m, [a.mode]: (m[a.mode] ?? 0) + 1 }), {});
  const pending = team.filter((a) => a.nextMode);
  const all = team.every((a) => (a.nextMode ?? a.mode) === mode);
  return (
    <section className="panel p-3">
      <SectionTitle>Where the team runs</SectionTitle>
      <p className="mb-2 text-[13px] text-muted">
        {Object.entries(counts).map(([m, n]) => `${n} in ${MODE_LABEL[m as AgentMode]}`).join(" · ")}
        {pending.length ? ` · ${pending.map((a) => `${a.name} to ${MODE_LABEL[a.nextMode!]}`).join(", ")} at the next start` : ""}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <ModeSelect value={mode} onChange={setMode} />
        <button className="btn min-h-[44px]" disabled={all} onClick={() => officeActions.setTeamMode(mode)}>
          Move the whole team
        </button>
      </div>
      <p className="mt-2 text-[12px] text-muted">Stopped agents switch now. Running ones keep going and switch at their next start, so no task is cut off.</p>
      {mode === "container" && !containerReady && <p className="mt-1 text-[12px] font-bold">Container mode isn't ready on this machine yet: see the setup checklist (Docker, the agent image, the proxy firewall rule).</p>}
    </section>
  );
}

export function TeamSettings() {
  const snap = useOffice((s) => s.snap);
  const [open, setOpen] = useState<string | null>(null);
  const [removing, setRemoving] = useState<AgentConfig | null>(null);
  if (!snap) return null;
  const { team, template } = snap.config;

  if (!template)
    return (
      <section className="flex flex-col gap-2">
        <SectionTitle>Team · {team.length} agents · read-only</SectionTitle>
        <p className="text-[13px] text-muted">This project was made before team templates. You can watch, answer and stop its agents, but not change the team.</p>
        {team.map((a) => (
          <div key={a.id} className="flex items-center gap-2 panel p-2">
            <Portrait name={a.name} color={a.color} lead={a.isLead} />
            <b>{a.name}</b>
            <RoleBadge role={a.role} color={a.color} compact />
            <span className="font-mono text-[12px] text-muted">
              {a.cli}
              {a.model ? `:${a.model}` : ""}
            </span>
          </div>
        ))}
      </section>
    );

  return (
    <div className="flex flex-col gap-5">
      <section>
        <SectionTitle>
          Roles · {template.name} v{template.version}
        </SectionTitle>
        <p className="mb-3 text-[13px] text-muted">A role sets the CLI, model, skills and instructions for every agent in it. Changes reach each agent at its next start.</p>
        <div className="flex flex-col gap-2">
          {template.roles.map((r) => (
            <RoleRow key={r.id} role={r} seats={team.filter((a) => a.roleId === r.id).length} expanded={open === `role:${r.id}`} onToggle={() => setOpen(open === `role:${r.id}` ? null : `role:${r.id}`)} />
          ))}
        </div>
      </section>
      <TeamMode />
      <section>
        <SectionTitle>Agents · {team.length}</SectionTitle>
        <div className="flex flex-col gap-2">
          {team.map((a) => (
            <SeatRow key={a.id} agent={a} roles={template.roles} expanded={open === a.id} onToggle={() => setOpen(open === a.id ? null : a.id)} onRemove={() => setRemoving(a)} />
          ))}
        </div>
      </section>
      <AddAgent roles={template.roles.filter((r) => !r.isLead)} defaultMode={snap.setup.sandboxReady ? "sandbox" : "local"} />
      <section>
        <SectionTitle>Template file</SectionTitle>
        <p className="mb-2 text-[13px] text-muted">
          Save this project's template ({template.name}: roles, flow, rules and the pins of its skill packs; no keys, agents or project data) to use on another HQ. An imported template joins this HQ's library for new projects; its skill packs are checked first.
        </p>
        <div className="flex flex-wrap items-start gap-3">
          <button type="button" className="btn px-2 text-[12px]" onClick={() => officeActions.exportTemplate()}>
            Save as file
          </button>
          <TemplateImport />
        </div>
      </section>
      {removing && <RemoveAgentDialog agent={removing} onClose={() => setRemoving(null)} />}
    </div>
  );
}

function RoleRow({ role, seats, expanded, onToggle }: { role: Role; seats: number; expanded: boolean; onToggle: () => void }) {
  const customSkills = useOffice((s) => s.snap?.customSkills);
  const set = (patch: Parameters<typeof officeActions.updateRole>[1]) => officeActions.updateRole(role.id, patch);
  const toggleSkill = (id: string) => set({ skills: role.skills.includes(id) ? role.skills.filter((s) => s !== id) : [...role.skills, id] });

  return (
    <div className="panel">
      <div className="grid grid-cols-[minmax(120px,1fr)_160px_170px_auto] items-end gap-2 p-2.5">
        <Field label={`Role · ${seats} ${seats === 1 ? "agent" : "agents"}${role.isLead ? " · lead" : ""}`}>
          <CommitInput className="field" value={role.title} onCommit={(v) => v.trim() && set({ title: v.trim() })} />
        </Field>
        <Field label="Agent CLI">
          <CliSelect value={role.cli} onChange={(cli) => set({ cli, model: CLI_MODELS[cli]?.[0] ?? "" })} />
        </Field>
        <Field label="Model">
          <ModelSelect cli={role.cli} value={role.model} className="field" ariaLabel={`${role.title} model`} onChange={(model) => set({ model })} />
        </Field>
        <button className="btn px-2 text-[13px]" aria-expanded={expanded} onClick={onToggle}>
          {expanded ? "Less" : "More"}
        </button>
      </div>
      {expanded && (
        <div className="flex flex-col gap-3 border-t border-white/[0.08] bg-cream p-3">
          {!role.isLead && (
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={role.onDemand} onChange={(e) => set({ onDemand: e.target.checked })} />
              On demand: started for a task and stopped after it (from Phase 3)
            </label>
          )}
          <Field label="Skills" hint="Built-in skill ids, your own skills, or skills.sh specs, comma-separated.">
            <CommitInput
              className="field mb-2"
              value={role.skills.join(", ")}
              placeholder="threat-modeling, vuln-triage, deep-research…"
              onCommit={(v) => set({ skills: v.split(",").map((s) => s.trim()).filter(Boolean) })}
            />
            <div className="flex flex-wrap gap-1">
              {[...(customSkills ?? []).map((id) => ({ id, description: "Your own skill (~/.arima/skills or .arima/skills)" })), ...BUILTIN_SKILLS].map((sk) => {
                const on = role.skills.includes(sk.id);
                return (
                  <button key={sk.id} type="button" className="btn px-1.5 py-0.5 font-term text-[14px]" aria-pressed={on} title={sk.description} onClick={() => toggleSkill(sk.id)}>
                    {on ? "✓ " : "+ "}
                    {sk.id}
                  </button>
                );
              })}
            </div>
          </Field>
          <Field
            label="Role instructions"
            hint={`What every agent in this role does and how. ${BRAND.name} adds the agent's name, the team, workflow rules and tools when it starts.`}
          >
            <CommitInput multiline className="field h-[160px] resize-y font-term text-[13px] leading-tight" value={role.roleMd} onCommit={(v) => set({ roleMd: v })} />
          </Field>
        </div>
      )}
    </div>
  );
}

function SeatRow({ agent, roles, expanded, onToggle, onRemove }: { agent: AgentConfig; roles: Role[]; expanded: boolean; onToggle: () => void; onRemove: () => void }) {
  const set = (patch: Parameters<typeof officeActions.updateAgent>[1]) => officeActions.updateAgent(agent.id, patch);
  return (
    <div className="panel">
      <div className="grid grid-cols-[40px_minmax(100px,1fr)_minmax(130px,1fr)_120px_auto] items-end gap-2 p-2.5">
        <Portrait name={agent.name} color={agent.color} lead={agent.isLead} />
        <Field label="Name">
          <CommitInput className="field" value={agent.name} onCommit={(v) => v.trim() && set({ name: v.trim() })} />
        </Field>
        <Field label="Role">
          {agent.isLead ? (
            <div className="field text-muted">{agent.role}</div>
          ) : (
            <select className="field" value={agent.roleId} onChange={(e) => set({ roleId: e.target.value })} aria-label={`${agent.name} role`}>
              {roles
                .filter((r) => !r.isLead)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                  </option>
                ))}
            </select>
          )}
        </Field>
        <Field label="Runs in" hint={agent.nextMode ? `${MODE_LABEL[agent.nextMode]} at its next start` : undefined}>
          <ModeSelect value={agent.nextMode ?? agent.mode} onChange={(mode) => set({ mode })} />
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
        <div className="grid grid-cols-2 gap-3 border-t border-white/[0.08] bg-cream p-3">
          <Field label="Colour">
            <div className="flex flex-wrap gap-1.5 pt-1">
              {agentPalette.map((c) => (
                <button
                  key={c}
                  className="h-6 w-6 rounded-lg border border-white/10"
                  style={{ background: c, outline: c === agent.color ? "2px solid #3fb950" : undefined, outlineOffset: 1 }}
                  aria-label={`Colour ${c}`}
                  onClick={() => set({ color: c })}
                />
              ))}
            </div>
          </Field>
          <Field label="Folder" hint={`Leave empty and ${BRAND.name} keeps its own isolated workspace for this agent. Or enter an existing folder path.`}>
            <CommitInput
              className="field font-term text-[13px]"
              value={agent.workspacePath ?? ""}
              placeholder={`HQ-managed: ~/.arima/…/${agent.id}`}
              onCommit={(v) => set({ workspacePath: v.trim() || null })}
            />
          </Field>
        </div>
      )}
    </div>
  );
}

function AddAgent({ roles, defaultMode }: { roles: Role[]; defaultMode: AgentMode }) {
  const [name, setName] = useState("");
  const [roleId, setRoleId] = useState(roles[0]?.id ?? "");
  const [mode, setMode] = useState<AgentMode>(defaultMode);
  const team = useOffice((s) => s.snap?.config.team) ?? [];
  const suggested = nextAgentName(team.map((a) => a.name));
  if (!roles.length)
    return <p className="text-[13px] text-muted">This template has only the lead role. Add a worker role to the template to add agents.</p>;
  return (
    <section className="rounded-xl border border-dashed border-white/15 p-3">
      <SectionTitle>Add an agent</SectionTitle>
      <form
        className="grid grid-cols-[minmax(100px,1fr)_minmax(130px,1fr)_120px_auto] items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          officeActions.addAgent({ name: name.trim() || suggested, roleId: roleId || roles[0].id, mode });
          setName("");
        }}
      >
        <Field label="Name">
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder={suggested} />
        </Field>
        <Field label="Role">
          <select className="field" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Runs in">
          <ModeSelect value={mode} onChange={setMode} />
        </Field>
        <button className="btn" type="submit">
          Add
        </button>
      </form>
    </section>
  );
}
