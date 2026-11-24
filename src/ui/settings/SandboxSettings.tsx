import { useId, useState } from "react";
import { SERVICE_KEYS, type EgressBlock, type EgressMode } from "../../data/types";
import { useAuth } from "../../store/auth";
import { officeActions, useOffice } from "../../store/office";
import { Dot, Field, SectionTitle, ago, useNow } from "../kit";
import { Select } from "../primitives/Select";
import { ChipList, isDomain } from "./controls";
import { ResourcesSection } from "./ResourcesSection";
import { ask } from "../dialog";

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
            <Select
              value={service}
              onChange={setService}
              ariaLabel="Service"
              options={SERVICE_KEYS.map((s) => ({ value: s, label: s }))}
            />
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

const MODES: { value: EgressMode; label: string }[] = [
  { value: "off", label: "Off: no proxy" },
  { value: "observe", label: "Observe: block nothing" },
  { value: "enforce", label: "Enforce: block unlisted hosts" },
];

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Switching to enforce lists what it would have blocked this week and warns about SSH remotes first. */
async function changeMode(mode: EgressMode, blocks: EgressBlock[]) {
  if (mode === "enforce") {
    const recent = blocks.filter((b) => Date.now() - Date.parse(b.lastSeen) < WEEK_MS);
    const list = recent.length
      ? `In the last 7 days, enforce mode would have blocked:\n${recent.slice(0, 12).map((b) => `• ${b.port === 80 || b.port === 443 ? b.host : `${b.host}:${b.port}`} (${b.count})`).join("\n")}${recent.length > 12 ? `\n…and ${recent.length - 12} more` : ""}`
      : "Nothing was recorded as blocked in the last 7 days.";
    const ok = await ask.confirm(
      "Switch this project to enforce?",
      `${list}\n\nAgents start on an internal network where HQ is the only way out. Each blocked host appears in the Inbox to allow once, always or deny.\n\nGit over SSH (port 22) stops working: use HTTPS remotes. Applies at each agent's next start.`,
      { ok: "Switch to enforce", danger: true },
    );
    if (!ok) return;
  }
  officeActions.setEgressMode(mode);
}

