import type { Ritual } from "./model";

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const pad = (n: number) => String(n).padStart(2, "0");

/** "Mondays at 09:00" / "Every day at 18:00" / "The first Monday of the month at 11:00". */
export const ritualWhen = (r: Pick<Ritual, "day" | "hour" | "monthly">) =>
  `${r.day === undefined ? "Every day" : r.monthly ? `The first ${DAY_NAMES[r.day]} of the month` : `${DAY_NAMES[r.day]}s`} at ${pad(r.hour)}:00`;
