// SPDX-License-Identifier: AGPL-3.0-or-later
// Scheduled rituals (a template's `rituals`): a Monday plan, a Friday retro, a metrics review. At its hour HQ sends
// the ritual's prompt to the lead, who runs it like any other piece of work and reports to the owner. A ritual
// whose project had no activity since its last run is skipped (no spend on an idle team). Each runs once per day
// it is due, within RUN_WINDOW_H hours of its hour, so a restart neither repeats it nor runs it hours late.

import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { Ritual } from "../src/data/model";
import { readDoc, writeDoc } from "./lib/docs";
import { homeRoot } from "./paths";

export const RUN_WINDOW_H = 2;
export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** "Mondays at 09:00" / "Every day at 18:00". */
export const ritualWhen = (r: Pick<Ritual, "day" | "hour" | "monthly">) =>
  `${r.day === undefined ? "Every day" : r.monthly ? `The first ${DAY_NAMES[r.day]} of the month` : `${DAY_NAMES[r.day]}s`} at ${pad(r.hour)}:00`;

/** The rituals due now: right day, inside the window after their hour, and not run yet today. */
export function dueRituals(rituals: readonly Ritual[], now: Date, last: Record<string, string>): Ritual[] {
  const h = now.getHours();
  return rituals.filter((r) => (r.day === undefined || r.day === now.getDay()) && (!r.monthly || now.getDate() <= 7) && h >= r.hour && h < r.hour + RUN_WINDOW_H && last[r.id] !== dayKey(now));
}

/** Anything moved since `since` (ms): a task changed status, or someone wrote a message. */
export function activeSince(db: DatabaseSync, projectId: string, since: number, messages: { at: string }[]): boolean {
  if (db.prepare("SELECT 1 FROM task_events WHERE project_id = ? AND at >= ? LIMIT 1").get(projectId, since)) return true;
  return messages.some((m) => Date.parse(m.at) >= since);
}

interface RitualLog {
  /** Ritual id → the day it last ran (or was skipped). */
  day: Record<string, string>;
  /** Ritual id → when it last ran (ms). */
  at: Record<string, number>;
}

const file = (projectId: string) => join(homeRoot(), `rituals-${projectId}.json`);

export interface RitualHost {
  projectId: string;
  rituals(): readonly Ritual[];
  /** False while the project is paused or rituals are turned off. */
  enabled(): boolean;
  messages(): { at: string }[];
  /** Hands the prompt to the lead. */
  run(r: Ritual, prompt: string): void;
  skipped(r: Ritual): void;
}

/** Called every usage poll (30 s): runs what is due, at most once a day per ritual. */
export function tickRituals(db: DatabaseSync, host: RitualHost, now = new Date()) {
  if (!host.enabled()) return;
  const log = readDoc<RitualLog>(file(host.projectId)) ?? { day: {}, at: {} };
  const due = dueRituals(host.rituals(), now, log.day);
  if (!due.length) return;
  for (const r of due) {
    log.day[r.id] = dayKey(now);
    const since = log.at[r.id];
    if (since !== undefined && !activeSince(db, host.projectId, since, host.messages())) {
      host.skipped(r);
      continue;
    }
    log.at[r.id] = now.getTime();
    host.run(r, `Scheduled ritual: ${r.title} (${ritualWhen(r)}).\n${r.prompt}`);
  }
  writeDoc(file(host.projectId), log);
}
