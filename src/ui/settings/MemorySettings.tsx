// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { isViewer, officeActions, useOffice } from "../../store/office";
import { Field, SectionTitle } from "../kit";

/** The team's memory: extraction, what it keeps out, and HQ's backups. It lives in HQ's own database. */
export function MemorySettings() {
  const state = useOffice((s) => s.snap?.memory);
  const keys = (useOffice((s) => s.snap?.accounts?.list) ?? []).filter((a) => a.provider === "anthropic");
  const [name, setName] = useState("");
  if (!state) return <p className="m-0 text-[14px] text-muted">Memory settings aren't available from this server.</p>;

  return (
    <div className="flex flex-col gap-5">
      <p className="m-0 text-[14px] text-muted">
        The team's memory (decisions, lessons, dead ends and the lead's ledgers) lives in HQ's own database, next to the plan. Nothing to set up.
      </p>

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
          Every night at 03:00, HQ saves a copy of its whole database (plans, memory, people, usage) and keeps the last 7. To go back to one: stop HQ,
          copy <code>~/.arima/backups/arima-DATE.db</code> over <code>~/.arima/arima.db</code>, and start it again. Deleting a project removes it from
          these copies too.
        </p>
        {state.backups.length === 0 ? (
          <p className="m-0 text-[13px] text-muted">No backups yet.</p>
        ) : (
          <p className="m-0 flex flex-wrap gap-1.5">
            {state.backups.map((d) => (
              <span key={d} className="chip font-mono text-[12px]">
                {d}
              </span>
            ))}
          </p>
        )}
      </section>
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
        mention one are dropped, and you approve each of the rest in the Inbox.
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
          {lessons.pending > 0 && <span className="text-[12px] text-muted">{lessons.pending} waiting for you in the Inbox</span>}
        </div>
      )}
      {lessons.last && <p className="m-0 text-[12px] text-muted" role="status">{lessons.last}</p>}
      {lessons.approved.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {lessons.approved.map((l) => (
            <li key={l.id} className="flex items-start gap-2 rounded-lg border border-white/10 bg-white px-2 py-1.5 text-[13px]">
              <span className="chip shrink-0 text-[11px]">{LESSON_LABEL[l.type] ?? l.type}</span>
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
      <div className="mt-2" />
      <SectionTitle>Template improvements</SectionTitle>
      <p className="m-0 text-[13px] text-muted">
        When a check or gate fails on 3 different tasks within 30 days, Claude Haiku drafts one change to the template (a role's model, a skill, a
        gate or a line of instructions). Nightly at 04:00, or now. You approve each in the Inbox; a built-in template is saved as your own copy.
        Same switch and masking as lessons.
      </p>
      {!isViewer && (
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn px-3 text-[12px]" disabled={!lessons.enabled || !extractionOn || lessons.improvements.running} onClick={() => officeActions.proposeImprovements()}>
            {lessons.improvements.running ? "Drafting…" : "Look for repeated failures now"}
          </button>
          {lessons.improvements.pending > 0 && <span className="text-[12px] text-muted">{lessons.improvements.pending} waiting for you in the Inbox</span>}
        </div>
      )}
      {lessons.improvements.last && <p className="m-0 text-[12px] text-muted" role="status">{lessons.improvements.last}</p>}
    </section>
  );
}