/** The project's network mode and the hosts its agents reached that enforce mode would block. */
function EgressSection() {
  const egress = useOffice((s) => s.snap?.sbx.egress);
  const requests = useOffice((s) => s.snap?.accessRequests);
  const denied = (requests ?? []).filter((r) => r.status === "denied");
  const owner = useAuth((s) => s.role === "owner" || s.status === "none");
  const now = useNow(30_000);
  if (!egress) return null;
  const hostLabel = (host: string, port: number) => (port === 80 || port === 443 ? host : `${host}:${port}`);

  return (
    <section className="panel p-3">
      <SectionTitle>Network for all agents</SectionTitle>
      <p className="mb-3 text-[13px] text-muted">
        Agents reach the internet through HQ's proxy. Observe mode blocks nothing public: it lists each host that enforce mode would block, so you can allow what this project needs first. Private-network addresses (an internal registry or database) are refused in every mode until you allow that host for this project. Mode changes apply at each agent's next start; allowed hosts apply at once.
      </p>
      <Field label="Mode" hint={owner ? undefined : "Only the owner can change the mode or allow hosts."}>
        <Select value={egress.mode} onChange={(m) => void changeMode(m as EgressMode, egress.wouldBlock)} ariaLabel="Network mode" options={MODES} disabled={!owner} />
      </Field>
      {egress.mode === "enforce" && (
        <p className="mt-2 text-[13px] text-muted">
          Agents run on an internal network with HQ as the only way out. Hosts not allowed below are refused and appear in the Inbox. Git over SSH doesn't work here: use HTTPS remotes.
        </p>
      )}

      <h4 className="mb-2 mt-4 text-[13px] font-semibold text-ink">Would be blocked in enforce mode</h4>
      {egress.mode === "off" ? (
        <p className="text-[13px] text-muted">Nothing is recorded while the mode is off.</p>
      ) : egress.wouldBlock.length === 0 ? (
        <p className="text-[13px] text-muted">Nothing yet. Every host the agents reached is allowed.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-white/10">
          {egress.wouldBlock.map((b) => (
            <li key={`${b.host}:${b.port}`} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate font-term text-[13px] text-ink" title={`${b.host}:${b.port}`}>
                  {hostLabel(b.host, b.port)}
                </div>
                <div className="text-[12px] text-muted">
                  {b.agents.join(", ")} · {b.count} {b.count === 1 ? "request" : "requests"} · last {ago(b.lastSeen, now)} ago
                </div>
                {b.packs && b.packs.length > 0 && (
                  <div className="text-[12px] text-amber">Not declared by {b.packs.length === 1 ? "the pack" : "the packs"} {b.packs.join(", ")}</div>
                )}
              </div>
              {owner && (
                <div className="flex gap-1.5">
                  <button type="button" className="btn text-[12px]" onClick={() => officeActions.allowEgressHost(b.host, b.port)}>
                    Allow for this project
                  </button>
                  <button type="button" className="btn text-[12px]" onClick={() => officeActions.ignoreEgressHost(b.host, b.port)}>
                    Ignore
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {egress.rules.length > 0 && (
        <>
          <h4 className="mb-2 mt-4 text-[13px] font-semibold text-ink">Allowed for this project</h4>
          <ul className="flex flex-wrap gap-1.5">
            {egress.rules.map((r) => (
              <li key={r} className="chip font-term text-[12px]">
                {r}
                {owner && (
                  <button type="button" className="ml-1 text-[12px]" aria-label={`Remove ${r}`} onClick={() => officeActions.removeEgressRule(r)}>
                    ✕
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {denied.length > 0 && (
        <>
          <h4 className="mb-2 mt-4 text-[13px] font-semibold text-ink">Denied</h4>
          <p className="mb-2 text-[12px] text-muted">An agent is never asked about a denied host again. Clear it to be asked next time.</p>
          <ul className="flex flex-col divide-y divide-white/10">
            {denied.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-term text-[13px] text-ink" title={r.domain}>{r.domain}</div>
                  <div className="text-[12px] text-muted">{r.agentId}</div>
                </div>
                {owner && (
                  <button type="button" className="btn text-[12px]" onClick={() => officeActions.resolveAccess(r.id, "clear")}>
                    Clear
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export function SandboxSettingsTab({ initialAgentId }: { initialAgentId?: string }) {
  const snap = useOffice((s) => s.snap);
  const [agentId, setAgentId] = useState(initialAgentId ?? snap?.config.team[0]?.id ?? "");
  if (!snap) return null;
  const agent = snap.config.team.find((a) => a.id === agentId) ?? snap.config.team[0];
  if (!agent) return null;
  const sb = agent.sandbox;
  const sbx = snap.sbx;
  const state = sbx.agents[agent.id];
  const status = snap.agents.find((a) => a.agentId === agent.id);
  const update = (patch: Parameters<typeof officeActions.updateSandbox>[1]) => officeActions.updateSandbox(agent.id, patch);

  const copyToAll = () => {
    for (const a of snap.config.team) if (a.id !== agent.id) officeActions.updateSandbox(a.id, { allow: [...sb.allow], deny: [...sb.deny] });
  };

  return (
    <div className="flex flex-col gap-5">
      <h3 className="font-display text-[20px] font-semibold">This project — all agents</h3>

      <section className="panel p-3">
        <SectionTitle>App variables for all agents</SectionTitle>
        <p className="mb-3 text-[13px] text-muted">
          Every agent in this project inherits these variables (ideal for <code className="font-term text-[12px]">GH_TOKEN</code>). Stored encrypted in HQ's vault and never shown again. Restart running agents to apply changes.
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

      <EgressSection />

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
          {agent.name} runs in Local mode, which this server can't start. Switch it to Container in Settings → Agents and roles.
        </p>
      )}

      <ResourcesSection agent={agent} status={status} team={snap.config.team} machine={snap.setup.machine} />

      <section className="panel p-3">
        <div className="flex items-center justify-between">
          <SectionTitle>Network for {agent.name}</SectionTitle>
          <button className="btn mb-2 px-2 text-[12px]" onClick={copyToAll} title="Copy these allowed and blocked domains to every agent">
            Copy to all agents
          </button>
        </div>
        <p className="mb-3 text-[13px] text-muted">
          Domains this agent may reach, on top of the project's. Blocked wins over allowed. In observe mode these only decide what is listed as would-be-blocked.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Allowed domains">
            <ChipList items={sb.allow} onChange={(allow) => update({ allow })} placeholder="registry.npmjs.org" validate={isDomain} />
          </Field>
          <Field label="Blocked domains">
            <ChipList items={sb.deny} onChange={(deny) => update({ deny })} placeholder="*.googleapis.com" validate={isDomain} />
          </Field>
        </div>
      </section>

      <section className="panel p-3">
        <SectionTitle>Service keys for {agent.name} only</SectionTitle>
        <p className="mb-2 text-[13px] text-muted">
          Stored encrypted in HQ's vault and sent only to {agent.name} when it starts.
        </p>
        <KeyEditor
          keys={state?.keys ?? []}
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
        <p className="mt-2 text-[12px] font-semibold text-orange">⚠ These values enter the agent's environment, and the agent can read them. Use test or development credentials.</p>
      </section>

      <h3 className="-mb-2 mt-2 font-display text-[20px] font-semibold">This server — all agents</h3>

      <section className="panel p-3">
        <SectionTitle>Service keys for every agent</SectionTitle>
        <KeyEditor keys={sbx.globalKeys} onSet={(service, value) => officeActions.setSecret(null, service, value)} onRemove={(service) => officeActions.removeSecret(null, service)} />
      </section>
    </div>
  );
}
