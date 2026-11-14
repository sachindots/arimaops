import type { PullRequest } from "../../data/types";
import { reviewToolLabel, useOffice } from "../../store/office";
import { ui } from "../../store/ui";
import { ago, Dot, ReviewChip, SectionTitle, useNow } from "../kit";
import { DrawerHeader } from "./Drawer";

export function PrDrawer() {
  const snap = useOffice((s) => s.snap);
  const now = useNow(5000);
  if (!snap) return null;
  const wf = snap.config.workflow;
  const open = snap.pullRequests.filter((p) => !p.merged && !p.closed).sort((a, b) => b.number - a.number);
  const merged = snap.pullRequests.filter((p) => p.merged).sort((a, b) => b.number - a.number).slice(0, 15);

  const Row = ({ pr }: { pr: PullRequest }) => {
    const author = snap.config.team.find((a) => a.id === pr.authorId);
    // Merged green; open by review: changes asked amber, passed green, in review violet, waiting grey; a conflict is red.
    const edge = pr.merged ? "#3fb950" : pr.conflict ? "#ff2a4b" : pr.review === "changes-requested" ? "#ffb020" : pr.review === "passed" ? "#3fb950" : pr.review === "reviewing" ? "#a371f7" : "#8b9bb4";
    return (
      <li
        className={`hud-scan grid grid-cols-[60px_1fr_auto] items-center gap-3 rounded-xl border bg-navy/70 px-3 py-2.5 transition-colors ${pr.merged ? "border-white/[0.06]" : "hud-corners border-white/[0.1] hover:border-white/25"}`}
        style={{ ["--corner" as string]: edge, boxShadow: `inset 3px 0 0 ${edge}` }}
      >
        <span className="font-display text-[20px] font-semibold leading-none" style={{ color: pr.merged ? undefined : edge }}>
          #{pr.number}
        </span>
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold">{pr.title}</div>
          <div className="flex items-center gap-1.5 text-[12px] text-muted">
            {author && <Dot color={author.color} size={8} />}
            {author ? (
              <button className="-my-2 py-2 underline" onClick={() => ui.openAgent(author.id)}>
                {author.name}
              </button>
            ) : (
              <span>{pr.authorId || "—"}</span>
            )}
            · {ago(pr.openedAt, now)} ago
            {!pr.merged && <> · {pr.openComments} open comment{pr.openComments === 1 ? "" : "s"}{pr.conflict ? " · merge conflict" : ""}</>}
          </div>
          {pr.reviewNote && !pr.merged && <div className="text-[12px] text-orange">{pr.reviewNote}</div>}
        </div>
        <div className="flex flex-col items-end gap-1">
          <ReviewChip review={pr.review} merged={pr.merged} />
          {pr.url ? (
            <a className="btn px-2 text-[12px]" href={pr.url} target="_blank" rel="noreferrer">
              Open on GitHub ↗
            </a>
          ) : (
            <button className="btn px-2 text-[12px]" disabled title="Demo data has no GitHub link">
              Open on GitHub
            </button>
          )}
        </div>
      </li>
    );
  };

  return (
    <>
      <DrawerHeader>
        <b className="font-display text-[19px] font-semibold">Pull requests</b>
        <span className="truncate text-[14px] text-muted">
          Review: {wf.review.enabled ? reviewToolLabel[wf.review.tool] : "off"} · Merge: {wf.merge.by === "lead" ? "the lead" : "you"}
        </span>
      </DrawerHeader>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
        <SectionTitle>Open · {open.length}</SectionTitle>
        {open.length === 0 && <p className="mb-4 text-[15px] text-muted">No open PRs.</p>}
        <ul className="mb-5 flex flex-col gap-2">
          {open.map((pr) => (
            <Row key={pr.number} pr={pr} />
          ))}
        </ul>
        <SectionTitle>Merged</SectionTitle>
        <ul className="flex flex-col gap-2">
          {merged.map((pr) => (
            <Row key={pr.number} pr={pr} />
          ))}
        </ul>
      </div>
    </>
  );
}
