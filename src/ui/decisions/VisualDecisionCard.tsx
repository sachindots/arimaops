import { Fragment, useState } from "react";
import type { VisualDecision } from "../../data/generated";
import { BRAND } from "../../data/brand";
import { isViewer, officeActions, useOffice } from "../../store/office";
import { ui } from "../../store/ui";
import { Icon } from "../deck/Icon";
import { ago, Dot, useNow } from "../kit";
import { MeetingRequestCard } from "./MeetingRequestCard";
import { PackReviewBody } from "./PackReviewBody";
import { PermissionCard } from "./PermissionCard";
import { QuestionCard } from "./QuestionCard";
import { SecondOpinionCard } from "./SecondOpinionCard";

/**
 * Safe React-element Markdown renderer for specs, plans, rationales, and summaries.
 * Supports headings (#, ##, ###), bullet lists (- / *), numbered lists, fenced code blocks (```),
 * inline `code`, and **bold** spans.
 */
export function SafeMarkdown({ markdown }: { markdown: string }) {
  const chunks = markdown.split(/(```[\s\S]*?```)/g);
  return (
    <div className="flex flex-col gap-1.5 text-[13px] leading-6 text-ink">
      {chunks.map((chunk, ci) => {
        if (chunk.startsWith("```") && chunk.endsWith("```")) {
          const inner = chunk.replace(/^```[\w-]*\n?/, "").replace(/\n?```$/, "");
          return (
            <pre
              key={ci}
              className="my-1 overflow-x-auto rounded-lg border border-[var(--border-hairline)] bg-cream-2 px-3 py-2 text-[12px] leading-5 text-ink"
            >
              {inner}
            </pre>
          );
        }
        const lines = chunk.split("\n");
        return (
          <Fragment key={ci}>
            {lines.map((line, li) => {
              const trimmed = line.trim();
              if (!trimmed) return null;
              if (trimmed.startsWith("### ")) {
                return (
                  <h4 key={li} className="m-0 mt-1 text-[13px] font-semibold text-ink">
                    <InlineMarkdown text={trimmed.slice(4)} />
                  </h4>
                );
              }
              if (trimmed.startsWith("## ")) {
                return (
                  <h3 key={li} className="m-0 mt-1.5 text-[15px] font-semibold text-ink">
                    <InlineMarkdown text={trimmed.slice(3)} />
                  </h3>
                );
              }
              if (trimmed.startsWith("# ")) {
                return (
                  <h2 key={li} className="m-0 mt-1.5 text-[15px] font-semibold text-ink">
                    <InlineMarkdown text={trimmed.slice(2)} />
                  </h2>
                );
              }
              if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
                return (
                  <div key={li} className="flex items-baseline gap-2 pl-2">
                    <span className="text-muted">•</span>
                    <span className="min-w-0 flex-1">
                      <InlineMarkdown text={trimmed.slice(2)} />
                    </span>
                  </div>
                );
              }
              return (
                <p key={li} className="m-0">
                  <InlineMarkdown text={line} />
                </p>
              );
            })}
          </Fragment>
        );
      })}
    </div>
  );
}

function InlineMarkdown({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
          return (
            <code
              key={i}
              className="rounded-lg border border-[var(--border-hairline)] bg-cream-2 px-1 py-0.5 text-[12px] text-ink"
            >
              {part.slice(1, -1)}
            </code>
          );
        }
        if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
          return (
            <strong key={i} className="font-semibold text-ink">
              {part.slice(2, -2)}
            </strong>
          );
        }
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}

const KIND_META: Record<string, { icon: string; badge: string; color: string }> = {
  question: { icon: "help", badge: "Question", color: "var(--accent)" },
  "second-opinion": { icon: "compare_arrows", badge: "Second Opinion", color: "var(--accent)" },
  disagreement: { icon: "warning", badge: "Disagreement", color: "var(--color-amber)" },
  permission: { icon: "terminal", badge: "CLI Permission", color: "var(--color-amber)" },
  "meeting-request": { icon: "groups", badge: "Meeting Request", color: "var(--accent)" },
  "spec-approval": { icon: "description", badge: "Spec Approval", color: "var(--accent)" },
  "plan-approval": { icon: "account_tree", badge: "Plan Approval", color: "var(--accent)" },
  "gate-approval": { icon: "verified", badge: "Gate Approval", color: "var(--color-amber)" },
  "send-proposal": { icon: "send", badge: "Outbound Send", color: "var(--color-amber)" },
  "memory-review": { icon: "neurology", badge: "Memory Review", color: "var(--accent)" },
  "spend-alert": { icon: "payments", badge: "Spend Alert", color: "var(--color-red)" },
  "skill-scan": { icon: "extension", badge: "Skill Scan", color: "var(--accent)" },
  "pack-review": { icon: "extension", badge: "Pack review", color: "var(--accent)" },
  "overflow-fallback": { icon: "swap_horiz", badge: "Model Fallback", color: "var(--color-amber)" },
  info: { icon: "info", badge: "Update", color: "var(--color-muted)" },
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
  const from = snap?.config.team.find((a) => a.id === decision.fromId);
  const fromName = from?.name ?? (decision.fromId === "hq" ? BRAND.name : decision.fromId);
  const meta = KIND_META[decision.payload.kind] ?? KIND_META.info;
  const resolved = decision.status !== "open";

  const genericResolve = (status: "resolved" | "dismissed") => {
    if (resolved || isViewer) return;
    officeActions.answerDecision(decision.id, {
      status,
      note: note.trim() || null,
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
      ) : (
        <div className="flex flex-col gap-3">
          {"markdown" in decision.payload && decision.payload.markdown && (
            <div className="rounded-lg border border-[var(--border-hairline)] bg-cream-2/50 p-3">
              <SafeMarkdown markdown={decision.payload.markdown} />
            </div>
          )}
          {decision.payload.kind === "pack-review" && <PackReviewBody payload={decision.payload} />}
          {decision.payload.kind === "gate-approval" && (
            <div className="rounded-lg border border-[var(--border-hairline)] bg-cream-2/50 p-3 text-[13px]">
              <div>
                <span className="font-semibold text-ink">Gate: </span>
                <span>{decision.payload.gateId}</span> ({decision.payload.reason})
              </div>
              {decision.payload.deliverablePreview && (
                <div className="mt-2">
                  <SafeMarkdown markdown={decision.payload.deliverablePreview} />
                </div>
              )}
            </div>
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
