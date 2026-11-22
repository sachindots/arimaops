import { useState } from "react";
import type { OpinionSide, SecondOpinionPayload, VisualDecision } from "../../data/generated";
import { useAuth } from "../../store/auth";
import { isViewer, officeActions, useOffice } from "../../store/office";
import { ui } from "../../store/ui";
import { Icon } from "../deck/Icon";
import { SafeMarkdown } from "./VisualDecisionCard";

export function SecondOpinionCard({
  decision,
  payload,
  kind,
  compact = false,
}: {
  decision: VisualDecision;
  payload: SecondOpinionPayload;
  kind: "second-opinion" | "disagreement";
  compact?: boolean;
}) {
  const snap = useOffice((s) => s.snap);
  const isOwner = useAuth((s) => s.role === "owner" || s.status === "none");
  const resolved = decision.status !== "open";
  const [note, setNote] = useState(decision.note ?? "");
  const who = (id: string) => snap?.config.team.find((a) => a.id === id)?.name ?? id;

  const choose = (side: "optionA" | "optionB" | "revise" | "waive") => {
    if (resolved || isViewer) return;
    officeActions.answerDecision(decision.id, {
      status: side === "revise" ? "dismissed" : "resolved",
      chosenSide: side,
      note: note.trim() || null,
    });
  };

  const renderSide = (sideKey: "optionA" | "optionB", side: OpinionSide) => {
    const active = payload.chosenSide === sideKey;
    return (
      <div
        key={sideKey}
        className={`flex flex-1 flex-col justify-between gap-2.5 rounded-lg border p-3.5 transition-colors ${
          active
            ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]"
            : "border-[var(--border-hairline)] bg-[var(--surface-card)]"
        }`}
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-start justify-between gap-2">
            <span className="text-[13px] font-semibold text-ink">{side.label}</span>
            <span className="shrink-0 rounded-md bg-cream-2 px-2 py-0.5 text-[12px] text-muted">
              {who(side.authorId)}
            </span>
          </div>
          <p className="m-0 text-[13px] font-medium text-ink">{side.summary}</p>
          {!compact && side.rationaleMarkdown && (
            <div className="rounded-md bg-cream-2/50 p-2.5 text-[12px] text-ink">
              <SafeMarkdown markdown={side.rationaleMarkdown} />
            </div>
          )}
          {side.risks.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-amber">Risks to watch:</span>
              <ul className="m-0 list-disc pl-4 text-[12px] text-muted">
                {side.risks.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {!resolved && !isViewer && (
          <button
            type="button"
            onClick={() => choose(sideKey)}
            className="btn btn-primary mt-2 flex w-full items-center justify-center gap-1.5 text-[13px]"
          >
            <Icon name="check_circle" size={16} />
            Pick {sideKey === "optionA" ? "Option A" : "Option B"}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="chip text-[12px]"
          style={{ ["--c" as string]: kind === "disagreement" ? "var(--color-amber)" : "var(--accent)" }}
        >
          {kind === "disagreement" ? "Agent Disagreement" : "Second Opinion"}
        </span>
        {payload.confidence && (
          <span className="chip text-[12px]" style={{ ["--c" as string]: "var(--color-green)" }}>
            Confidence: {payload.confidence}
          </span>
        )}
        {payload.taskId && (
          <button
            type="button"
            onClick={() => ui.openTask(payload.taskId!)}
            className="rounded bg-cream-2 px-2 py-0.5 text-[12px] font-medium text-accent hover:underline"
          >
            {payload.taskId}
          </button>
        )}
        {payload.gateId && (
          <span className="text-[12px] text-muted">Gate: {payload.gateId}</span>
        )}
      </div>

      {payload.recommendation && (
        <div className="flex items-start gap-2 rounded-lg border border-[var(--border-hairline)] bg-cream-2/50 px-3 py-2 text-[13px] text-ink">
          <Icon name="lightbulb" size={18} className="mt-0.5 shrink-0 text-accent" />
          <div>
            <span className="font-semibold">Recommendation: </span>
            {payload.recommendation}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {renderSide("optionA", payload.optionA)}
        {renderSide("optionB", payload.optionB)}
      </div>

      {!resolved && !isViewer ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <input
            className="field min-w-[180px] flex-1 text-[13px]"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Rationale or instructions for the team (optional)…"
            aria-label={`Note for ${decision.title}`}
          />
          <button type="button" className="btn text-[13px]" onClick={() => choose("revise")}>
            <Icon name="edit_note" size={16} /> Ask to Revise
          </button>
          {payload.canWaiveGate && (
            <button
              type="button"
              disabled={!isOwner}
              title={isOwner ? "Waive this gate and unblock the task" : "Only the project owner can waive high-stakes gates"}
              className="btn border-amber/50 text-[13px] text-amber hover:bg-amber/10"
              onClick={() => choose("waive")}
            >
              <Icon name="verified_user" size={16} /> Waive Gate
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2 text-[12px] text-muted">
          <Icon name="check_circle" size={16} className="text-green" />
          <span>
            {payload.chosenSide === "optionA"
              ? "Picked Option A"
              : payload.chosenSide === "optionB"
                ? "Picked Option B"
                : payload.chosenSide === "waive"
                  ? "Gate Waived"
                  : "Sent back for revision"}
            {decision.note ? ` · “${decision.note}”` : ""}
          </span>
        </div>
      )}
    </div>
  );
}
