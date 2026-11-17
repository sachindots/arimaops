// The team's morning and evening note to the owner: what got done, what's moving, what's stuck, and what waits for
// you. Built from HQ's own records (no model call, so it costs nothing), sent as a message from HQ (so it's in
// chat and on your phone), and skipped when nothing happened.

import type { DatabaseSync } from "node:sqlite";
import type { OfficeSnapshot } from "../src/data/types";

export const STANDUP_HOURS = { morning: 9, evening: 18 } as const;
export type StandupKind = keyof typeof STANDUP_HOURS;

/** The note, or null when there is nothing to say (no movement since `since`, nothing open). */
export function standupNote(db: DatabaseSync, snap: OfficeSnapshot, kind: StandupKind, since: number): string | null {
  const projectId = snap.config.project.id;
  const name = (id: string | null) => snap.config.team.find((a) => a.id === id)?.name ?? "someone";
  const title = (id: string) => snap.tasks.find((t) => t.id === id)?.title ?? id;
  const done = [
    ...new Set(
      (db.prepare("SELECT task_id AS id FROM task_events WHERE project_id = ? AND status = 'done' AND at >= ? ORDER BY at").all(projectId, since) as { id: string }[]).map(
        (r) => r.id,
      ),
    ),
  ];
  const moving = snap.tasks.filter((t) => t.status === "in-progress" || t.status === "in-review");
  const blocked = snap.tasks.filter((t) => t.status === "blocked");
  const waiting = (snap.actionItems ?? []).filter((i) => i.status === "open").length + snap.agents.filter((a) => a.state === "needs-input").length;
  if (!done.length && !blocked.length && !waiting && (kind === "evening" || !moving.length)) return null;

  const list = (ids: string[], max = 6) => ids.slice(0, max).map((id) => `${id} ${title(id)}`).join("; ") + (ids.length > max ? `; and ${ids.length - max} more` : "");
  const lines = [
    kind === "morning" ? "Good morning. Since yesterday evening:" : "End of day:",
    done.length ? `Done (${done.length}): ${list(done)}.` : "Nothing finished.",
    ...(moving.length ? [`In progress (${moving.length}): ${moving.slice(0, 6).map((t) => `${t.id} ${t.title} (${name(t.ownerId)}${t.status === "in-review" ? ", in review" : ""})`).join("; ")}.`] : []),
    ...(blocked.length ? [`Blocked (${blocked.length}): ${blocked.slice(0, 6).map((t) => `${t.id} ${t.title}${t.note ? `: ${t.note.split("\n")[0].slice(0, 120)}` : ""}`).join("; ")}.`] : []),
    waiting ? `${waiting} thing${waiting === 1 ? " waits" : "s wait"} for you in the Inbox.` : "Nothing waits for you.",
  ];
  return lines.join("\n");
}
