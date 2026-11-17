// What a message between agents is, as one word the reader sees first (a chip in the UI), and the body trimmed of
// chat filler (greetings, "Great question", sign-offs). Agents are asked to write at most 3 short lines; HQ tidies
// what they send anyway. Shared by server (planner.message) and UI (old messages without a tag).

export const MESSAGE_TAGS = ["done", "blocked", "question", "fyi", "disagree"] as const;
export type MessageTag = (typeof MESSAGE_TAGS)[number];

export const TAG_LABEL: Record<MessageTag, string> = { done: "Done", blocked: "Blocked", question: "Question", fyi: "FYI", disagree: "Disagrees" };

/** At most this many lines before the UI folds the rest behind "more". */
export const SHORT_LINES = 3;

const TAG_WORD: Record<string, MessageTag> = {
  done: "done", finished: "done", completed: "done", shipped: "done",
  blocked: "blocked", stuck: "blocked",
  question: "question", q: "question",
  fyi: "fyi", info: "fyi", note: "fyi", update: "fyi", heads: "fyi",
  disagree: "disagree", disagrees: "disagree", concern: "disagree",
};

/** "Done: …", "**Blocked** - …", "[FYI] …", "Question —" at the start. */
const LEADING = /^\s*(?:\*\*|__|\[)?\s*(done|finished|completed|shipped|blocked|stuck|question|q|fyi|info|note|update|heads(?:[- ]up)?|disagrees?|concern)(?:\*\*|__)?(?:\]|:|\s+[-–—]\s)(?:\*\*|__)?\s*/i;

const FILLER_START = [
  /^(hi|hey|hello)( there)?( team| all| everyone| [A-Z][\w-]*)?[,!]\s+/i,
  /^(great|good|excellent) (question|point|catch)[!.,]?\s+/i,
  /^(thanks|thank you)( so much)?( for [^.!\n]{0,60})?[!.,]\s+/i,
  /^(sure|absolutely|certainly|of course)[!.,]\s+/i,
  /^i hope (this|you)[^.!\n]{0,60}[.!]\s+/i,
  /^just (a quick note|wanted to (let you know|say))[^:\n]{0,20}[:,.]?\s*/i,
];
const FILLER_END = [
  /\s*(let me know|feel free to (reach out|ask|ping))[^.!\n]{0,80}[.!]?\s*$/i,
  /\s*(i )?hope (this|that) helps[.!]?\s*$/i,
  /\s*happy to help[^.!\n]{0,40}[.!]?\s*$/i,
  /\s*\n\s*(best|thanks|cheers|regards|best regards)[,!.]?\s*(\n.*)?$/i,
];

/** Strips greetings, praise and sign-offs at the edges (never inside), until nothing more comes off. */
export function tidy(text: string): string {
  let t = text.trim();
  for (let pass = 0; pass < 4; pass++) {
    const before = t;
    for (const re of FILLER_START) t = t.replace(re, "");
    for (const re of FILLER_END) t = t.replace(re, "");
    t = t.trim();
    if (t === before) break;
  }
  return t || text.trim();
}

/** The message's tag (the explicit kind wins, else a leading "Done:" style word) and its body, tidied unless it's the owner's own words. */
export function splitTag(text: string, kind?: MessageTag | null, tidyBody = true): { tag: MessageTag | null; body: string } {
  let body = text.trim();
  let tag: MessageTag | null = kind ?? null;
  const m = body.match(LEADING);
  if (m) {
    const word = m[1].toLowerCase().split(/[- ]/)[0];
    tag ??= TAG_WORD[word] ?? null;
    if (TAG_WORD[word]) body = body.slice(m[0].length);
  }
  return { tag, body: tidyBody ? tidy(body) : body.trim() };
}

/** True when a body is longer than a scan: more than SHORT_LINES lines or about 3 lines of text. */
export const isLong = (body: string) => body.split("\n").filter((l) => l.trim()).length > SHORT_LINES || body.length > 320;

/** What the receiving agent reads: the tag word first, so it knows at once what kind of note it is. */
export const delivered = (tag: MessageTag | null, body: string) => (tag ? `${TAG_LABEL[tag]}: ${body}` : body);
