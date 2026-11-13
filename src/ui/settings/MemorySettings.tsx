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
  const keys = (useOffice((s) => s.snap?.accounts?.list) ?? []).filter((a) => a.provider === "anthropic");
  const [form, setForm] = useState<{ url: string; user: string; password: string } | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [name, setName] = useState("");
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
        {state.browserUrl && !isViewer && (
          <p className="m-0 mt-2 text-[13px]">
            <a className="btn min-h-[40px] px-3 text-[12px]" href={state.browserUrl} target="_blank" rel="noreferrer">
              Open Neo4j Browser ↗
            </a>{" "}
            <span className="text-muted">On your tailnet only. Sign in as neo4j with the memory password.</span>
          </p>
        )}
      </section>

      <section className="flex max-w-[560px] flex-col gap-2">
        <SectionTitle>Extraction</SectionTitle>
        <p className="m-0 text-[13px] text-muted">
          When a task finishes, Claude Haiku reads its summary and proposes decisions, lessons and dead ends to remember. Each run uses a little of the
          chosen account (shown in usage as a helper run). Off until you turn it on; tasks finished meanwhile are read when you do.
        </p>
        <label className="flex items-center gap-2 text-[14px]">
          <input
            type="checkbox"
            checked={state.extraction.enabled}
            disabled={isViewer}
            onChange={(e) => officeActions.setMemoryExtraction({ ...state.extraction, enabled: e.target.checked })}
          />
          Extract memories from finished tasks
        </label>
        <Field label="Account">
          <select
            className="field"
            value={state.extraction.account}
            disabled={isViewer}
            onChange={(e) => officeActions.setMemoryExtraction({ ...state.extraction, account: e.target.value })}
          >
            <option value="default">Claude Code sign-in (claude -p)</option>
            {keys.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id} (Anthropic API key)
              </option>
            ))}
          </select>
        </Field>
      </section>

      <LessonsSection extractionOn={state.extraction.enabled} />

      <section className="flex max-w-[560px] flex-col gap-2">
        <SectionTitle>Keep out of memory</SectionTitle>
        <p className="m-0 text-[13px] text-muted">
          People's names and handles this project's memory never keeps (OSINT, sales, logs). Adding one also removes it from what memory already
          holds. Emails, phone numbers and secrets are always removed. Findings and reports keep their evidence.
        </p>
        {state.keepOut.length > 0 && (
          <p className="m-0 flex flex-wrap gap-1.5">
            {state.keepOut.map((n) => (
              <span key={n} className="chip text-[12px]">
                {n}
              </span>
            ))}
          </p>
        )}
        {!isViewer && (
          <div className="flex gap-2">
            <input className="field min-w-0 flex-1" value={name} placeholder="A name or handle" autoComplete="off" onChange={(e) => setName(e.target.value)} />
            <button
              className="btn"
              disabled={name.trim().length < 2}
              onClick={() => {
                officeActions.keepOutOfMemory(name.trim());
                setName("");
              }}
            >
              Keep out
            </button>
          </div>
        )}
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

const LESSON_LABEL: Record<string, string> = { Lesson: "Lesson", Decision: "Decision", DeadEnd: "Dead end" };

/** Certified lessons offered to the project's template, and the ones already in it. */
function LessonsSection({ extractionOn }: { extractionOn: boolean }) {
  const lessons = useOffice((s) => s.snap?.lessons);
  const security = useOffice((s) => !!s.snap?.config.rules?.findings);
  if (!lessons?.templateId) return null;
  return (
    <section className="flex max-w-[560px] flex-col gap-2">
      <SectionTitle>Lessons for the template</SectionTitle>
      <p className="m-0 text-[13px] text-muted">
        Certified lessons, decisions and dead ends from this project, offered to its template (<b className="text-ink">{lessons.templateId}</b>) so new
        projects from it start with them in their briefs. Claude Haiku rewrites each without this project's names, hosts or paths; any that still
        mention one are dropped, and you approve each of the rest in Action items.
        {security && " Off by default here: a lesson from one engagement must never reach the next client's brief."}
      </p>
      <label className="flex items-center gap-2 text-[14px]">
        <input type="checkbox" checked={lessons.enabled} disabled={isViewer} onChange={(e) => officeActions.setLessonPromotion(e.target.checked)} />
        Allow this project's lessons into its template
      </label>
      {!isViewer && (
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn px-3 text-[12px]" disabled={!lessons.enabled || !extractionOn || lessons.running} onClick={() => officeActions.promoteLessons()}>
            {lessons.running ? "Rewriting…" : "Offer lessons now"}
          </button>
          {!extractionOn && <span className="text-[12px] text-muted">Needs extraction on (it uses the same Haiku account).</span>}
          {lessons.pending > 0 && <span className="text-[12px] text-muted">{lessons.pending} waiting for you in Action items</span>}
        </div>
      )}
      {lessons.last && <p className="m-0 text-[12px] text-muted" role="status">{lessons.last}</p>}
      {lessons.approved.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {lessons.approved.map((l) => (
            <li key={l.id} className="flex items-start gap-2 border-2 border-ink bg-white px-2 py-1.5 text-[13px]">
              <span className="chip shrink-0 text-[10px]">{LESSON_LABEL[l.type] ?? l.type}</span>
              <span className="min-w-0 flex-1">{l.text}</span>
              {!isViewer && (
                <button className="btn shrink-0 px-2 text-[11px]" onClick={() => officeActions.removeLesson(l.id)} aria-label={`Remove lesson: ${l.text.slice(0, 40)}`}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
