import { useState } from "react";
import type { MeetingKind } from "../../data/generated";
import { isViewer, officeActions, useOffice } from "../../store/office";
import { ui, useUi } from "../../store/ui";
import { Icon } from "../deck/Icon";
import { ago, useNow } from "../kit";
import { MeetingRoom } from "./MeetingRoom";

export function MeetingsPanel() {
  const snap = useOffice((s) => s.snap);
  const now = useNow(15_000);
  const activeId = useUi((s) => s.activeMeetingId);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<MeetingKind>("standup");
  const [agendaText, setAgendaText] = useState("");

  if (!snap) return null;
  const meetings = snap.meetings ?? [];
  const selected = meetings.find((m) => m.id === activeId) ?? meetings[0] ?? null;
  const turns = selected ? snap.meetingTurns?.[selected.id] ?? [] : [];

  const createMeeting = () => {
    const clean = title.trim() || (kind === "standup" ? "Team Standup" : "Architecture Discussion");
    const agenda = agendaText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    officeActions.startMeeting({
      kind,
      title: clean,
      urgency: "normal",
      participantIds: snap.config.team.map((a) => a.id),
      agenda: agenda.length ? agenda : undefined,
    });
    setCreating(false);
    setTitle("");
    setAgendaText("");
  };

  return (
    <div className="flex min-h-0 flex-1">
      {/* Left list of live/requested/past meetings */}
      <aside
        className={`flex w-full shrink-0 flex-col border-r border-[var(--border-hairline)] bg-cream-2/30 md:w-[300px] ${
          selected && activeId ? "hidden md:flex" : "flex"
        }`}
        aria-label="Meetings list"
      >
        <div className="flex items-center justify-between border-b border-[var(--border-hairline)] px-4 py-3">
          <div>
            <h2 className="m-0 text-[15px] font-semibold text-ink">Meetings & Standups</h2>
            <p className="m-0 text-[12px] text-muted">Lead-moderated rooms & voice calls</p>
          </div>
          {!isViewer && (
            <button
              type="button"
              className="btn btn-primary flex items-center gap-1 px-2.5 py-1.5 text-[12px]"
              onClick={() => setCreating(!creating)}
            >
              <Icon name="add" size={16} /> New
            </button>
          )}
        </div>

        {creating && !isViewer && (
          <form
            className="flex flex-col gap-2 border-b border-[var(--border-hairline)] bg-[var(--surface-card)] p-3"
            onSubmit={(e) => {
              e.preventDefault();
              createMeeting();
            }}
          >
            <div className="flex gap-1.5">
              {(["standup", "discussion", "review", "kickoff"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={kind === k}
                  onClick={() => setKind(k)}
                  className="btn flex-1 px-2 py-1 text-[12px] capitalize"
                >
                  {k}
                </button>
              ))}
            </div>
            <input
              className="field text-[13px]"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={kind === "standup" ? "Morning Standup" : "Discussion topic…"}
              aria-label="Meeting title"
            />
            <textarea
              className="field min-h-[60px] py-1.5 text-[12px]"
              value={agendaText}
              onChange={(e) => setAgendaText(e.target.value)}
              placeholder="Agenda items (one per line, optional)…"
              aria-label="Meeting agenda"
            />
            <div className="flex justify-end gap-1.5">
              <button type="button" className="btn px-2.5 py-1 text-[12px]" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary px-3 py-1 text-[12px]">
                Start Room
              </button>
            </div>
          </form>
        )}

        <ul className="scroll-thin m-0 flex min-h-0 flex-1 list-none flex-col gap-1.5 overflow-y-auto p-2">
          {meetings.length === 0 && (
            <li className="p-4 text-[13px] text-muted">
              No meetings yet. Start a Standup or Discussion above, or wait for an agent to request one.
            </li>
          )}
          {meetings.map((m) => {
            const on = selected?.id === m.id;
            const turnCount = snap.meetingTurns?.[m.id]?.length ?? 0;
            return (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => ui.setActiveMeeting(m.id)}
                  className={`flex w-full cursor-pointer flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    on
                      ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]"
                      : "border-[var(--border-hairline)] bg-[var(--surface-card)] hover:bg-cream-2"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className="chip text-[12px] capitalize"
                      style={{
                        ["--c" as string]:
                          m.status === "live"
                            ? "var(--color-green)"
                            : m.status === "closed"
                              ? "var(--color-muted)"
                              : "var(--color-amber)",
                      }}
                    >
                      {m.status}
                    </span>
                    <span className="text-[12px] text-muted">{ago(m.createdAt, now)}</span>
                  </div>
                  <span className="truncate text-[13px] font-semibold text-ink">{m.title}</span>
                  <span className="text-[12px] text-muted">
                    {m.participantIds.length} participants · {turnCount} turns
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      {/* Active Meeting Room */}
      <section className={`min-h-0 min-w-0 flex-1 flex-col ${selected ? "flex" : "hidden md:flex"}`}>
        {selected ? (
          <MeetingRoom meeting={selected} turns={turns} onBack={() => ui.setActiveMeeting(null)} />
        ) : (
          <div className="flex flex-1 items-center justify-center p-6 text-[13px] text-muted">
            Select or start a meeting to open the room.
          </div>
        )}
      </section>
    </div>
  );
}
