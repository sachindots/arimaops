import { useState } from "react";
import type { DecisionPayload, PackFileSummary } from "../../data/generated";
import { useOffice } from "../../store/office";
import { Icon } from "../deck/Icon";

type PackReview = Extract<DecisionPayload, { kind: "pack-review" }>;
type Line = { op: " " | "+" | "-"; text: string };
export type LoadedPackDiff = { before: string | null; after: string | null };

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

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
}

const COLOR = { "+": "var(--color-green)", "-": "var(--color-red)", " ": "inherit" };

function DiffPre({ before, after }: { before: string | null; after: string | null }) {
  return (
    <pre className="scroll-thin m-0 max-h-[480px] overflow-auto whitespace-pre-wrap break-words font-term text-[12px]">
      {lineDiff(before, after).map((l, i) => (
        <div key={i} style={{ color: COLOR[l.op] }}>
          {l.op} {l.text}
        </div>
      ))}
    </pre>
  );
}

function List({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="text-[13px]">
      <span className="font-semibold text-ink">{label}: </span>
      <span className="font-term text-[12px]">{items.join(", ")}</span>
    </div>
  );
}

/** The roles an approval gives the pack's skills to. Read-only once the card is answered. */
function RolePicker({ roles, onRoles }: { roles: string[]; onRoles?: (ids: string[]) => void }) {
  const all = useOffice((s) => s.snap?.config.template?.roles) ?? [];
  if (all.length === 0) return null;
  return (
    <fieldset className="m-0 border-0 p-0 text-[13px]">
      <legend className="mb-1 p-0 font-semibold text-ink">Roles that get its skills</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {all.map((r) => (
          <label key={r.id} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={roles.includes(r.id)}
              disabled={!onRoles}
              onChange={(e) => onRoles?.(e.target.checked ? [...roles, r.id] : roles.filter((id) => id !== r.id))}
            />
            {r.title}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function scanLabel(file: PackFileSummary): { text: string; className: string } {
  if (file.scan === "block") return { text: `${file.findings || 1} block`, className: "text-red font-medium" };
  if (file.scan === "warn") return { text: `${file.findings || 1} warn`, className: "text-amber font-medium" };
  return { text: "clean", className: "text-muted" };
}

async function fetchPackFile(projectId: string, decisionId: string, filePath: string): Promise<LoadedPackDiff> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/decisions/${encodeURIComponent(decisionId)}/pack-file?path=${encodeURIComponent(filePath)}`,
    { credentials: "same-origin" },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
  }
  const data = (await res.json()) as { before: string | null; after: string | null };
  return { before: data.before, after: data.after };
}

/** Collapsed list of shipped files other than SKILL.md and agents/*.md, expandable per file. */
function OtherFilesList({
  files,
  loadFile,
}: {
  files: PackFileSummary[];
  loadFile: (path: string) => Promise<LoadedPackDiff>;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loaded, setLoaded] = useState<Record<string, { state: "loading" } | { state: "ready"; diff: LoadedPackDiff } | { state: "error"; message: string }>>({});

  if (files.length === 0) return null;
  const blockedCount = files.filter((f) => f.scan === "block").length;
  const warnCount = files.filter((f) => f.scan === "warn").length;

  const toggle = (filePath: string) => {
    const nextOpen = !expanded[filePath];
    setExpanded((prev) => ({ ...prev, [filePath]: nextOpen }));
    if (nextOpen && !loaded[filePath]) {
      setLoaded((prev) => ({ ...prev, [filePath]: { state: "loading" } }));
      void loadFile(filePath).then(
        (diff) => setLoaded((prev) => ({ ...prev, [filePath]: { state: "ready", diff } })),
        (err: unknown) =>
          setLoaded((prev) => ({
            ...prev,
            [filePath]: { state: "error", message: err instanceof Error ? err.message : "Could not load diff." },
          })),
      );
    }
  };

  return (
    <section
      className="rounded-lg border border-[var(--border-hairline)] bg-cream-2/30"
      aria-label="Other shipped files"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] px-3 py-2">
        <div className="text-[13px] font-semibold text-ink">
          Other shipped files ({files.length})
        </div>
        <div className="flex items-center gap-2 text-[12px]">
          {blockedCount > 0 && <span className="font-medium text-red">{blockedCount} blocked</span>}
          {warnCount > 0 && <span className="font-medium text-amber">{warnCount} with warnings</span>}
          {blockedCount === 0 && warnCount === 0 && <span className="text-muted">all clean</span>}
          <span className="text-muted">· hashed and scanned</span>
        </div>
      </div>
      <ul className="scroll-thin m-0 max-h-[320px] list-none divide-y divide-[var(--border-hairline)] overflow-y-auto p-0">
        {files.map((file) => {
          const isOpen = !!expanded[file.path];
          const entry = loaded[file.path];
          const scan = scanLabel(file);
          const changeLabel = file.change === "added" ? "new" : file.change;
          return (
            <li key={file.path}>
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => toggle(file.path)}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-cream-2/60"
              >
                <Icon name={isOpen ? "expand_more" : "chevron_right"} size={16} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate font-term text-[12px] text-ink">{file.path}</span>
                <span className="shrink-0 text-[12px] text-muted">{changeLabel}</span>
                <span className="shrink-0 font-term text-[12px] text-muted">{formatBytes(file.bytes)}</span>
                <span className={`shrink-0 text-[12px] ${scan.className}`}>{scan.text}</span>
              </button>
              {isOpen && (
                <div className="border-t border-[var(--border-hairline)] bg-cream-2/50 px-3 py-2">
                  {!entry || entry.state === "loading" ? (
                    <p className="m-0 text-[12px] text-muted">Loading diff…</p>
                  ) : entry.state === "error" ? (
                    <p className="m-0 text-[12px] text-red">{entry.message}</p>
                  ) : (
                    <DiffPre before={entry.diff.before} after={entry.diff.after} />
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Pack review: full inline diffs for SKILL.md, agents/*.md and tool servers;
 *  all other shipped files as a collapsed list expandable per file; plus egress, secrets, findings and roles. */
export function PackReviewBody({
  decisionId,
  projectId,
  payload,
  roles,
  onRoles,
  loadFile,
}: {
  decisionId: string;
  projectId: string;
  payload: PackReview;
  roles: string[];
  onRoles?: (ids: string[]) => void;
  loadFile?: (path: string) => Promise<LoadedPackDiff>;
}) {
  const otherFiles = payload.otherFiles ?? [];
  const fetcher = loadFile ?? ((p: string) => fetchPackFile(projectId, decisionId, p));

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
          <DiffPre before={c.before} after={c.after} />
        </div>
      ))}
      <OtherFilesList files={otherFiles} loadFile={fetcher} />
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
      <RolePicker roles={roles} onRoles={onRoles} />
    </div>
  );
}
