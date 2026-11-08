// Usage-limit detection from an agent's terminal. Subscriptions don't report what's left, but each CLI
// prints a message when it hits a limit, usually with when it resets.

/** Phrases the CLIs print on a usage/rate limit (not bare "rate limit", which shows up in code the agent writes). */
const LIMIT =
  /(?:usage|rate|5-hour|weekly|session|daily|monthly|premium request)[\w ’'-]{0,24}limit (?:reached|exceeded|hit)|hit (?:your|the) (?:usage |rate )?limit|reached your [\w ]{0,24}limit|quota exceeded|RESOURCE_EXHAUSTED|limit will reset/i;

const DEFAULT_MS = 30 * 60 * 1000; // no reset time printed: check again in 30 minutes

export interface LimitHit {
  /** The line that matched (used to ignore the same message on later polls). */
  line: string;
  until: Date;
  /** True when the reset time was read from the message. */
  exact: boolean;
}

/** Next local occurrence of h:m (12-hour with am/pm, or 24-hour). */
function nextClock(now: Date, h: number, m: number, ampm: string | undefined): Date {
  let hour = h % 24;
  if (ampm) hour = (h % 12) + (/p/i.test(ampm) ? 12 : 0);
  const d = new Date(now);
  d.setHours(hour, m, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

/** Finds a limit message on the screen and when it resets; null if none. */
export function detectLimit(screen: string, now = new Date()): LimitHit | null {
  const lines = screen.split("\n");
  let i = lines.length - 1;
  while (i >= 0 && !LIMIT.test(lines[i])) i--;
  if (i < 0) return null;
  const line = lines[i].trim();
  const text = lines.slice(i, i + 3).join(" ");

  // "…|1767225600" (Claude Code's machine-readable form): epoch seconds.
  const epoch = text.match(/\|(\d{10})\b/);
  if (epoch) return { line, until: new Date(Number(epoch[1]) * 1000), exact: true };
  // "try again in 2h 13m", "resets in 37 minutes", "in 1 hour"
  const rel = text.match(/\bin\s+(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?|s)?)?)?\b/i);
  if (rel && (rel[1] || rel[2])) return { line, until: new Date(now.getTime() + (Number(rel[1] ?? 0) * 60 + Number(rel[2] ?? 0)) * 60_000), exact: true };
  // "resets 3pm", "resets at 3:30 PM", "try again at 17:04"
  const clock = text.match(/\b(?:resets?|again)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (clock) return { line, until: nextClock(now, Number(clock[1]), Number(clock[2] ?? 0), clock[3]), exact: true };
  return { line, until: new Date(now.getTime() + DEFAULT_MS), exact: false };
}
