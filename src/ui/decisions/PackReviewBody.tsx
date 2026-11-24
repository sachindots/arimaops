import type { DecisionPayload } from "../../data/generated";

type PackReview = Extract<DecisionPayload, { kind: "pack-review" }>;
type Line = { op: " " | "+" | "-"; text: string };

/** A line diff by longest common subsequence. Very large pairs show as all removed then all added, never truncated. */
export function lineDiff(before: string | null, after: string | null): Line[] {
  const a = before === null ? [] : before.split("\n");
  const b = after === null ? [] : after.split("\n");
  if (a.length * b.length > 4_000_000) return [...a.map((text) => ({ op: "-" as const, text })), ...b.map((text) => ({ op: "+" as const, text }))];
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ op: " ", text: a[i++] });
      j++;
    } else if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) out.push({ op: "+", text: b[j++] });
    else out.push({ op: "-", text: a[i++] });
  }
  return out;
}

const COLOR = { "+": "var(--color-green)", "-": "var(--color-red)", " ": "inherit" };

function List({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="text-[13px]">
      <span className="font-semibold text-ink">{label}: </span>
      <span className="font-term text-[12px]">{items.join(", ")}</span>
    </div>
  );
}

/** Everything a pack review asks about, in full: each changed file of the plugin and tool list as a diff. */
export function PackReviewBody({ payload }: { payload: PackReview }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[13px] text-muted">
        <span className="font-term">{payload.pack}</span>: {payload.from ? `commit ${payload.from.slice(0, 12)} → ` : "commit "}
        {payload.to.slice(0, 12)}
      </div>
      {payload.changed.map((c) => (
        <div key={`${c.kind}:${c.name}`} className="rounded-lg border border-[var(--border-hairline)] bg-cream-2/50 p-3">
          <div className="mb-1.5 text-[13px] font-semibold text-ink">
            {c.kind === "toolServer" ? "Tool server" : "File"} <span className="font-term">{c.name}</span>
            <span className="ml-2 text-[12px] font-normal text-muted">{c.before === null ? "new" : c.after === null ? "removed" : "changed"}</span>
          </div>
          <pre className="scroll-thin m-0 max-h-[480px] overflow-auto whitespace-pre-wrap break-words font-term text-[12px]">
            {lineDiff(c.before, c.after).map((l, i) => (
              <div key={i} style={{ color: COLOR[l.op] }}>
                {l.op} {l.text}
              </div>
            ))}
          </pre>
        </div>
      ))}
      <List label="Hosts it says it reaches" items={payload.egress} />
      <List label="Secrets it asks for" items={payload.secrets} />
      <List label="Not installed" items={payload.ignored} />
      {payload.findings.length > 0 && (
        <div className="text-[13px]">
          <span className="font-semibold text-ink">Scan findings:</span>
          <ul className="m-0 mt-1 flex flex-col gap-0.5 pl-4">
            {payload.findings.map((f, i) => (
              <li key={i} className={`font-term text-[12px] ${f.startsWith("block") ? "text-red" : "text-muted"}`}>
                {f}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
