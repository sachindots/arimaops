import { useState } from "react";
import type { PermissionPayload, VisualDecision } from "../../data/generated";
import { isViewer, officeActions } from "../../store/office";
import { Icon } from "../deck/Icon";

export function PermissionCard({
  decision,
  payload,
  compact = false,
}: {
  decision: VisualDecision;
  payload: PermissionPayload;
  compact?: boolean;
}) {
  const resolved = decision.status !== "open";
  const [note, setNote] = useState(decision.note ?? "");

  const resolve = (resolution: "allow-once" | "allow-task" | "deny") => {
    if (resolved || isViewer) return;
    officeActions.answerDecision(decision.id, {
      status: resolution === "deny" ? "dismissed" : "resolved",
      resolution,
      note: note.trim() || null,
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-[var(--border-hairline)] bg-cream-2/50 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[12px] font-semibold text-ink">
            <Icon name="terminal" size={16} className="text-amber" />
            Tool: <code className="rounded bg-[var(--surface-card)] px-1.5 py-0.5 text-[12px]">{payload.toolName}</code>
          </span>
          {payload.scopeHint && (
            <span className="text-[12px] text-muted">{payload.scopeHint}</span>
          )}
        </div>
        <pre className="m-0 mt-2 overflow-x-auto whitespace-pre-wrap rounded-md border border-[var(--border-hairline)] bg-[var(--surface-card)] px-3 py-2 text-[13px] font-medium text-ink">
          {payload.commandOrPath}
        </pre>
        {payload.reason && (
          <p className="m-0 mt-2 text-[13px] text-muted">{payload.reason}</p>
        )}
      </div>

      {!resolved && !isViewer ? (
        <div className="flex flex-wrap items-center gap-2">
          {!compact && (
            <input
              className="field min-w-[160px] flex-1 text-[13px]"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional note…"
              aria-label={`Note for ${decision.title}`}
            />
          )}
          <button
            type="button"
            className="btn btn-primary flex items-center gap-1.5 text-[13px]"
            onClick={() => resolve("allow-once")}
          >
            <Icon name="check" size={16} /> Allow once
          </button>
          <button
            type="button"
            className="btn flex items-center gap-1.5 border-accent/40 text-[13px] text-accent hover:bg-accent/10"
            onClick={() => resolve("allow-task")}
          >
            <Icon name="task_alt" size={16} /> Allow for task
          </button>
          <button
            type="button"
            className="btn flex items-center gap-1.5 border-red/35 text-[13px] text-red hover:bg-red/10"
            onClick={() => resolve("deny")}
          >
            <Icon name="block" size={16} /> Deny
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-[12px] text-muted">
          <Icon
            name={payload.resolution === "deny" ? "cancel" : "check_circle"}
            size={16}
            className={payload.resolution === "deny" ? "text-red" : "text-green"}
          />
          <span>
            {payload.resolution === "allow-task"
              ? "Allowed for task"
              : payload.resolution === "allow-once"
                ? "Allowed once"
                : payload.resolution === "deny"
                  ? "Denied"
                  : decision.status}
            {decision.note ? ` · “${decision.note}”` : ""}
          </span>
        </div>
      )}
    </div>
  );
}
