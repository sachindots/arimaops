import { BRAND } from "../../data/brand";
import { useState } from "react";
import { EMPTY_STACK, frameworks, STACK_CATEGORIES, toolsIn, type StackConfig } from "../../data/stack";
import { BUILTIN_TEMPLATES } from "../../data/templates";
import type { ReviewTool } from "../../data/types";
import { officeActions, reviewToolLabel, useOffice } from "../../store/office";
import { Field, RoleBadge } from "../kit";
import { TemplateImport } from "./TemplateImport";

/** First run on a repo or folder: name the project and pick the team template it runs. */
export function WelcomeModal() {
  const snap = useOffice((s) => s.snap);
  const [projectName, setProjectName] = useState(snap?.config.project.name ?? "");
  const [templateId, setTemplateId] = useState(BUILTIN_TEMPLATES[0].id);
  const [reviewEnabled, setReviewEnabled] = useState(snap?.config.workflow.review.enabled ?? true);
  const [reviewTool, setReviewTool] = useState<ReviewTool>(snap?.config.workflow.review.tool ?? "human");
  const [sending, setSending] = useState(false);
  const [stack, setStack] = useState<StackConfig>(EMPTY_STACK);
  if (!snap) return null;
  const library = snap.templateLibrary ?? BUILTIN_TEMPLATES.map((t) => ({ template: t, builtin: true, problems: [] as string[] }));
  const entry = library.find((e) => e.template.id === templateId) ?? library[0];
  const template = entry.template;
  const usesPrs = template.flow.stages.some((st) => st.gates.some((g) => g.kind === "pr-merged"));

  const submit = () => {
    setSending(true);
    const hasStack = stack.frameworks.length > 0 || Object.values(stack.tools).some(Boolean);
    officeActions.completeWelcome({
      projectName: projectName.trim(),
      officeName: snap.config.project.officeName || BRAND.officeSign, // the office scene is gone; kept for old configs
      templateId: template.id,
      reviewTool,
      reviewEnabled,
      ...(hasStack ? { stack } : {}),
    });
  };

  return (
    <div className="fixed inset-0 z-50 grid grid-cols-[minmax(0,1fr)] place-items-center bg-navy-2/75 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={`Welcome to ${BRAND.name}`}>
      <div className="hud-drawer hud-corners flex max-h-[calc(100dvh-2rem)] w-[min(860px,100%)] flex-col rounded-2xl">
        <div className="border-b border-white/[0.08] px-4 py-3">
          <h2 className="m-0 font-display text-[24px] font-semibold">
            Welcome to <span className="text-accent">{BRAND.name}</span>
          </h2>
          <p className="m-0 text-[14px] text-muted">
            Pick a team for <b className="text-ink">{snap.config.project.repo || snap.config.project.name}</b>. You can change its roles, models and agents later in Settings → Team.
          </p>
        </div>

        <div className="scroll-thin flex min-h-0 flex-col gap-4 overflow-y-auto px-4 py-3">
          <Field label="Project name">
            <input className="field w-full" value={projectName} maxLength={80} onChange={(e) => setProjectName(e.target.value)} />
          </Field>

          <section>
            <h3 className="mb-1.5 font-display text-[16px] font-semibold">Team template</h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Team template">
              {library.map(({ template: t, builtin, problems }) => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={t.id === template.id}
                  className={`flex flex-col items-start gap-1.5 rounded-xl border p-2.5 text-left transition-colors ${t.id === template.id ? "border-accent bg-accent/10" : "border-white/10 bg-navy/60 hover:border-white/25"}`}
                  onClick={() => setTemplateId(t.id)}
                >
                  <span className="flex flex-wrap items-center gap-1.5">
                    <b className="text-[14px]">{t.name}</b>
                    {!builtin && <span className="chip text-[11px]" style={{ ["--c" as string]: "#a371f7" }}>yours · v{t.version}</span>}
                    {problems.length > 0 && <span className="chip text-[11px]" style={{ ["--c" as string]: "#ffb020" }}>waits for you</span>}
                  </span>
                  <span className="text-[12px] leading-snug text-muted">{t.description}</span>
                  <span className="flex flex-wrap gap-1">
                    {t.roles.map((r) => (
                      <RoleBadge key={r.id} role={`${r.seats > 1 ? `${r.seats}× ` : ""}${r.title}`} color={r.color} compact />
                    ))}
                  </span>
                </button>
              ))}
            </div>
            {entry.problems.length > 0 && (
              <p className="mt-2 border-l border-[#ffb020] pl-2 text-[13px]">
                {template.name} can't be used yet: {entry.problems.join("; ")}.
              </p>
            )}
            <ul className="mt-2 flex flex-col gap-0.5 text-[13px] text-muted">
              {template.roles.map((r) => (
                <li key={r.id}>
                  <b className="text-ink">{r.title}</b> × {r.seats}: {r.cli}
                  {r.model ? ` · ${r.model}` : ""}
                  {r.fallback ? ` (falls back to ${r.fallback.cli}, asking you first)` : ""}
                </li>
              ))}
            </ul>
            <div className="mt-2">
              <TemplateImport onImported={(id) => id !== templateId && setTemplateId(id)} />
            </div>
          </section>

          <WelcomeStack stack={stack} setStack={setStack} />

          {usesPrs && (
            <section>
              <h3 className="mb-1 font-display text-[16px] font-semibold">Code review</h3>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-[14px]">
                  <input type="checkbox" checked={reviewEnabled} onChange={(e) => setReviewEnabled(e.target.checked)} />
                  Review PRs before merge
                </label>
                <select className="field w-[220px]" value={reviewTool} disabled={!reviewEnabled} onChange={(e) => setReviewTool(e.target.value as ReviewTool)} aria-label="Review tool">
                  {(Object.keys(reviewToolLabel) as ReviewTool[]).map((t) => (
                    <option key={t} value={t}>
                      {reviewToolLabel[t]}
                    </option>
                  ))}
                </select>
              </div>
            </section>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-white/[0.08] px-4 py-2.5">
          <span className="text-[12px] text-muted">Agents don't start until you press Start.</span>
          <button className="btn" disabled={sending || entry.problems.length > 0} onClick={submit}>
            {sending ? "Creating…" : "Create team"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Optional, collapsed by default: frameworks and tools. Everything else is in Settings → Stack. */
function WelcomeStack({ stack, setStack }: { stack: StackConfig; setStack: (s: StackConfig) => void }) {
  const [open, setOpen] = useState(false);
  const chosen = (id: string) => stack.frameworks.some((f) => f.id === id);
  return (
    <section>
      <div className="flex items-center gap-3">
        <h3 className="m-0 font-display text-[16px] font-semibold">Stack</h3>
        <span className="text-[13px] text-muted">Optional. Agents get the tools' skills and docs access.</span>
        <button className="btn ml-auto px-2 text-[12px]" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Choose"}
        </button>
      </div>
      {open && (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            {frameworks().map((f) => (
              <button
                key={f.id}
                className="btn px-2 py-0.5 text-[12px]"
                aria-pressed={chosen(f.id)}
                onClick={() => setStack({ ...stack, frameworks: chosen(f.id) ? stack.frameworks.filter((x) => x.id !== f.id) : [...stack.frameworks, { id: f.id }] })}
              >
                {f.name}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {STACK_CATEGORIES.map((c) => (
              <label key={c.id} className="flex flex-col gap-0.5 text-[12px] font-semibold">
                {c.label}
                <select
                  className="field"
                  value={stack.tools[c.id]?.id ?? ""}
                  onChange={(e) => {
                    const tools = { ...stack.tools };
                    if (e.target.value) tools[c.id] = { id: e.target.value };
                    else delete tools[c.id];
                    setStack({ ...stack, tools });
                  }}
                >
                  <option value="">None</option>
                  {toolsIn(c.id).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <span className="text-[12px] text-muted">"Other" tools, where each framework lives, and network access are in Settings → Stack.</span>
        </div>
      )}
    </section>
  );
}
