import { useState } from "react";
import type { QuestionAnswer, QuestionPayload, VisualDecision } from "../../data/generated";
import { isViewer, officeActions } from "../../store/office";
import { Icon } from "../deck/Icon";
import { OptionRow } from "./OptionRow";

export function QuestionCard({
  decision,
  payload,
  compact = false,
}: {
  decision: VisualDecision;
  payload: QuestionPayload;
  compact?: boolean;
}) {
  const resolved = decision.status !== "open";
  const [selected, setSelected] = useState<Record<string, string[]>>(() => {
    const init: Record<string, string[]> = {};
    if (payload.answers.length > 0) {
      for (const a of payload.answers) init[a.questionId] = a.selectedOptionIds;
    } else {
      for (const q of payload.questions) {
        const recs = q.options.filter((o) => o.recommended).map((o) => o.id);
        init[q.id] = recs.length ? (q.multiSelect ? recs : [recs[0]]) : q.options[0] ? [q.options[0].id] : [];
      }
    }
    return init;
  });
  const [otherText, setOtherText] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const a of payload.answers) {
      if (a.otherText) init[a.questionId] = a.otherText;
    }
    return init;
  });
  const [note, setNote] = useState(decision.note ?? "");

  const toggleOption = (qId: string, optId: string, multi: boolean) => {
    if (resolved || isViewer) return;
    setSelected((prev) => {
      const cur = prev[qId] ?? [];
      if (multi) {
        return {
          ...prev,
          [qId]: cur.includes(optId) ? cur.filter((x) => x !== optId) : [...cur, optId],
        };
      }
      return { ...prev, [qId]: [optId] };
    });
  };

  const submit = () => {
    if (resolved || isViewer) return;
    const answers: QuestionAnswer[] = payload.questions.map((q) => ({
      questionId: q.id,
      selectedOptionIds: selected[q.id] ?? [],
      otherText: otherText[q.id]?.trim() || null,
    }));
    officeActions.answerDecision(decision.id, {
      status: "resolved",
      answers,
      note: note.trim() || null,
    });
  };

  const dismiss = () => {
    if (resolved || isViewer) return;
    officeActions.answerDecision(decision.id, {
      status: "dismissed",
      note: note.trim() || null,
    });
  };

  return (
    <div className="flex flex-col gap-3">
      {payload.questions.map((q, qi) => {
        const picked = selected[q.id] ?? [];
        return (
          <div
            key={q.id}
            className="flex flex-col gap-2 rounded-lg border border-[var(--border-hairline)] bg-cream-2/40 p-3"
          >
            <div className="flex items-start justify-between gap-2">
              <span className="text-[13px] font-semibold text-ink">
                {payload.questions.length > 1 ? `${qi + 1}. ` : ""}
                {q.prompt}
              </span>
              <span className="shrink-0 rounded-full border border-[var(--border-hairline)] bg-[var(--surface-card)] px-2 py-0.5 text-[12px] text-muted">
                {q.multiSelect ? "Select any" : "Pick one"}
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              {q.options.map((opt) => (
                <OptionRow
                  key={opt.id}
                  label={opt.label}
                  description={compact ? null : opt.description}
                  badge={
                    opt.recommended && (
                      <span className="chip text-[12px]" style={{ ["--c" as string]: "var(--accent)" }}>
                        (Recommended)
                      </span>
                    )
                  }
                  picked={picked.includes(opt.id)}
                  multi={q.multiSelect}
                  disabled={resolved || isViewer}
                  onClick={() => toggleOption(q.id, opt.id, q.multiSelect)}
                />
              ))}
            </div>

            {q.allowOther && !resolved && !isViewer && (
              <input
                className="field mt-1 text-[13px]"
                value={otherText[q.id] ?? ""}
                onChange={(e) => setOtherText((prev) => ({ ...prev, [q.id]: e.target.value }))}
                placeholder="Other preference or constraint (optional)…"
                aria-label={`Other answer for ${q.prompt}`}
              />
            )}
          </div>
        );
      })}

      {!resolved && !isViewer ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {!compact && (
            <input
              className="field min-w-[180px] flex-1 text-[13px]"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional note for the agent…"
              aria-label={`Note for ${decision.title}`}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          )}
          <button type="button" className="btn btn-primary text-[13px]" onClick={submit}>
            <Icon name="check" size={16} /> Submit answer
          </button>
          <button type="button" className="btn text-[13px]" onClick={dismiss}>
            Dismiss
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-[12px] text-muted">
          <Icon name="check_circle" size={16} className="text-green" />
          <span>
            {decision.status === "resolved" ? "Answered" : "Dismissed"}
            {decision.note ? ` · “${decision.note}”` : ""}
          </span>
        </div>
      )}
    </div>
  );
}
