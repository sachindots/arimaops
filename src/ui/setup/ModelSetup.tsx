// One-shot model setup (src/data/teamSetup.ts): what this machine has, the proposed CLI and model per role, and one
// Apply. Keys and sign-ins stay the owner's: the panel only links to where they go.
import { useMemo, useState } from "react";
import { FREE_SOURCE_INFO } from "../../data/freeModels";
import { proposeSetup, type SetupFacts } from "../../data/teamSetup";
import { CLI_LABEL, type AgentCli, type OfficeSnapshot } from "../../data/types";
import { isViewer, officeActions, useOffice } from "../../store/office";
import { SectionTitle } from "../kit";

const CLIS: AgentCli[] = ["claude", "codex", "agy", "opencode", "gemini", "copilot"];

/** What the snapshot says this machine can use. Sandboxes bring Claude Code and Codex with them. */
export function factsOf(snap: OfficeSnapshot): SetupFacts {
  const ok = new Set(snap.setup.checks.filter((c) => c.status === "ok").map((c) => c.id as string));
  const clis = CLIS.filter((c) => ok.has(c) || (snap.setup.sandboxReady && (c === "claude" || c === "codex")));
  const keys = [...new Set((snap.accounts?.list ?? []).filter((a) => a.secret).map((a) => a.provider))];
  return { ramGb: snap.setup.machine.memoryGb, cpus: snap.setup.machine.cpus, clis, keys, free: snap.freeModels?.models ?? [] };
}

export function ModelSetup() {
  const snap = useOffice((s) => s.snap);
  const [applied, setApplied] = useState(false);
  const proposal = useMemo(() => (snap?.config.template ? proposeSetup(snap.config.template.roles, factsOf(snap)) : null), [snap]);
  if (!snap || !proposal) return null;
  const free = snap.freeModels;

  const apply = () => {
    for (const p of proposal.roles) officeActions.updateRole(p.roleId, { cli: p.cli, model: p.model, fallback: p.fallback });
    for (const a of snap.config.team)
      if (a.sandbox.resources.cpus === null && a.sandbox.resources.memoryGb === null) officeActions.updateSandbox(a.id, { resources: proposal.sandbox });
    setApplied(true);
  };

  return (
    <section className="panel flex flex-col gap-3 p-4">
      <SectionTitle>Set up models in one step</SectionTitle>
      <p className="text-[13px] text-muted">
        Paid models for the lead and builders, free models for review, QA and docs, and a free fallback when a paid account hits its limit.
        Free list: {free?.models.length ?? 0} models{free?.checkedAt ? `, checked ${new Date(free.checkedAt).toLocaleDateString()}` : ""}
        {free?.error ? ` (last check failed: ${free.error})` : ""}.
      </p>
      <table className="w-full text-[13px]">
        <thead className="text-left text-[12px] text-muted">
          <tr>
            <th className="py-1 font-medium">Role</th>
            <th className="py-1 font-medium">Runs on</th>
            <th className="py-1 font-medium">At a limit</th>
          </tr>
        </thead>
        <tbody>
          {proposal.roles.map((p) => (
            <tr key={p.roleId} className="border-t border-[var(--border-hairline)] align-top">
              <td className="py-2 pr-3">
                <b className="font-medium">{p.title}</b>
                <div className="text-[12px] text-muted">{p.why}</div>
              </td>
              <td className="py-2 pr-3">
                {CLI_LABEL[p.cli]} · <span className="font-term">{p.model || "default"}</span>
                {p.free && <span className="ml-1.5 rounded-full bg-[var(--color-ok-soft,rgba(63,185,80,0.12))] px-1.5 text-[12px] text-[#10b981]">free</span>}
              </td>
              <td className="py-2 text-muted">{p.fallback ? `${CLI_LABEL[p.fallback.cli]} · ${p.fallback.model}` : "waits"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[13px] text-muted">
        Sandboxes: {proposal.sandbox.cpus} CPUs · {proposal.sandbox.memoryGb} GB each, so about {proposal.maxAgents} agents fit in your {snap.setup.machine.memoryGb} GB at once.
        Agents with a size you chose keep it; an existing sandbox gets the new size when you recreate it.
      </p>
      {proposal.install.length > 0 && (
        <p className="text-[13px]">
          Run first: <code className="rounded-lg border border-[var(--border-hairline)] px-1.5 font-term text-[12px]">{proposal.install.join(" && ")}</code>
        </p>
      )}
      {proposal.keysToAdd.length > 0 && (
        <div className="text-[13px]">
          <div className="text-muted">More free models with a key (add it in Settings → Accounts):</div>
          <ul className="mt-1 flex flex-col gap-1">
            {proposal.keysToAdd.map((k) => (
              <li key={k.source}>
                <a className="underline" href={k.signup} target="_blank" rel="noreferrer">
                  {FREE_SOURCE_INFO[k.source].label}
                </a>{" "}
                <span className="text-muted">· {k.limits}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!isViewer && (
        <div className="flex items-center gap-3">
          <button className="btn btn-primary" onClick={apply} disabled={applied}>
            {applied ? "Applied" : "Apply to every role"}
          </button>
          {applied && <span className="text-[13px] text-muted">Each agent picks it up at its next start.</span>}
        </div>
      )}
    </section>
  );
}
