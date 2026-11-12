// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { isViewer, officeActions, useOffice } from "../../store/office";
import { Field, SectionTitle } from "../kit";

const STATUS = {
  online: ["Connected", "#00ff66"],
  offline: ["Can't reach Neo4j", "#F59E0B"],
  unconfigured: ["Not set up", "#F59E0B"],
} as const;

/** Where the team's memory (Neo4j) is. You run Neo4j; HQ only connects to it. */
export function MemorySettings() {
  const state = useOffice((s) => s.snap?.memory);
  const [form, setForm] = useState<{ url: string; user: string; password: string } | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  if (!state) return <p className="m-0 text-[14px] text-muted">Memory settings aren't available from this server.</p>;
  const f = form ?? { url: state.url || "bolt://127.0.0.1:7687", user: state.user || "neo4j", password: "" };
  const canSave = /^(bolt|neo4j)(\+s|\+ssc)?:\/\/\S+$/.test(f.url.trim()) && (state.passwordSet || f.password.length >= 8);
  const [label, color] = STATUS[state.status];

  return (
    <div className="flex flex-col gap-5">
      <p className="m-0 text-[14px] text-muted">
        The team's memory lives in Neo4j, which you run yourself (the compose file includes it). HQ connects over Bolt. While Neo4j is down, agents keep
        working: new ledger entries wait here and are sent when it's back.
      </p>

      <section>
        <SectionTitle>Status</SectionTitle>
        <p className="m-0 flex flex-wrap items-center gap-2 text-[13px]">
          <span className="chip chip-dot text-[12px]" style={{ ["--c" as string]: color }}>
            {label}
          </span>
          {state.url && <span className="font-mono text-[12px]">{state.url}</span>}
          {state.queued > 0 && <span className="text-muted">{state.queued} write{state.queued === 1 ? "" : "s"} waiting</span>}
        </p>
        {state.status === "offline" && state.error && <p className="m-0 mt-2 break-words text-[12px] text-muted">{state.error}</p>}
      </section>

      <section>
        <SectionTitle>Backups</SectionTitle>
        <p className="m-0 mb-2 text-[13px] text-muted">
          HQ saves this project's memory every night at 03:00 and keeps the last 7 nights. Restoring puts the project's memory back as it was that
          night; anything written since is lost.
        </p>
        {state.backups.length === 0 ? (
          <p className="m-0 text-[13px] text-muted">No backups yet.</p>
        ) : (
          <div className="border-[3px] border-ink">
            {state.backups.map((d) => (
              <div key={d} className="flex flex-wrap items-center gap-3 border-t-2 border-dashed border-cream-3 px-3 py-2 first:border-t-0">
                <b className="font-mono text-[14px]">{d}</b>
                <span className="flex-1" />
                {!isViewer &&
                  (restoring === d ? (
                    <>
                      <button className="btn border-red px-2 text-[12px] text-red" disabled={state.status !== "online"} onClick={() => (officeActions.restoreMemory(d), setRestoring(null))}>
                        Replace memory with {d}
                      </button>
                      <button className="btn px-2 text-[12px]" onClick={() => setRestoring(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button className="btn px-2 text-[12px]" disabled={state.status !== "online"} onClick={() => setRestoring(d)}>
                      Restore
                    </button>
                  ))}
              </div>
            ))}
          </div>
        )}
      </section>

      {state.source === "env" ? (
        <p className="m-0 text-[13px] text-muted">
          Set by <code>ARIMA_NEO4J_URL</code> and <code>ARIMA_NEO4J_PASSWORD</code> (compose). Change them in <code>.env</code> and restart HQ.
        </p>
      ) : (
        !isViewer && (
          <section className="flex max-w-[560px] flex-col gap-3">
            <SectionTitle>Connection</SectionTitle>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Address" hint="bolt://host:7687">
                <input className="field font-mono" value={f.url} autoComplete="off" onChange={(e) => setForm({ ...f, url: e.target.value })} />
              </Field>
              <Field label="User">
                <input className="field" value={f.user} autoComplete="off" onChange={(e) => setForm({ ...f, user: e.target.value })} />
              </Field>
            </div>
            <Field label="Password" hint={state.passwordSet ? "Leave empty to keep the stored one." : "Stored encrypted in the vault."}>
              <input className="field font-mono" type="password" value={f.password} autoComplete="new-password" onChange={(e) => setForm({ ...f, password: e.target.value })} />
            </Field>
            <div>
              <button
                className="btn border-green text-green"
                disabled={!canSave}
                onClick={() => {
                  officeActions.saveMemory({ url: f.url.trim(), user: f.user.trim(), password: f.password || undefined });
                  setForm(null);
                }}
              >
                Save and connect
              </button>
            </div>
          </section>
        )
      )}
    </div>
  );
}
