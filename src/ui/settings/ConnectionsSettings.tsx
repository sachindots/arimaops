import { useState } from "react";
import type { ToolConnection } from "../../data/types";
import { officeActions, useOffice } from "../../store/office";
import { useAuth } from "../../store/auth";
import { ask } from "../dialog";
import { Field, SectionTitle } from "../kit";

/**
 * Services HQ calls for the agents (server/connections.ts): the key stays in HQ's vault, agents call only the tools
 * you tick as read tools, and the send tool runs only when you click Send on a proposed send in the Inbox.
 */
export function ConnectionsSettings() {
  const connections = useOffice((s) => s.snap?.connections) ?? [];
  const roles = useOffice((s) => s.snap?.config.template?.roles) ?? [];
  const owner = useAuth((s) => s.role === "owner" || s.status === "none");
  const [form, setForm] = useState({ name: "", url: "", apiKey: "" });
  const valid = /^[a-z0-9][a-z0-9-]{0,39}$/.test(form.name.trim()) && form.url.trim();

  return (
    <section className="flex flex-col gap-3 border-t border-white/[0.08] pt-4">
      <SectionTitle>Connections through HQ</SectionTitle>
      <p className="m-0 text-[13px] text-muted">
        For your CRM, analytics, billing or mail. HQ keeps the key and makes each call, so agents never hold it, even drafts-only ones. Agents call only the
        tools you tick as reading. A send tool runs only when you click Send on a proposal in the Inbox. Nothing is on until you pick roles and tools. A
        read-only key is safest: a tool's name doesn't prove it only reads.
      </p>
      {!owner && <p className="m-0 text-[13px] text-muted">Only the owner can change connections.</p>}
      {connections.map((c) => (
        <ConnectionCard key={c.name} c={c} roles={roles.map((r) => ({ id: r.id, title: r.title }))} disabled={!owner} />
      ))}
      {owner && (
        <form
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1.4fr)_auto] items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            const name = form.name.trim();
            officeActions.saveConnection({ name, url: form.url.trim(), ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}) });
            officeActions.checkConnection(name);
            setForm({ name: "", url: "", apiKey: "" });
          }}
        >
          <Field label="Name">
            <input className="field" value={form.name} placeholder="crm" onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase() })} />
          </Field>
          <Field label="MCP server URL">
            <input className="field" value={form.url} placeholder="https://mcp.example.com/mcp" onChange={(e) => setForm({ ...form, url: e.target.value })} />
          </Field>
          <Field label="Key (optional)">
            <input className="field" type="password" autoComplete="off" value={form.apiKey} placeholder="Sent as a Bearer token" onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
          </Field>
          <button className="btn" type="submit" disabled={!valid}>
            Add
          </button>
        </form>
      )}
    </section>
  );
}

function ConnectionCard({ c, roles, disabled }: { c: ToolConnection; roles: { id: string; title: string }[]; disabled: boolean }) {
  const save = (patch: Omit<Parameters<typeof officeActions.saveConnection>[0], "name">) => officeActions.saveConnection({ ...patch, name: c.name });
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <div className="panel flex flex-col gap-2 p-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <b className="font-term">{c.name}</b>
        <span className="min-w-0 flex-1 truncate font-term text-[12px] text-muted">{c.url}</span>
        <span className="text-[12px] text-muted">{c.hasKey ? "key stored" : "no key"}</span>
        <button className="btn px-2 text-[12px]" disabled={disabled} onClick={() => officeActions.checkConnection(c.name)}>
          Check tools
        </button>
        <button
          className="btn px-2 text-[12px]"
          disabled={disabled}
          onClick={async () => {
            if (await ask.confirm(`Remove ${c.name}?`, "Its key is deleted from HQ's vault and agents lose its tools.", { ok: "Remove", danger: true }))
              officeActions.removeConnection(c.name);
          }}
        >
          Remove
        </button>
      </div>
      <fieldset className="m-0 flex flex-wrap items-center gap-1.5 border-0 p-0" disabled={disabled}>
        <legend className="mb-1 text-[12px] text-muted">Roles that may use it</legend>
        {roles.map((r) => (
          <button key={r.id} type="button" className="btn px-1.5 py-0.5 text-[12px]" aria-pressed={c.roles.includes(r.id)} onClick={() => save({ roles: toggle(c.roles, r.id) })}>
            {c.roles.includes(r.id) ? "✓ " : "+ "}
            {r.title}
          </button>
        ))}
      </fieldset>
      {c.tools.length === 0 ? (
        <p className="m-0 text-[12px] text-muted">{c.probedAt ? "The server lists no tools." : "Check tools to see what the server offers."}</p>
      ) : (
        <table className="w-full text-left text-[12px]">
          <thead className="text-muted">
            <tr>
              <th className="py-1 font-normal">Tool</th>
              <th className="py-1 font-normal">Reads only</th>
              <th className="py-1 font-normal">Send (your click)</th>
            </tr>
          </thead>
          <tbody>
            {c.tools.map((t) => (
              <tr key={t.name} className="border-t border-white/[0.06] align-top">
                <td className="py-1 pr-2">
                  <span className="font-term">{t.name}</span>
                  {t.description && <div className="text-muted">{t.description}</div>}
                </td>
                <td className="py-1">
                  <input
                    type="checkbox"
                    disabled={disabled || c.send === t.name}
                    checked={c.read.includes(t.name)}
                    aria-label={`${t.name} reads only`}
                    onChange={() => save({ read: toggle(c.read, t.name) })}
                  />
                </td>
                <td className="py-1">
                  <input
                    type="radio"
                    name={`send-${c.name}`}
                    disabled={disabled || c.read.includes(t.name)}
                    checked={c.send === t.name}
                    aria-label={`${t.name} is the send tool`}
                    onChange={() => save({ send: t.name })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {c.send && (
        <button className="self-start text-[12px] underline" disabled={disabled} onClick={() => save({ send: null })}>
          No send tool
        </button>
      )}
    </div>
  );
}
