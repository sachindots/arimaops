// Pull requests the team opened: Open and Merged tabs, a compact table (number, title, task, agent, review, checks,
// age), and the selected PR's review summary beside it. Merging stays a human action on GitHub.
import { useState } from "react";
import type { PullRequest } from "../../data/types";
import { isViewer, reviewToolLabel, useOffice } from "../../store/office";
import { ui } from "../../store/ui";
import { Icon } from "../deck/Icon";
import { ago, Portrait, ReviewChip, useNow } from "../kit";
import { AnnotateModal } from "../preview/AnnotateModal";
import { DrawerHeader, PageTitle } from "./Drawer";
import { evidenceUrl } from "./TaskSheet";

/** "[P3-T02] Chat route" → "Chat route": the task id has its own column. */
const bare = (pr: PullRequest) => pr.title.replace(/^\[[^\]]+\]\s*/, "");

function Checks({ pr }: { pr: PullRequest }) {
  if (pr.merged) return <span className="text-[12px] text-muted">—</span>;
  if (pr.conflict) return <span className="flex items-center gap-1 text-[12px] text-red"><Icon name="error" size={16} /> Conflict</span>;
  if (pr.ciGreen) return <span className="flex items-center gap-1 text-[12px] text-green"><Icon name="check_circle" size={16} /> Green</span>;
  if (pr.ciGreen === false) return <span className="flex items-center gap-1 text-[12px] text-amber"><Icon name="pending" size={16} /> Not green</span>;
  return <span className="text-[12px] text-muted">Unknown</span>;
}

