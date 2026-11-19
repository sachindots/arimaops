import { useId, useState } from "react";
import { SERVICE_KEYS, type BasePolicy, type SbxRule } from "../../data/types";
import { officeActions, useOffice } from "../../store/office";
import { Dot, Field, SectionTitle } from "../kit";
import { ChipList, CommitInput, isDomain } from "./controls";
import { ResourcesSection } from "./ResourcesSection";
import { ask } from "../dialog";

const BASE: Record<BasePolicy, string> = {
  "allow-all": "Allow all — every outbound connection is allowed",
  balanced: "Balanced — blocked by default; AI services, package registries and common dev sites allowed",
  "deny-all": "Deny all — everything blocked unless a rule allows it",
  unknown: "Unknown — sbx didn't say",
};

const SOURCE: Record<SbxRule["source"], string> = { hq: "HQ", kit: "agent kit", org: "your org", cli: "sbx CLI" };
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Write-only editor for .env app variables (displays key names + •••• only, never secret values). */
function EnvVarEditor({
  keys,
  inherited,
  filePath,
  fileExists,
  onSet,
  onRemove,
  onOpenFile,
  suggestGithubToken,
}: {
  keys: string[];
  inherited?: string[];
  filePath?: string;
  fileExists?: boolean;
  onSet: (name: string, value: string) => void;
  onRemove: (name: string) => void;
  onOpenFile?: () => void;
  suggestGithubToken?: boolean;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const nameId = useId();
  const valId = useId();
  const trimmedName = name.trim();
  const nameInvalid = !!trimmedName && !ENV_NAME_RE.test(trimmedName);
  const trimmedVal = value.trim();
  const valInvalid = /[\r\n]/.test(trimmedVal);
  const canSave = ENV_NAME_RE.test(trimmedName) && !!trimmedVal && !valInvalid;
  const extraInherited = (inherited ?? []).filter((k) => !keys.includes(k));

  return (
    <div className="@container flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {keys.length === 0 && <span className="text-[13px] text-muted">No variables saved here yet.</span>}
        {keys.map((k) => (
          <span key={k} className="chip font-term text-[12px]">
            {k} <span className="text-muted">••••</span>
            <button
              type="button"
              className="ml-1 text-[12px]"
              aria-label={`Remove ${k}`}
              onClick={() => void ask.confirm(`Remove ${k} from App variables?`, undefined, { ok: "Remove", danger: true }).then((ok) => ok && onRemove(k))}
            >
              ✕
            </button>
          </span>
        ))}
        {suggestGithubToken && !keys.includes("GH_TOKEN") && (
          <button type="button" className="chip cursor-pointer font-term text-[12px] hover:border-ink" onClick={() => setName("GH_TOKEN")}>
            + GH_TOKEN
          </button>
        )}
      </div>

      {extraInherited.length > 0 && (
        <p className="text-[12px] text-muted">
          Inherited from project: <span className="font-term text-ink">{extraInherited.join(", ")}</span>
        </p>
      )}

      <form
        className="grid grid-cols-1 gap-2 @[520px]:grid-cols-[170px_1fr_auto] @[520px]:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSave) return;
          onSet(trimmedName, trimmedVal);
          setName("");
          setValue("");
          setShow(false);
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={nameId} className="text-[13px] font-medium text-ink">
            Variable
          </label>
          <input
            id={nameId}
            className="field font-term text-[13px]"
            placeholder="GH_TOKEN"
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={valId} className="text-[13px] font-medium text-ink">
            Value
          </label>
          <div className="flex items-center gap-1.5">
            <input
              id={valId}
              className="field font-term text-[13px]"
              type={show ? "text" : "password"}
              autoComplete="off"
              placeholder="Paste value (write-only)"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <button type="button" className="btn px-2 text-[12px]" onClick={() => setShow((v) => !v)}>
              {show ? "Hide" : "Show"}
            </button>
          </div>
        </div>
        <button className="btn text-[13px]" type="submit" disabled={!canSave}>
          Save
        </button>
      </form>
      {nameInvalid && <p className="text-[12px] text-red">Use letters, digits and underscores, starting with a letter or _.</p>}
      {valInvalid && <p className="text-[12px] text-red">Value must be a single line.</p>}

      <div className="flex items-center gap-2 pt-0.5">
        <code className="min-w-0 flex-1 truncate rounded-lg border border-white/10 bg-cream px-2 py-0.5 font-term text-[12px]" title={filePath}>
          {filePath ?? "—"}
        </code>
        {onOpenFile && (
          <button type="button" className="btn text-[12px]" onClick={onOpenFile}>
            {fileExists ? "Open" : "Create & open"}
          </button>
        )}
      </div>
    </div>
  );
}

/** Add / remove service keys for one scope (an agent's sandbox, or every sandbox). */
function KeyEditor({ keys, onSet, onRemove, disabled }: { keys: string[]; onSet: (service: string, value: string) => void; onRemove: (s: string) => void; disabled?: string }) {
  const [service, setService] = useState<string>(SERVICE_KEYS[0]);
  const [value, setValue] = useState("");
  return (
    <div>
      <ul className="mb-2 flex flex-wrap gap-1.5">
        {keys.length === 0 && <li className="text-[13px] text-muted">None</li>}
        {keys.map((k) => (
          <li key={k} className="chip font-term text-[12px]">
            {k} <span className="text-muted">••••</span>
            <button className="ml-1 text-[12px]" aria-label={`Remove ${k} key`} onClick={() => void ask.confirm(`Remove the ${k} key from sbx?`, undefined, { ok: "Remove", danger: true }).then((ok) => ok && onRemove(k))}>
              ✕
            </button>
          </li>
        ))}
      </ul>
      {disabled ? (
        <p className="text-[12px] text-muted">{disabled}</p>
      ) : (
        <form
          className="grid grid-cols-[150px_1fr_auto] items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!value) return;
            onSet(service, value);
            setValue("");
          }}
        >
          <Field label="Service">
            <select className="field" value={service} onChange={(e) => setService(e.target.value)}>
              {SERVICE_KEYS.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label="Key / token">
            <input className="field" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
          <button className="btn" type="submit" disabled={!value}>
            Store
          </button>
        </form>
      )}
    </div>
  );
}

