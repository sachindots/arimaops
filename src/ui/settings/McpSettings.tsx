import { useState } from "react";
import type { ToolServer } from "../../data/generated";
import { chosenTools, STACK_CATALOG } from "../../data/stack";
import { getsToolServers } from "../../data/types";
import { useAuth } from "../../store/auth";
import { officeActions, useOffice } from "../../store/office";
import { ago, Field, SectionTitle, useNow } from "../kit";
import { Select } from "../primitives/Select";
import { Toggle } from "./controls";

const status = (s: ToolServer): [string, string] =>
  s.blocked ? ["Blocked", "var(--color-red)"] : !s.check ? ["Not checked", "var(--color-muted)"] : s.check.ok ? ["Ready", "var(--color-green)"] : ["Can't connect", "var(--color-red)"];

/** This project's tool servers, their last check, and which agents get them. */
export function McpSettings() {
  const mcp = useOffice((s) => s.snap?.mcp);
  const team = useOffice((s) => s.snap?.config.team) ?? [];
  const stack = useOffice((s) => s.snap?.config.stack);
  const owner = useAuth((s) => s.role === "owner" || s.status === "none");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", url: "", apiKey: "" });
  const now = useNow(30_000);
  if (!mcp || !("others" in mcp)) return <p className="text-[13px] text-muted">Loading tool servers…</p>;

  const servers = mcp.servers;
  const seats = team.filter(getsToolServers);
  const copyable = mcp.others.filter((o) => !servers.some((s) => s.name === o.name));
  const suggestions = chosenTools(stack).filter((t) => t.mcp && !servers.some((s) => s.name === t.id));
  const toggle = (agentId: string, name: string, on: boolean) => {
    const cur = team.find((a) => a.id === agentId)?.mcp ?? [];
    officeActions.setAgentMcp(agentId, on ? [...cur, name] : cur.filter((n) => n !== name));
  };
  const tip = missingParam(form.url);
  const canAdd = /^[a-z0-9][a-z0-9_-]{0,39}$/.test(form.name.trim().toLowerCase()) && form.url.trim();
  const add = () => {
    officeActions.addMcp({ name: form.name.trim().toLowerCase(), url: form.url.trim(), apiKey: form.apiKey.trim() || undefined });
    setForm({ name: "", url: "", apiKey: "" });
  };

  return (
    <div className="flex flex-col gap-5">
      <p className="m-0 text-[13px] text-muted">
        Tool servers for this project's agents. Each project keeps its own list and keys. This build supports servers with a URL. Tick a server for an
        agent and it gets it at its next start.
      </p>

      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <SectionTitle>Tool servers</SectionTitle>
          <div className="flex items-center gap-2">
            {copyable.length > 0 && (
              <Select
                size="sm"
                value=""
                placeholder="Copy from project"
                aria-label="Copy a tool server from another project"
                options={copyable.map((o) => ({ value: `${o.projectId}/${o.name}`, label: o.name, group: o.project }))}
                onChange={(v) => {
                  const o = copyable.find((c) => `${c.projectId}/${c.name}` === v);
                  if (o) officeActions.copyMcp(o.projectId, o.name);
                }}
              />
            )}
            <button className="btn px-2 text-[12px]" onClick={() => officeActions.refreshMcp()}>
              Refresh
            </button>
          </div>
        </div>
        {mcp.error && <p className="mb-2 border border-orange bg-[rgba(192,77,255,0.14)] px-3 py-1.5 text-[13px]">{mcp.error}</p>}
        {servers.length === 0 ? (
          <p className="text-[13px] text-muted">No tool servers in this project yet. Add one below or copy one from another project.</p>
        ) : (
          <div className="panel">
            {servers.map((s) => {
              const [label, color] = status(s);
              const pack = s.source.kind === "pack" ? s.source.packId : null;
              return (
                <div key={s.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t-2 border-dashed border-cream-3 px-3 py-2 first:border-t-0">
                  <b className="font-term text-[13px]">{s.name}</b>
                  <span className="text-[12px] text-muted">{pack ? `From pack ${pack}` : "Added here"}</span>
                  <span className="chip chip-dot text-[12px]" style={{ ["--c" as string]: color }}>
                    {label}
                  </span>
                  {s.check && <span className="text-[12px] text-muted">checked {ago(s.check.at, now)} ago</span>}
                  <span className="flex-1" />
                  {pack ? (
                    <span className="text-[12px] text-muted">Change it through its pack</span>
                  ) : deleting === s.name ? (
                    <>
                      <span className="text-[12px] text-red">Removes it from this project and its agents.</span>
                      <button
                        className="btn px-2 text-[12px]"
                        onClick={() => {
                          officeActions.removeMcp(s.name);
                          setDeleting(null);
                        }}
                      >
                        Delete
                      </button>
                      <button className="text-[12px] underline" onClick={() => setDeleting(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button className="text-[12px] underline" onClick={() => setDeleting(s.name)}>
                      Delete…
                    </button>
                  )}
                  {s.blocked && <p className="m-0 w-full text-[12px] text-red">Not given to agents: {s.blocked}</p>}
                  {s.check?.error && <p className="m-0 w-full text-[12px] text-red">{s.check.error}</p>}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {servers.length > 0 && (
        <section>
          <SectionTitle>Which agents get them</SectionTitle>
          {seats.length === 0 ? (
            <p className="text-[13px] text-muted">Tool servers go to agents in Container mode. No agent in this project uses it.</p>
          ) : (
            <table className="w-full panel text-[13px]">
              <thead>
                <tr className="bg-cream-2 text-left">
                  <th className="px-3 py-1.5">Server</th>
                  {seats.map((a) => (
                    <th key={a.id} className="px-3 py-1.5 text-center">
                      {a.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {servers.map((s) => (
                  <tr key={s.name} className="border-t-2 border-dashed border-cream-3">
                    <td className="px-3 py-1.5 font-term text-[12px]">{s.name}</td>
                    {seats.map((a) => (
                      <td key={a.id} className="px-3 py-1.5 text-center">
                        <input
                          type="checkbox"
                          checked={(a.mcp ?? []).includes(s.name)}
                          aria-label={`${s.name} for ${a.name}`}
                          onChange={(e) => toggle(a.id, s.name, e.target.checked)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {seats.length > 0 && team.some((a) => !getsToolServers(a)) && (
            <p className="mt-1 text-[12px] text-muted">Agents in other modes aren't listed: tool servers go to Container mode agents.</p>
          )}
        </section>
      )}

      <section className="panel p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionTitle>Tools as code</SectionTitle>
          {owner ? (
            <Toggle checked={mcp.toolsAsCode} label={mcp.toolsAsCode ? "On" : "Off"} onChange={(on) => officeActions.setToolsAsCode(on)} />
          ) : (
            <span className="text-[12px] text-muted">{mcp.toolsAsCode ? "On" : "Off"}. Only the owner changes this.</span>
          )}
        </div>
        <p className="m-0 mt-1 text-[13px] text-muted">
          Agents get one tool that runs short scripts calling HQ's tools and their tool servers, in place of every tool listed one by one. That keeps
          their context smaller when they have many tools. Each script runs in a fresh, locked-down process in the agent's own container; keys stay
          in HQ. Applies at each agent's next start; turning it off stops scripts at once.
        </p>
      </section>

      <section className="panel p-3">
        <SectionTitle>Add a server</SectionTitle>
        {suggestions.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[13px]">
            <span className="text-muted">From your stack:</span>
            {suggestions.map((t) => (
              <button key={t.id} className="btn px-2 text-[12px]" onClick={() => setForm({ ...form, name: t.id, url: t.mcp ?? "" })}>
                {t.name}
              </button>
            ))}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" hint="Letters, numbers, - or _">
            <input className="field w-full font-term text-[13px]" value={form.name} placeholder="supabase" onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="URL">
            <input className="field w-full font-term text-[13px]" value={form.url} placeholder="https://mcp.example.com/mcp" onChange={(e) => setForm({ ...form, url: e.target.value })} />
          </Field>
          <Field label="API key (optional)" hint="Sent as a Bearer token. Stored encrypted in HQ's vault for this project and never shown again. Leave empty if the server needs none.">
            <input
              type="password"
              autoComplete="off"
              className="field w-full font-term text-[13px]"
              value={form.apiKey}
              placeholder="••••"
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            />
          </Field>
        </div>
        {tip && <p className="mt-2 text-[13px] text-muted">{tip}</p>}
        <div className="mt-3 flex items-center gap-3">
          <button className="btn" disabled={!canAdd} onClick={add}>
            Add server
          </button>
        </div>
      </section>
    </div>
  );
}

/** A stack tool's MCP URL without its suggested parameter (e.g. Supabase without project_ref): returns the tip. */
function missingParam(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const tool = STACK_CATALOG.find((t) => t.mcp && t.mcpParam && new URL(t.mcp).host === u.host);
  return tool?.mcpParam && !u.searchParams.get(tool.mcpParam.name)?.trim() ? tool.mcpParam.hint : null;
}