export function PrDrawer() {
  const snap = useOffice((s) => s.snap);
  const now = useNow(10_000);
  const [tab, setTab] = useState<"open" | "merged">("open");
  const [picked, setPicked] = useState<number | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  if (!snap) return null;
  const wf = snap.config.workflow;
  const open = snap.pullRequests.filter((p) => !p.merged && !p.closed).sort((a, b) => b.number - a.number);
  const merged = snap.pullRequests.filter((p) => p.merged).sort((a, b) => b.number - a.number).slice(0, 30);
  const list = tab === "open" ? open : merged;
  const current = list.find((p) => p.number === picked) ?? list[0];
  const team = snap.config.team;
  const cols = "56px minmax(0,2fr) 76px minmax(110px,1fr) 120px 96px 64px";

  return (
    <>
      <DrawerHeader>
        <PageTitle title="Pull requests" context={<>Review: {wf.review.enabled ? reviewToolLabel[wf.review.tool] : "off"} · Merge: {wf.merge.by === "lead" ? "the lead" : "you"}</>} />
      </DrawerHeader>
      <nav className="flex shrink-0 gap-1 border-b border-[var(--border-hairline)] px-4" aria-label="Pull request lists">
        {(["open", "merged"] as const).map((t) => (
          <button
            key={t}
            type="button"
            aria-current={tab === t ? "page" : undefined}
            onClick={() => (setTab(t), setPicked(null), setMobileDetail(false))}
            className={`-mb-px border-b-2 px-3 py-2 text-[13px] ${tab === t ? "border-[var(--accent)] font-medium text-ink" : "border-transparent text-muted hover:text-ink"}`}
          >
            {t === "open" ? "Open" : "Merged"} <span className="text-muted">{t === "open" ? open.length : merged.length}</span>
          </button>
        ))}
      </nav>
      <div className="flex min-h-0 flex-1 flex-col min-[1101px]:flex-row">
        <div className={`scroll-thin min-w-0 flex-1 overflow-auto ${mobileDetail && current ? "max-[1100px]:hidden" : ""}`}>
          {list.length === 0 ? (
            <p className="m-0 p-6 text-[13px] text-muted">{tab === "open" ? "No open PRs." : "Nothing merged yet."}</p>
          ) : (
            <div role="table" className="min-w-[680px] text-[13px]" aria-label={tab === "open" ? "Open pull requests" : "Merged pull requests"}>
              <div role="row" className="grid items-center gap-3 border-b border-[var(--border-hairline)] px-4 py-2 text-[12px] font-medium text-muted" style={{ gridTemplateColumns: cols }}>
                <span role="columnheader">#</span>
                <span role="columnheader">Title</span>
                <span role="columnheader">Task</span>
                <span role="columnheader">Agent</span>
                <span role="columnheader">Review</span>
                <span role="columnheader">Checks</span>
                <span role="columnheader" className="text-right">
                  Age
                </span>
              </div>
              {list.map((pr) => {
                const author = team.find((a) => a.id === pr.authorId);
                const on = pr === current;
                return (
                  <div
                    key={pr.number}
                    role="row"
                    tabIndex={0}
                    aria-selected={on || undefined}
                    onClick={() => (setPicked(pr.number), setMobileDetail(true))}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setPicked(pr.number), setMobileDetail(true))}
                    className={`grid cursor-pointer items-center gap-3 border-b border-[var(--border-hairline)] px-4 py-2.5 outline-none ${on ? "bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]" : "hover:bg-cream-2/70 focus-visible:bg-cream-2"}`}
                    style={{ gridTemplateColumns: cols }}
                  >
                    <span role="cell" className="font-semibold text-muted">#{pr.number}</span>
                    <span role="cell" className="min-w-0">
                      <span className="block truncate font-medium text-ink">{bare(pr)}</span>
                      {pr.openComments > 0 && !pr.merged && <span className="text-[12px] text-amber">{pr.openComments} open comment{pr.openComments === 1 ? "" : "s"}</span>}
                    </span>
                    <span role="cell">
                      {pr.taskId && (
                        <button type="button" className="text-[12px] font-medium text-accent hover:underline" onClick={(e) => (e.stopPropagation(), ui.openTask(pr.taskId))}>
                          {pr.taskId}
                        </button>
                      )}
                    </span>
                    <span role="cell" className="flex min-w-0 items-center gap-2">
                      {author && <Portrait name={author.name} color={author.color} lead={author.isLead} size={22} />}
                      <span className="truncate text-ink">{author?.name ?? (pr.authorId || "—")}</span>
                    </span>
                    <span role="cell">
                      <ReviewChip review={pr.review} merged={pr.merged} />
                    </span>
                    <span role="cell">
                      <Checks pr={pr} />
                    </span>
                    <span role="cell" className="text-right text-[12px] text-muted">
                      {ago(pr.openedAt, now)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {current && <Summary pr={current} mobileDetail={mobileDetail} onBack={() => setMobileDetail(false)} />}
      </div>
    </>
  );
}

/** The selected PR: where review stands, CI, conflicts, the files, and where to act. */
function Summary({ pr, mobileDetail, onBack }: { pr: PullRequest; mobileDetail?: boolean; onBack?: () => void }) {
  const snap = useOffice((s) => s.snap);
  const author = snap?.config.team.find((a) => a.id === pr.authorId);
  const linkedTask = snap?.tasks.find((t) => (pr.taskId && t.id === pr.taskId) || t.prNumber === pr.number);
  const projectId = snap?.config.project.id ?? "";
  const [annotating, setAnnotating] = useState<{ url: string; label: string } | null>(null);
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex items-baseline justify-between gap-3 border-b border-[var(--border-hairline)] py-2 text-[13px] last:border-b-0">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 truncate text-right text-ink">{value}</span>
    </div>
  );
  return (
    <aside
      className={`scroll-thin flex shrink-0 flex-col gap-4 overflow-y-auto border-t border-[var(--border-hairline)] bg-[var(--surface-card)] p-5 min-[1101px]:w-[340px] min-[1101px]:border-t-0 min-[1101px]:border-l ${
        mobileDetail ? "max-[1100px]:flex-1" : "max-[1100px]:max-h-[42dvh]"
      }`}
      aria-label={`PR #${pr.number}`}
    >
      {mobileDetail && onBack && (
        <button
          type="button"
          onClick={onBack}
          className="btn flex w-fit items-center gap-1.5 text-[12px] min-[1101px]:hidden"
        >
          <Icon name="arrow_back" size={16} /> Back to pull request list
        </button>
      )}
      <div>
        <div className="text-[12px] text-muted">#{pr.number}{pr.branch ? ` · ${pr.branch}` : ""}</div>
        <h2 className="m-0 mt-0.5 text-[15px] font-semibold leading-snug text-ink">{bare(pr)}</h2>
        <div className="mt-2">
          <ReviewChip review={pr.review} merged={pr.merged} />
        </div>
      </div>
      {pr.reviewNote && !pr.merged && <p className="m-0 rounded-lg bg-amber/10 px-3 py-2 text-[13px] text-ink">{pr.reviewNote}</p>}
      <div>
        {row("Agent", author?.name ?? (pr.authorId || "—"))}
        {row("Task", pr.taskId || "—")}
        {!pr.merged && row("Open comments", pr.openComments)}
        {!pr.merged && row("Checks", <Checks pr={pr} />)}
        {!pr.merged && row("Can merge", pr.conflict ? "No: merge conflict" : pr.mergeable ? "Yes" : "Not yet")}
        {pr.testsChanged !== undefined && row("Tests", pr.testsChanged ? "Adds or changes tests" : "No test changes")}
      </div>
      {pr.files && pr.files.length > 0 && (
        <div>
          <div className="mb-1.5 text-[12px] font-medium text-muted">Files · {pr.files.length}</div>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[12px] text-ink">
            {pr.files.slice(0, 20).map((f) => (
              <li key={f} className="truncate" title={f}>
                {f}
              </li>
            ))}
            {pr.files.length > 20 && <li className="text-muted">and {pr.files.length - 20} more</li>}
          </ul>
        </div>
      )}
      {linkedTask?.evidence && linkedTask.evidence.shots.length > 0 && (
        <div>
          <div className="mb-1.5 text-[12px] font-medium text-muted">
            Verifier Evidence · {linkedTask.evidence.shots.length}
          </div>
          <div className="flex flex-col gap-2">
            {linkedTask.evidence.shots.map((s) => {
              const url = evidenceUrl(projectId, linkedTask.id, linkedTask.evidence!.sha, s.file);
              const video = /\.(webm|mp4)$/.test(s.file);
              return (
                <div
                  key={s.file}
                  className="overflow-hidden rounded-lg border border-[var(--border-hairline)] bg-cream-2"
                >
                  <a href={url} target="_blank" rel="noreferrer" className="block" title={`${s.label}: open full size`}>
                    {video ? (
                      <video src={url} className="aspect-[16/10] w-full object-cover object-top" muted controls />
                    ) : (
                      <img
                        src={url}
                        alt={s.label}
                        loading="lazy"
                        className="aspect-[16/10] w-full object-cover object-top"
                      />
                    )}
                  </a>
                  <div className="flex items-center justify-between gap-2 px-2 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-[12px] text-muted" title={s.label}>
                      {s.label}
                    </span>
                    {!video && !isViewer && (
                      <button
                        type="button"
                        onClick={() => setAnnotating({ url, label: s.label })}
                        className="btn min-h-[26px] shrink-0 px-2 py-0.5 text-[12px]"
                        title="Freeze & Draw feedback on this evidence screenshot"
                      >
                        <Icon name="draw" size={14} />
                        Annotate
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="mt-auto flex flex-col gap-2">
        {pr.url ? (
          <a className="btn btn-primary justify-center text-[13px]" href={pr.url} target="_blank" rel="noreferrer">
            Open on GitHub ↗
          </a>
        ) : (
          <button className="btn justify-center text-[13px]" disabled title="Demo data has no GitHub link">
            Open on GitHub
          </button>
        )}
        <div className="flex gap-2">
          {pr.taskId && (
            <button className="btn flex-1 justify-center text-[13px]" onClick={() => ui.openTask(pr.taskId)}>
              Open task
            </button>
          )}
          {author && (
            <button className="btn flex-1 justify-center text-[13px]" onClick={() => ui.openAgent(author.id)}>
              {author.name}
            </button>
          )}
        </div>
      </div>
      {annotating && linkedTask && (
        <AnnotateModal
          imageUrl={annotating.url}
          title={annotating.label}
          sourceKind="pr-evidence"
          taskId={linkedTask.id}
          prNumber={pr.number}
          onClose={() => setAnnotating(null)}
        />
      )}
    </aside>
  );
}
