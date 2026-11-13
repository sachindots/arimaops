import { useState } from "react";
import { clisFor, PROVIDER_SPECS, PROVIDERS, type Provider } from "../../data/providers";
import { CLI_LABEL } from "../../data/types";
import { isViewer, officeActions, useOffice } from "../../store/office";
import { ago, Field, SectionTitle, useNow } from "../kit";

const MASTER: Record<"env" | "keychain" | "file", [string, string]> = {
  env: ["Master key from ARIMA_MASTER_KEY", "#3fb950"],
  keychain: ["Master key in this computer's keychain", "#3fb950"],
  file: ["Master key in a file beside the vault", "#d29922"],
};

const EMPTY = { id: "", provider: "anthropic" as Provider, label: "", fields: {} as Record<string, string>, secret: "" };

/** API keys and cloud credentials agents can use. Stored encrypted on the server; this page never sees a key again after you save it. */
export function AccountsSettings() {
  const state = useOffice((s) => s.snap?.accounts);
  const team = useOffice((s) => s.snap?.config.team) ?? [];
  const now = useNow(60_000);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const list = state?.list ?? [];
  const spec = PROVIDER_SPECS[form.provider];
  const name = form.id.trim().toLowerCase();
  const canSave = /^[a-z0-9][a-z0-9-]{0,31}$/.test(name) && name !== "default" && (editing ? true : !!form.secret.trim()) && spec.fields.every((f) => f.id !== "projectId" || form.fields[f.id]?.trim());

  const save = () => {
    officeActions.saveAccount({ id: name, provider: form.provider, label: form.label.trim() || undefined, fields: form.fields, secret: form.secret.trim() || undefined });
    setForm(EMPTY);
    setEditing(null);
  };

  return (
    <div className="flex flex-col gap-5">
      <p className="m-0 text-[14px] text-muted">
        Give agents an API key or cloud account instead of (or besides) your CLI subscriptions. Keys are encrypted on the server, sent only to the agent
        that uses them when it starts, and hidden as ••••1a2b if anything prints them. Pick an account for an agent in its panel.
      </p>

      {state?.error && <p className="m-0 border border-red px-3 py-1.5 text-[13px]">{state.error}</p>}
      {state?.masterSource && (
        <p className="m-0 flex flex-wrap items-center gap-2 text-[13px]">
          <span className="chip chip-dot text-[12px]" style={{ ["--c" as string]: MASTER[state.masterSource][1] }}>
            {MASTER[state.masterSource][0]}
          </span>
          {state.masterSource === "file" && (
            <span className="text-muted">
              Anyone who can read your home folder can read it. On a server, set <code>ARIMA_MASTER_KEY</code> from your secret manager instead.
            </span>
          )}
        </p>
      )}

      <section>
        <SectionTitle>Accounts</SectionTitle>
        {list.length === 0 ? (
          <p className="text-[13px] text-muted">No accounts yet. Agents use your CLI subscriptions until you add one.</p>
        ) : (
          <div className="border border-ink">
            {list.map((a) => {
              const users = team.filter((t) => t.account === a.id);
              return (
                <div key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t-2 border-dashed border-cream-3 px-3 py-2 first:border-t-0">
                  <b className="font-term text-[17px]">{a.id}</b>
                  <span className="text-[13px]">{PROVIDER_SPECS[a.provider].label}</span>
                  {a.label !== PROVIDER_SPECS[a.provider].label && <span className="text-[12px] text-muted">{a.label}</span>}
                  <span className="font-mono text-[12px] text-muted">{a.secret ? `••••${a.secret.last4} · ${ago(a.secret.updatedAt, now)}` : "no key"}</span>
                  <span className="text-[12px] text-muted">
                    {users.length ? `Used by ${users.map((u) => u.name).join(", ")}` : `For ${clisFor(a.provider).map((c) => CLI_LABEL[c]).join(", ")}`}
                  </span>
                  <span className="flex-1" />
                  {!isViewer && (
                    <>
                      <button
                        className="btn px-2 text-[12px]"
                        onClick={() => {
                          setEditing(a.id);
                          setForm({ id: a.id, provider: a.provider, label: a.label, fields: { ...a.fields }, secret: "" });
                        }}
                      >
                        Edit / replace key
                      </button>
                      {removing === a.id ? (
                        <button className="btn border-red px-2 text-[12px] text-red" onClick={() => (officeActions.removeAccount(a.id), setRemoving(null))}>
                          Delete key for good
                        </button>
                      ) : (
                        <button className="btn px-2 text-[12px]" onClick={() => setRemoving(a.id)}>
                          Remove
                        </button>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {!isViewer && (
        <section className="flex max-w-[560px] flex-col gap-3">
          <SectionTitle>{editing ? `Edit ${editing}` : "Add an account"}</SectionTitle>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Provider">
              <select
                className="field"
                value={form.provider}
                disabled={!!editing}
                onChange={(e) => setForm({ ...form, provider: e.target.value as Provider, fields: {} })}
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {PROVIDER_SPECS[p].label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Name" hint="Short: work, client-a, bedrock-us">
              <input className="field" value={form.id} disabled={!!editing} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="work" autoComplete="off" />
            </Field>
            {spec.fields.map((f) => (
              <Field key={f.id} label={f.label}>
                <input className="field" value={form.fields[f.id] ?? ""} placeholder={f.placeholder} onChange={(e) => setForm({ ...form, fields: { ...form.fields, [f.id]: e.target.value } })} />
              </Field>
            ))}
            <Field label="Label (optional)">
              <input className="field" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder={spec.label} />
            </Field>
          </div>
          <Field label={spec.secretLabel} hint={editing ? "Leave empty to keep the stored one." : spec.secretHint}>
            {spec.auth === "cloud" ? (
              <textarea
                className="field min-h-[96px] font-mono text-[12px]"
                value={form.secret}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setForm({ ...form, secret: e.target.value })}
                placeholder={spec.secretHint}
              />
            ) : (
              <input className="field font-mono" type="password" value={form.secret} autoComplete="new-password" onChange={(e) => setForm({ ...form, secret: e.target.value })} />
            )}
          </Field>
          <p className="m-0 text-[12px] text-muted">Works with: {clisFor(form.provider).map((c) => CLI_LABEL[c]).join(", ")}. Local and Container mode.</p>
          <div className="flex gap-2">
            <button className="btn border-green text-green" disabled={!canSave} onClick={save}>
              {editing ? "Save" : "Add account"}
            </button>
            {editing && (
              <button className="btn" onClick={() => (setEditing(null), setForm(EMPTY))}>
                Cancel
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
