// One team message as the reader scans it: a tag chip (Done, Blocked, Question, FYI, Disagrees), the body without
// chat filler, code in blocks, and anything past 3 lines folded behind "more".
import { Fragment, useState } from "react";
import { isLong, SHORT_LINES, splitTag, TAG_LABEL, type MessageTag } from "../../data/messageTags";
import type { AgentMessage } from "../../data/types";

const TAG_COLOR: Record<MessageTag, string> = {
  done: "var(--color-ok, #3fb950)",
  blocked: "var(--color-red, #ef4444)",
  question: "var(--accent)",
  fyi: "var(--color-muted)",
  disagree: "var(--color-amber)",
};

export function TagChip({ tag }: { tag: MessageTag }) {
  return (
    <span className="chip text-[12px] font-medium" style={{ ["--c" as string]: TAG_COLOR[tag] }}>
      {TAG_LABEL[tag]}
    </span>
  );
}

/** The tag and body to show; older messages get the same parsing (filler trimmed only for agents' words). */
export const shown = (m: Pick<AgentMessage, "text" | "kind">, fromAgent: boolean) => splitTag(m.text, m.kind ?? null, fromAgent);

/** `inline code` inside a line. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("`") && p.endsWith("`") && p.length > 2 ? (
          <code key={i} className="rounded bg-[var(--color-cream-2,rgba(127,127,127,0.12))] px-1 font-term text-[13px]">
            {p.slice(1, -1)}
          </code>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

/** Text with ``` fenced blocks shown as code blocks. */
function Rich({ text }: { text: string }) {
  const chunks = text.split(/```[\w-]*\n?/);
  return (
    <>
      {chunks.map((c, i) =>
        i % 2 === 1 ? (
          <pre key={i} className="my-1.5 overflow-x-auto rounded-md border border-[var(--border-hairline)] bg-[var(--color-cream-2,rgba(127,127,127,0.08))] px-2.5 py-2 font-term text-[12px] leading-5">
            {c.replace(/\n$/, "")}
          </pre>
        ) : (
          c.trim() && (
            <p key={i} className="m-0 whitespace-pre-wrap">
              <Inline text={c.replace(/^\n+|\n+$/g, "")} />
            </p>
          )
        ),
      )}
    </>
  );
}

export function MessageText({ body, className = "text-[13px] leading-5" }: { body: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const long = isLong(body);
  const lines = body.split("\n");
  const short = lines.slice(0, SHORT_LINES).join("\n").slice(0, 320);
  return (
    <div className={className}>
      <Rich text={long && !open ? `${short}${short.length < body.length ? "…" : ""}` : body} />
      {long && (
        <button type="button" className="mt-0.5 text-[12px] font-medium text-accent hover:underline" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "less" : "more"}
        </button>
      )}
    </div>
  );
}
