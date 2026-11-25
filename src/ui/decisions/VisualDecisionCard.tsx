import { useState } from "react";
import type { VisualDecision } from "../../data/generated";
import { BRAND } from "../../data/brand";
import { isViewer, officeActions, useOffice } from "../../store/office";
import { ui } from "../../store/ui";
import { Icon } from "../deck/Icon";
import { ago, Dot, useNow } from "../kit";
import FormCard from "./FormCard";
import { MeetingRequestCard } from "./MeetingRequestCard";
import { PackReviewBody } from "./PackReviewBody";
import { PermissionCard } from "./PermissionCard";
import { QuestionCard } from "./QuestionCard";
import { SafeMarkdown } from "./SafeMarkdown";
import { SecondOpinionCard } from "./SecondOpinionCard";

export { SafeMarkdown } from "./SafeMarkdown";

const KIND_META: Record<string, { icon: string; badge: string; color: string }> = {
  question: { icon: "help", badge: "Question", color: "var(--accent)" },
  "second-opinion": { icon: "compare_arrows", badge: "Second Opinion", color: "var(--accent)" },
  disagreement: { icon: "warning", badge: "Disagreement", color: "var(--color-amber)" },
  permission: { icon: "terminal", badge: "CLI Permission", color: "var(--color-amber)" },
  "meeting-request": { icon: "groups", badge: "Meeting Request", color: "var(--accent)" },
  "memory-review": { icon: "neurology", badge: "Memory Review", color: "var(--accent)" },
  "skill-scan": { icon: "extension", badge: "Skill Scan", color: "var(--accent)" },
  "pack-review": { icon: "extension", badge: "Pack review", color: "var(--accent)" },
  info: { icon: "info", badge: "Update", color: "var(--color-muted)" },
  form: { icon: "dynamic_form", badge: "Agent form", color: "var(--accent)" },
};

export function VisualDecisionCard({
  decision,
  compact = false,
}: {
  decision: VisualDecision;
  compact?: boolean;
}) {
  const snap = useOffice((s) => s.snap);
  const now = useNow(15_000);
  const [note, setNote] = useState(decision.note ?? "");
  const [packRoles, setPackRoles] = useState(decision.payload.kind === "pack-review" ? decision.payload.roles : []);
  const from = snap?.config.team.find((a) => a.id === decision.fromId);
  const fromName = from?.name ?? (decision.fromId === "hq" ? BRAND.name : decision.fromId);
  const meta = KIND_META[decision.payload.kind] ?? KIND_META.info;
  const resolved = decision.status !== "open";

  const genericResolve = (status: "resolved" | "dismissed") => {
    if (resolved || isViewer) return;
    officeActions.answerDecision(decision.id, {
      status,
      note: note.trim() || null,
      ...(decision.payload.kind === "pack-review" && { answers: [{ questionId: "roles", selectedOptionIds: packRoles, otherText: null }] }),
    });
  };

  return (
    <article
      className={`flex flex-col gap-3 rounded-xl border border-[var(--border-hairline)] bg-[var(--surface-card)] ${
        compact ? "p-3.5" : "p-5"
      } shadow-[var(--card-shadow)]`}
      aria-label={decision.title}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="chip text-[12px]" style={{ ["--c" as string]: meta.color }}>
              <Icon name={meta.icon} size={15} />
              {meta.badge}
            </span>
            {decision.waiting && decision.status === "open" && (
              <span className="chip text-[12px]" style={{ ["--c" as string]: "var(--color-amber)" }}>
                Waiting on you
              </span>
            )}
            {decision.ownerOnly && (
              <span className="chip text-[12px]" style={{ ["--c" as string]: "var(--color-muted)" }}>
                Owner only
              </span>
            )}
          </div>
          <h3 className={`m-0 mt-1.5 font-semibold leading-snug text-ink ${compact ? "text-[15px]" : "text-[20px]"}`}>
            {decision.title}
          </h3>
        </div>

        <div className="flex items-center gap-1.5 text-[12px] text-muted">
          {from && <Dot color={from.color} size={8} />}
          <span>{fromName}</span>
          {decision.taskId && (
            <>
              <span>·</span>
              <button
                type="button"
                onClick={() => ui.openTask(decision.taskId!)}
                className="font-medium text-accent hover:underline"
              >
                {decision.taskId}
              </button>
            </>
          )}
          <span>· {ago(decision.createdAt, now)}</span>
        </div>
      </header>

      {decision.details && (
        <div className="text-[13px] text-muted">
          <SafeMarkdown markdown={decision.details} />
        </div>
      )}

      {decision.payload.kind === "question" ? (
        <QuestionCard decision={decision} payload={decision.payload} compact={compact} />
      ) : decision.payload.kind === "second-opinion" || decision.payload.kind === "disagreement" ? (
        <SecondOpinionCard
          decision={decision}
          payload={decision.payload}
          kind={decision.payload.kind}
          compact={compact}
        />
      ) : decision.payload.kind === "permission" ? (
        <PermissionCard decision={decision} payload={decision.payload} compact={compact} />
      ) : decision.payload.kind === "meeting-request" ? (
        <MeetingRequestCard decision={decision} payload={decision.payload} compact={compact} />
      ) : decision.payload.kind === "form" ? (
        <FormCard key={`${decision.id}:${decision.status}:${decision.closedAt ?? ""}`} decision={decision} payload={decision.payload} />
      ) : (
        <div className="flex flex-col gap-3">
          {"markdown" in decision.payload && decision.payload.markdown && (
            <div className="rounded-lg border border-[var(--border-hairline)] bg-cream-2/50 p-3">
              <SafeMarkdown markdown={decision.payload.markdown} />
            </div>
          )}
          {decision.payload.kind === "pack-review" && (
            <PackReviewBody
              decisionId={decision.id}
              projectId={decision.projectId}
              payload={decision.payload}
              roles={resolved ? decision.payload.roles : packRoles}
              onRoles={resolved || isViewer ? undefined : setPackRoles}
            />
          )}
          {!resolved && !isViewer && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="field min-w-[180px] flex-1 text-[13px]"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Note for the agent (optional)…"
                aria-label={`Note for ${decision.title}`}
              />
              <button
                type="button"
                className="btn btn-primary text-[13px]"
                onClick={() => genericResolve("resolved")}
              >
                Approve
              </button>
              <button
                type="button"
                className="btn text-[13px]"
                onClick={() => genericResolve("dismissed")}
              >
                Send back
              </button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
