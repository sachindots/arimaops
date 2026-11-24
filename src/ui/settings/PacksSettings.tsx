import { useState } from "react";
import type { PackEntry } from "../../data/generated";
import { useAuth } from "../../store/auth";
import { officeActions, useOffice } from "../../store/office";
import { Field, SectionTitle } from "../kit";

const short = (commit: string) => commit.slice(0, 12);

function status(e: PackEntry): [string, string] {
  if (!e.approved) return ["Waiting for review", "var(--color-amber)"];
  if (e.update) return ["Update waiting for review", "var(--color-amber)"];
  return ["Approved", "var(--color-green)"];
}

/** This project's packs: what each one installs, its pin, and its review state. */
export function PacksSettings() {
  const packs = useOffice((s) => s.snap?.packs);
  const mcp = useOffice((s) => s.snap?.mcp);
  const owner = useAuth((s) => s.role === "owner" || s.status === "none");
  const [form, setForm] = useState({ url: "", plugin: "" });
  const [removing, setRemoving] = useState<string | null>(null);
  const [deleteKeys, setDeleteKeys] = useState(false);
  const [keys, setKeys] = useState<Record<string, string>>({});
  if (!packs) return <p className="text-[13px] text-muted">Packs aren't available on this server.</p>;

  const servers = mcp && "others" in mcp ? mcp.servers : [];
  const entries = Object.entries(packs).filter((e): e is [string, PackEntry] => !!e[1]);
  const add = () => {
    officeActions.addPack(form.url.trim(), form.plugin.trim() || undefined);
    setForm({ url: "", plugin: "" });
  };

  return (
    <div className="flex flex-col gap-5">
      <p className="m-0 text-[13px] text-muted">
        A pack brings skills, sub-agents and tool servers from a git repo in the plugin catalog layout. Each pack is pinned to one commit and approved per project: nothing reaches an agent until you
        approve its review in the Inbox. Roles that use a pack&apos;s skills also receive its whitelisted sub-agents; hooks, commands and tool servers that run a local command are never installed. A role
        names a pack skill as <span className="font-term">pack@skill</span>.
      </p>

      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <SectionTitle>Packs</SectionTitle>
          {owner && entries.length > 0 && (
            <button className="btn px-2 text-[12px]" onClick={() => officeActions.checkPackUpdates()}>
              Check for updates
            </button>
          )}
        </div>
        {entries.length === 0 ? (
          <p className="text-[13px] text-muted">No packs in this project yet.</p>
        ) : (
          <div className="panel">
            {entries.map(([id, e]) => {
              const [label, color] = status(e);
              const blocked = (path: string) => e.scan.blocked.some((l) => l.startsWith(`${path}/`));
              return (
                <div key={id} className="flex flex-col gap-1.5 border-t-2 border-dashed border-cream-3 px-3 py-2.5 first:border-t-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <b className="font-term text-[13px]">{id}</b>
                    <span className="chip chip-dot text-[12px]" style={{ ["--c" as string]: color }}>
                      {label}
                    </span>
                    <span className="text-[12px] text-muted">
                      {e.version ? `${e.version} · ` : ""}commit <span className="font-term">{short(e.source.commit)}</span>
                      {e.update ? (
                        <>
                          {" "}
                          → <span className="font-term">{short(e.update.source.commit)}</span>
                        </>
                      ) : null}
                    </span>
                    <span className="flex-1" />
                    {owner &&
                      (removing === id ? (
                        <>
                          <span className="text-[12px] text-red">Removes its skills and tool servers from this project.</span>
                          {Object.keys(e.toolServers).length > 0 && (
                            <label className="flex items-center gap-1.5 text-[12px]">
                              <input type="checkbox" checked={deleteKeys} onChange={(ev) => setDeleteKeys(ev.target.checked)} />
                              Also delete its tool servers' saved keys (kept keys come back if you add this pack again)
                            </label>
                          )}
                          <button
                            className="btn px-2 text-[12px]"
                            onClick={() => {
                              officeActions.removePack(id, deleteKeys);
                              setRemoving(null);
                            }}
                          >
                            Remove
                          </button>
                          <button className="text-[12px] underline" onClick={() => setRemoving(null)}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          className="text-[12px] underline"
                          onClick={() => {
                            setRemoving(id);
                            setDeleteKeys(false);
                          }}
                        >
                          Remove…
                        </button>
                      ))}
                  </div>
                  <div className="break-all text-[12px] text-muted">{e.source.repo}</div>
                  {Object.keys(e.skills).length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
                      <span className="text-muted">Skills:</span>
                      {Object.entries(e.skills).map(([name, s]) => (
                        <span key={name} className="chip font-term text-[12px]" style={s && blocked(s.path) ? { ["--c" as string]: "var(--color-red)" } : undefined}>
                          {name}
                          {s && blocked(s.path) ? " (blocked by the scanner)" : ""}
                        </span>
                      ))}
                    </div>
                  )}
                  {Object.keys(e.agents ?? {}).length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
                      <span className="text-muted">Sub-agents:</span>
                      {Object.entries(e.agents ?? {}).map(([name, agent]) => (
                        <span key={name} className="chip font-term text-[12px]" style={agent && blocked(agent.path) ? { ["--c" as string]: "var(--color-red)" } : undefined}>
                          {name}
                          {agent && blocked(agent.path) ? " (blocked by the scanner)" : ""}
                        </span>
                      ))}
                    </div>
                  )}
                  {Object.keys(e.toolServers).map((name) => {
                    const live = servers.find((s) => s.name === name && s.source.kind === "pack" && s.source.packId === id);
                    return (
                      <div key={name} className="flex flex-wrap items-center gap-2 text-[12px]">
                        <span className="text-muted">Tool server:</span>
                        <span className="font-term">{name}</span>
                        {live?.blocked && <span className="text-red">{live.blocked}</span>}
                        {live && owner && (
                          <>
                            <input
                              type="password"
                              autoComplete="off"
                              className="field w-[180px] font-term text-[12px]"
                              aria-label={`Key for ${name}`}
                              placeholder={live.hasKey ? "Key saved" : "Key (optional)"}
                              value={keys[name] ?? ""}
                              onChange={(ev) => setKeys({ ...keys, [name]: ev.target.value })}
                            />
                            <button
                              className="btn px-2 text-[12px]"
                              disabled={!keys[name]?.trim()}
                              onClick={() => {
                                officeActions.setToolServerKey(name, keys[name].trim());
                                setKeys({ ...keys, [name]: "" });
                              }}
                            >
                              Save key
                            </button>
                          </>
                        )}
                      </div>
                    );
                  })}
                  {e.egress.length > 0 && <div className="text-[12px] text-muted">Hosts it says it reaches: {e.egress.join(", ")}</div>}
                  {e.secrets.length > 0 && <div className="text-[12px] text-muted">Secrets it asks for: {e.secrets.join(", ")}</div>}
                  {e.ignored.length > 0 && <div className="text-[12px] text-muted">Not installed: {e.ignored.join(", ")}</div>}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {owner && (
        <section className="panel p-3">
          <SectionTitle>Add a pack</SectionTitle>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Repo URL" hint="An https git URL. HQ reads its newest commit and pins it.">
              <input className="field w-full font-term text-[13px]" value={form.url} placeholder="https://host/owner/repo.git" onChange={(e) => setForm({ ...form, url: e.target.value })} />
            </Field>
            <Field label="Pack name (optional)" hint="Which pack of the repo's catalog. Leave empty when it lists one, or for a repo of skill folders.">
              <input className="field w-full font-term text-[13px]" value={form.plugin} onChange={(e) => setForm({ ...form, plugin: e.target.value })} />
            </Field>
          </div>
          <div className="mt-3">
            <button className="btn" disabled={!form.url.trim().startsWith("https://")} onClick={add}>
              Read pack
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