export function SandboxSettingsTab({ initialAgentId }: { initialAgentId?: string }) {
  const snap = useOffice((s) => s.snap);
  const live = useOffice((s) => s.live);
  const [agentId, setAgentId] = useState(initialAgentId ?? snap?.config.team[0]?.id ?? "");
  if (!snap) return null;
  const agent = snap.config.team.find((a) => a.id === agentId) ?? snap.config.team[0];
  if (!agent) return null;
  const sb = agent.sandbox;
  const sbx = snap.sbx;
  const state = sbx.agents[agent.id];
  const status = snap.agents.find((a) => a.agentId === agent.id);
  const sandboxExists = !!status?.session.sandbox || !!state?.rules.length;
  const update = (patch: Parameters<typeof officeActions.updateSandbox>[1]) => officeActions.updateSandbox(agent.id, patch);
  const port = snap.config.project.hqPort;

  const copyToAll = () => {
    for (const a of snap.config.team) if (a.id !== agent.id) officeActions.updateSandbox(a.id, { allow: [...sb.allow], deny: [...sb.deny] });
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-[20px] font-semibold">This project — all agents</h3>
        <button className="btn text-[13px]" onClick={() => officeActions.refreshSbx()} title="Read rules, keys and proxy from sbx again">
          Refresh from sbx
        </button>
      </div>

      <section className="panel p-3">
        <SectionTitle>App variables for all agents</SectionTitle>
        <p className="mb-3 text-[13px] text-muted">
          Every agent in this project inherits these variables (ideal for <code className="font-term text-[12px]">GH_TOKEN</code>). Stored write-only at mode 0600 on disk and never echoed back. Restart running agents to apply changes.
        </p>
        <EnvVarEditor
          keys={sbx.projectEnv?.keys ?? []}
          filePath={sbx.projectEnv?.path}
          fileExists={sbx.projectEnv?.exists}
          suggestGithubToken
          onSet={(n, v) => officeActions.setEnvVar(null, n, v)}
          onRemove={(n) => officeActions.removeEnvVar(null, n)}
        />
      </section>

      <h3 className="-mb-2 mt-2 font-display text-[20px] font-semibold">This agent</h3>

      <div className="flex flex-wrap items-center gap-2">
        {snap.config.team.map((a) => (
          <button key={a.id} className="btn flex items-center gap-1.5 text-[13px]" aria-pressed={a.id === agent.id} onClick={() => setAgentId(a.id)}>
            <Dot color={a.color} size={8} /> {a.name}
          </button>
        ))}
      </div>

      {agent.mode === "local" && (
        <p className="border border-orange bg-[rgba(192,77,255,0.14)] px-3 py-2 text-[13px]">
          {agent.name} runs in Local mode, so sandbox settings don't apply until it's switched to Sandbox or Container. App variables still apply.
        </p>
      )}

      <ResourcesSection agent={agent} status={status} team={snap.config.team} machine={snap.setup.machine} />

      <section className="panel p-3">
        <div className="flex items-center justify-between">
          <SectionTitle>Network for {agent.name}'s sandbox</SectionTitle>
          <button className="btn mb-2 px-2 text-[12px]" onClick={copyToAll} title="Copy these allowed and blocked domains to every agent">
            Copy to all agents
          </button>
        </div>
        <p className="mb-3 text-[13px] text-muted">
          On top of the machine's base policy ({sbx.basePolicy}). Blocked wins over allowed. Applied with{" "}
          <code className="font-term text-[12px]">sbx policy allow/deny network --sandbox</code>.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Allowed domains">
            <ChipList items={sb.allow} onChange={(allow) => update({ allow })} placeholder="registry.npmjs.org" validate={isDomain} />
          </Field>
          <Field label="Blocked domains">
            <ChipList items={sb.deny} onChange={(deny) => update({ deny })} placeholder="*.googleapis.com" validate={isDomain} />
          </Field>
        </div>
        {state?.syncError && <p className="mt-2 border-2 border-red bg-[rgba(255,23,68,0.16)] px-2 py-1 text-[13px] text-red">sbx: {state.syncError}</p>}
        <div className="mt-3">
          <div className="mb-1 text-[13px] font-semibold">Rules in effect {live ? "(read from sbx)" : "(demo)"}</div>
          {!sandboxExists ? (
            <p className="text-[12px] text-muted">{agent.name}'s sandbox doesn't exist yet. The rules above are applied when it's created on first Start.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {state?.rules.length === 0 && <li className="text-[12px] text-muted">No sandbox-specific rules.</li>}
              {state?.rules.map((r) =>
                r.resources.map((res) => (
                  <li key={`${r.id}-${res}`} className="chip font-term text-[13px]" style={{ ["--c" as string]: r.decision === "allow" ? "#3fb950" : "#ff2a4b" }} title={`${r.decision} · added by ${SOURCE[r.source]}`}>
                    {r.decision === "allow" ? "✓" : "✗"} {res} <span className="text-[12px] text-muted">{SOURCE[r.source]}</span>
                  </li>
                )),
              )}
            </ul>
          )}
        </div>
      </section>

      <section className="panel p-3">
        <SectionTitle>Service keys for {agent.name} only</SectionTitle>
        <p className="mb-2 text-[13px] text-muted">
          The host proxy adds these to {agent.name}'s requests, so the key never enters the VM. HQ passes the value straight to{" "}
          <code className="font-term text-[12px]">sbx secret set</code> and never stores it.
        </p>
        <KeyEditor
          keys={state?.keys ?? []}
          disabled={sandboxExists ? undefined : `Start ${agent.name} once to add keys only for this sandbox. Keys for every sandbox are under This machine.`}
          onSet={(service, value) => officeActions.setSecret(agent.id, service, value)}
          onRemove={(service) => officeActions.removeSecret(agent.id, service)}
        />
      </section>

      <section className="panel p-3">
        <SectionTitle>App variables for {agent.name} only</SectionTitle>
        <p className="mb-3 text-[13px] text-muted">
          Overrides project-wide variables for {agent.name} (<code className="font-term text-[12px]">DATABASE_URL</code>, <code className="font-term text-[12px]">STRIPE_KEY</code>…). Restart {agent.name} after editing.
        </p>
        <EnvVarEditor
          keys={state?.envFile.keys ?? []}
          inherited={sbx.projectEnv?.keys ?? []}
          filePath={state?.envFile.path}
          fileExists={state?.envFile.exists}
          onSet={(n, v) => officeActions.setEnvVar(agent.id, n, v)}
          onRemove={(n) => officeActions.removeEnvVar(agent.id, n)}
          onOpenFile={() => officeActions.openEnvFile(agent.id)}
        />
        <p className="mt-2 text-[12px] font-semibold text-orange">⚠ Unlike service keys, these values enter the agent's environment. Use test or development credentials.</p>
      </section>

      <h3 className="-mb-2 mt-2 font-display text-[20px] font-semibold">This machine — all sandboxes</h3>
      <p className="-mt-3 text-[13px] text-muted">These are sbx's machine-wide settings. They affect every sandbox on this machine, including ones HQ didn't create.</p>

      <section className="panel p-3">
        <SectionTitle>Base network policy</SectionTitle>
        <p className="text-[15px]">{BASE[sbx.basePolicy]}</p>
        <p className="mt-1 text-[12px] text-muted">
          Set once with <code className="font-term text-[13px]">sbx policy init</code>. Changing it means <code className="font-term text-[13px]">sbx policy reset</code>, which deletes every rule on this
          machine, so HQ doesn't do it. HQ always allows <code className="font-term text-[13px]">localhost:{port}</code> and{" "}
          <code className="font-term text-[13px]">host.docker.internal:{port}</code> so agents can reach it.{" "}
          <a className="underline" href="https://docs.docker.com/ai/sandboxes/security/" target="_blank" rel="noreferrer">
            Docs ↗
          </a>
        </p>
      </section>

      <section className="panel p-3">
        <SectionTitle>Upstream proxy</SectionTitle>
        <Field label="Proxy URL" hint="Optional. All sandbox traffic goes through this proxy. Leave empty for none.">
          <CommitInput className="field font-term text-[13px]" value={sbx.proxy ?? ""} placeholder="http://proxy.internal:3128" onCommit={(v) => officeActions.setProxy(v.trim() || null)} />
        </Field>
      </section>

      <section className="panel p-3">
        <SectionTitle>Service keys for every sandbox</SectionTitle>
        <KeyEditor keys={sbx.globalKeys} onSet={(service, value) => officeActions.setSecret(null, service, value)} onRemove={(service) => officeActions.removeSecret(null, service)} />
      </section>
    </div>
  );
}
