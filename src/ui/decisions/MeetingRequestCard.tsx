import type { MeetingKind, MeetingUrgency, VisualDecision } from "../../data/generated";
import { isViewer, officeActions, useOffice } from "../../store/office";
import { ui } from "../../store/ui";
import { Icon } from "../deck/Icon";
import { Portrait } from "../kit";

export function MeetingRequestCard({
  decision,
  payload,
  compact = false,
}: {
  decision: VisualDecision;
  payload: {
    meetingId: string;
    meetingKind: MeetingKind;
    urgency: MeetingUrgency;
    participantIds: string[];
    agendaPreview: string[];
  };
  compact?: boolean;
}) {
  const snap = useOffice((s) => s.snap);
  const resolved = decision.status !== "open";
  const team = snap?.config.team ?? [];
  const participants = payload.participantIds
    .map((id) => team.find((a) => a.id === id))
    .filter((a): a is NonNullable<typeof a> => Boolean(a));

  const urgencyColor =
    payload.urgency === "high"
      ? "var(--color-red)"
      : payload.urgency === "normal"
        ? "var(--color-amber)"
        : "var(--color-muted)";

  const act = (action: "join" | "snooze" | "decline") => {
    if (action === "join") {
      if (!resolved && !isViewer) {
        officeActions.answerDecision(decision.id, {
          status: "resolved",
          meetingAction: "join",
        });
      }
      ui.openMeetings(payload.meetingId);
      return;
    }
    if (resolved || isViewer) return;
    officeActions.answerDecision(decision.id, {
      status: action === "decline" ? "dismissed" : "resolved",
      meetingAction: action,
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border-hairline)] bg-cream-2/50 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="chip text-[12px] capitalize" style={{ ["--c" as string]: "var(--accent)" }}>
            <Icon name="groups" size={15} /> {payload.meetingKind}
          </span>
          <span className="chip text-[12px] capitalize" style={{ ["--c" as string]: urgencyColor }}>
            {payload.urgency} urgency
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {participants.map((a) => (
            <span key={a.id} className="flex items-center gap-1 rounded-full bg-[var(--surface-card)] pr-2 text-[12px] text-ink">
              <Portrait name={a.name} color={a.color} lead={a.isLead} size={22} />
              <span>{a.name}</span>
            </span>
          ))}
        </div>
      </div>

      {payload.agendaPreview.length > 0 && !compact && (
        <div className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-muted">Agenda</span>
          <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-[13px] text-ink">
            {payload.agendaPreview.map((item, idx) => (
              <li key={idx}>{item}</li>
            ))}
          </ol>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-primary flex items-center gap-1.5 text-[13px]"
          onClick={() => act("join")}
        >
          <Icon name="forum" size={16} /> Join now
        </button>
        {!resolved && !isViewer && (
          <>
            <button
              type="button"
              className="btn flex items-center gap-1.5 text-[13px]"
              onClick={() => act("snooze")}
            >
              <Icon name="schedule" size={16} /> Snooze
            </button>
            <button
              type="button"
              className="btn flex items-center gap-1.5 text-[13px]"
              onClick={() => act("decline")}
            >
              <Icon name="close" size={16} /> Decline
            </button>
          </>
        )}
      </div>
    </div>
  );
}
