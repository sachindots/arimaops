// Home's side columns, beside the orbit: Waiting on you (sleek compact decision summary cards + goals on the left),
// Today's activity (right), and the natural-language "Tell the team / Quick action" intent bar.
import { useState } from "react";
import { BRAND } from "../../data/brand";
import type { QuestionAnswer, VisualDecision } from "../../data/generated";
import { mentioned } from "../../data/mentions";
import type { OfficeSnapshot } from "../../data/types";
import { isViewer, officeActions, selectAttention } from "../../store/office";
import { ui, useUi } from "../../store/ui";
import { ago, Dot, useNow } from "../kit";
import { DECK, HOME_SIDE } from "./frame";
import { Icon } from "./Icon";

const column =
  "deck-panel pointer-events-auto fixed z-20 flex flex-col overflow-hidden rounded-xl border border-[var(--border-hairline)] bg-[var(--surface-card)] shadow-[var(--card-shadow)]";
const inlineCard =
  "flex flex-col overflow-hidden rounded-xl border border-[var(--border-hairline)] bg-[var(--surface-card)] shadow-[var(--card-shadow)]";

const place = (side: "left" | "right", railWidth: number) => ({
  top: DECK.header + 16,
  bottom: DECK.footer + 16,
  width: HOME_SIDE - 16,
  [side]: side === "left" ? railWidth + 16 : 16,
});

function Heading({
  children,
  count,
  action,
}: {
  children: string;
  count?: number;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex items-center gap-2 border-b border-[var(--border-hairline)] px-4 py-3">
      <h2 className="m-0 text-[13px] font-semibold tracking-normal text-ink">{children}</h2>
      {count !== undefined && (
        <span className="rounded-full bg-cream-2 px-2 py-px text-[12px] font-medium text-muted">{count}</span>
      )}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="ml-auto cursor-pointer text-[12px] font-medium text-accent hover:underline"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

const KIND_META: Record<string, { icon: string; badge: string; color: string }> = {
  question: { icon: "help", badge: "Question", color: "var(--accent)" },
  "second-opinion": { icon: "compare_arrows", badge: "Second Opinion", color: "var(--accent)" },
  disagreement: { icon: "warning", badge: "Disagreement", color: "var(--color-amber)" },
  permission: { icon: "terminal", badge: "CLI Permission", color: "var(--color-amber)" },
  "meeting-request": { icon: "groups", badge: "Standup Invite", color: "var(--accent)" },
};

/**
 * Compact, high-contrast summary card for a VisualDecision inside Home's left column.
 * Never squeezes full multi-question forms or clipped inputs into the 324px rail; instead
 * shows the key recommendation/command and provides a 1-click quick action + "Open in Inbox".
 */
function HomeDecisionSummaryCard({
  decision,
  snap,
}: {
  decision: VisualDecision;
  snap: OfficeSnapshot;
}) {
  const from = snap.config.team.find((a) => a.id === decision.fromId);
  const fromName = from?.name ?? (decision.fromId === "hq" ? BRAND.name : decision.fromId);
  const meta = KIND_META[decision.payload.kind] ?? {
    icon: "inbox",
    badge: "Approval",
    color: "var(--color-amber)",
  };
  const p = decision.payload;

  const acceptRecommendedQuestion = () => {
    if (p.kind !== "question" || isViewer) return;
    const answers: QuestionAnswer[] = p.questions.map((q) => {
      const recs = q.options.filter((o) => o.recommended).map((o) => o.id);
      return {
        questionId: q.id,
        selectedOptionIds: recs.length ? (q.multiSelect ? recs : [recs[0]]) : q.options[0] ? [q.options[0].id] : [],
        otherText: null,
      };
    });
    officeActions.answerDecision(decision.id, {
      status: "resolved",
      answers,
      note: "Accepted recommended options from Home",
    });
  };

  const firstRecommended =
    p.kind === "question"
      ? p.questions.flatMap((q) => q.options).find((o) => o.recommended)?.label
      : null;

  return (
    <article
      className="flex flex-col gap-2 rounded-xl border border-[var(--border-hairline)] bg-cream-2/55 p-3 transition-colors hover:border-[var(--border-strong)]"
      aria-label={decision.title}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="chip text-[12px]" style={{ ["--c" as string]: meta.color }}>
          <Icon name={meta.icon} size={14} />
          <span>{meta.badge}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted">
          {from && <Dot color={from.color} size={7} />}
          <span className="truncate font-medium text-ink">{fromName}</span>
          {decision.taskId && <span className="text-accent">· {decision.taskId}</span>}
        </span>
      </div>

      <h3 className="m-0 line-clamp-2 text-[13px] font-semibold leading-snug text-ink">{decision.title}</h3>

      {p.kind === "question" && firstRecommended && (
        <div className="flex items-center gap-1.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-card)] px-2.5 py-1.5 text-[12px]">
          <Icon name="check_circle" size={15} className="shrink-0 text-accent" />
          <span className="truncate text-ink">{firstRecommended}</span>
          <span className="ml-auto shrink-0 text-[12px] font-medium text-accent">(Recommended)</span>
        </div>
      )}

      {(p.kind === "second-opinion" || p.kind === "disagreement") && (
        <div className="rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-card)] px-2.5 py-1.5 text-[12px] text-muted">
          <span className="block truncate font-medium text-ink">{p.optionA.label}</span>
          <span className="block truncate">vs {p.optionB.label}</span>
        </div>
      )}

      {p.kind === "permission" && (
        <code className="block truncate rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-card)] px-2.5 py-1.5 text-[12px] text-ink">
          {p.commandOrPath}
        </code>
      )}

      {p.kind === "meeting-request" && (
        <div className="text-[12px] text-muted">
          {p.participantIds.length} agents ready · {p.agendaPreview.length} agenda items
        </div>
      )}

      <div className="mt-0.5 flex items-center gap-1.5">
        {p.kind === "question" && !isViewer && (
          <button
            type="button"
            onClick={acceptRecommendedQuestion}
            className="btn btn-primary flex-1 px-2.5 py-1 text-[12px]"
            title="Submit all recommended answers in one click"
          >
            <Icon name="done_all" size={15} /> Accept Recommended
          </button>
        )}

        {p.kind === "permission" && !isViewer && (
          <button
            type="button"
            onClick={() =>
              officeActions.answerDecision(decision.id, {
                status: "resolved",
                resolution: "allow-once",
              })
            }
            className="btn btn-primary flex-1 px-2.5 py-1 text-[12px]"
          >
            <Icon name="check" size={15} /> Allow once
          </button>
        )}

        {p.kind === "meeting-request" && (
          <button
            type="button"
            onClick={() => {
              if (!isViewer) {
                officeActions.answerDecision(decision.id, {
                  status: "resolved",
                  meetingAction: "join",
                });
              }
              ui.openMeetings(p.meetingId);
            }}
            className="btn btn-primary flex-1 px-2.5 py-1 text-[12px]"
          >
            <Icon name="forum" size={15} /> Join Standup
          </button>
        )}

        <button
          type="button"
          onClick={() => ui.openActions(decision.id)}
          className={`btn px-2.5 py-1 text-[12px] ${
            p.kind === "second-opinion" || p.kind === "disagreement" || isViewer ? "btn-primary flex-1" : ""
          }`}
        >
          <span>{p.kind === "second-opinion" || p.kind === "disagreement" ? "Compare A / B" : "Review"}</span>
          <Icon name="arrow_forward" size={14} />
        </button>
      </div>
    </article>
  );
}

/**
 * Natural-language "Tell the team / Quick action" intent bar on Home:
 * Routes plain English like "start a standup", "open preview", "review PRs", "goal: ...", or sends a message to the team.
 */
export function HomeIntentBar({ snap, inline = false }: { snap: OfficeSnapshot; inline?: boolean }) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const railExpanded = useUi((s) => s.railExpanded);
  const railW = railExpanded ? DECK.railExpanded : DECK.rail;

  const runIntent = (raw: string) => {
    const clean = raw.trim();
    if (!clean) return;
    const lower = clean.toLowerCase();

    if (/^(start|join|open)\s+(a\s+)?(standup|meeting|call|sync)/i.test(lower) || lower === "standup") {
      const liveMtg = (snap.meetings ?? []).find((m) => m.status === "live" || m.status === "requested");
      if (liveMtg) {
        ui.openMeetings(liveMtg.id);
      } else if (!isViewer) {
        officeActions.startMeeting({
          kind: "standup",
          title: "Team Standup",
          urgency: "normal",
          participantIds: snap.config.team.map((a) => a.id),
        });
        ui.openMeetings();
      }
      setText("");
      return;
    }

    if (/^(open\s+)?preview|freeze|annotate|inspect/i.test(lower)) {
      ui.openPreview();
      setText("");
      return;
    }

    if (/^(review\s+|open\s+)?prs?\b|pull requests?/i.test(lower)) {
      ui.openPrs();
      setText("");
      return;
    }

    if (/^(open\s+)?(board|tasks|kanban)/i.test(lower)) {
      ui.openBoards();
      setText("");
      return;
    }

    if (/^(open\s+)?(inbox|decisions|approvals)/i.test(lower)) {
      ui.openActions();
      setText("");
      return;
    }

    if (/^goal:\s*(.+)/i.test(clean) && !isViewer) {
      const title = clean.replace(/^goal:\s*/i, "").trim();
      if (title) {
        officeActions.addGoal({ title });
        ui.openGoals();
        setText("");
        return;
      }
    }

    if (isViewer) return;
    const to = mentioned(snap.config.team, clean);
    if (to.length > 0) {
      for (const id of to) officeActions.sendMessage(id, clean);
      setStatus(`Sent to ${to.map((id) => snap.config.team.find((a) => a.id === id)?.name ?? id).join(", ")}`);
    } else {
      officeActions.askTeam(clean);
      const lead = snap.config.team.find((a) => a.isLead);
      setStatus(`Sent to ${lead?.name ?? "the team"} — reply in Chat`);
    }
    setText("");
  };

  const containerClass = inline
    ? "flex flex-col gap-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--surface-card)] p-3 shadow-[var(--card-shadow)]"
    : "pointer-events-auto fixed z-20 flex w-[min(560px,calc(100vw-120px))] -translate-x-1/2 flex-col gap-2 rounded-xl border border-[var(--border-strong)] bg-[var(--surface-glass)] p-3 shadow-[var(--card-shadow-hover)] backdrop-blur-md transition-[left] duration-150";

  return (
    <section
      className={containerClass}
      style={
        inline
          ? undefined
          : {
              bottom: DECK.footer + 12,
              left: `calc(${railW}px + (100vw - ${railW}px) / 2)`,
            }
      }
      aria-label="Tell the team or run a quick action"
    >
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          runIntent(text);
        }}
      >
        <Icon name="bolt" size={18} className="shrink-0 text-accent" />
        <input
          className="field flex-1 text-[13px]"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (status) setStatus(null);
          }}
          placeholder='Tell the team, or type "start a standup", "open preview", "review PRs"…'
          aria-label="Tell the team or quick action"
        />
        <button type="submit" className="btn btn-primary px-3.5 text-[12px]" disabled={!text.trim()}>
          Run
        </button>
      </form>

      <div className="flex flex-wrap items-center justify-between gap-1.5 px-0.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => runIntent("start a standup")}
            className="deck-pill flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium text-ink hover:border-[var(--accent)]"
          >
            <Icon name="groups" size={15} className="text-accent" />
            <span>Standup Room</span>
          </button>
          <button
            type="button"
            onClick={() => ui.openPreview()}
            className="deck-pill flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium text-ink hover:border-[var(--accent)]"
          >
            <Icon name="preview" size={15} className="text-accent" />
            <span>Live Preview</span>
          </button>
          <button
            type="button"
            onClick={() => ui.openPrs()}
            className="deck-pill flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium text-ink hover:border-[var(--accent)]"
          >
            <Icon name="merge_type" size={15} className="text-accent" />
            <span>Review PRs</span>
          </button>
        </div>
        {status && (
          <button
            type="button"
            onClick={() => ui.openChat()}
            className="text-[12px] font-medium text-accent hover:underline"
          >
            {status} →
          </button>
        )}
      </div>
    </section>
  );
}

export function NeedsYouPanel({
  snap,
  onGoals,
  inline = false,
}: {
  snap: OfficeSnapshot;
  onGoals: () => void;
  inline?: boolean;
}) {
  const a = selectAttention(snap);
  const railExpanded = useUi((s) => s.railExpanded);
  const railW = railExpanded ? DECK.railExpanded : DECK.rail;
  const name = (id: string) => snap.config.team.find((x) => x.id === id)?.name ?? (id === "hq" ? "HQ" : id);
  const openDecisions = a.decisions;

  const rows = [
    ...a.items.map((i) => ({
      key: i.id,
      icon: i.waiting ? "hourglass_top" : "inbox",
      title: i.title,
      sub: name(i.fromId),
      go: () => ui.openActions(i.id),
    })),
    ...a.asking.map((s) => ({
      key: `ask-${s.agentId}`,
      icon: "help",
      title: `${name(s.agentId)} is asking you`,
      sub: s.note ?? "Answer in Inbox",
      go: () => ui.openActions(`ask-${s.agentId}`),
    })),
    ...a.access.map((r) => ({
      key: `acc-${r.id}`,
      icon: "lock_open",
      title: `${name(r.agentId)} asks to reach ${r.domain}`,
      sub: r.reason || "Allow or deny in Inbox",
      go: () => ui.openActions(r.id),
    })),
    ...a.blocked.map((b) => ({
      key: `blk-${b.agentId}`,
      icon: "block",
      title: `${name(b.agentId)}'s sandbox blocked ${b.count} request${b.count === 1 ? "" : "s"}`,
      sub: "Review sandbox approvals",
      go: () => ui.openAgent(b.agentId),
    })),
    ...a.readyPrs.map((p) => ({
      key: `pr-${p.number}`,
      icon: "merge",
      title: `PR #${p.number} is ready to merge`,
      sub: p.title,
      go: () => ui.openPrs(),
    })),
  ];
  const goals = (snap.goals ?? []).filter((g) => g.status === "active");
  const totalCount = openDecisions.length + rows.length;

  return (
    <aside
      className={inline ? inlineCard : column}
      style={inline ? undefined : place("left", railW)}
      aria-label="Waiting on you and goals"
    >
      <Heading
        count={totalCount}
        action={totalCount > 0 ? { label: "Open Inbox", onClick: () => ui.openActions() } : undefined}
      >
        Waiting on you
      </Heading>
      <div
        className={
          inline
            ? "flex flex-col gap-2.5 p-3"
            : "scroll-thin flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3"
        }
      >
        {totalCount === 0 && <p className="m-0 px-1 py-1 text-[13px] text-muted">Nothing waits on you.</p>}

        {/* Sleek, scannable compact summary cards for VisualDecisions */}
        {openDecisions.slice(0, inline ? 2 : 3).map((dec) => (
          <HomeDecisionSummaryCard key={dec.id} decision={dec} snap={snap} />
        ))}

        {openDecisions.length > (inline ? 2 : 3) && (
          <button
            type="button"
            onClick={() => ui.openActions()}
            className="w-full cursor-pointer rounded-lg border border-[var(--border-hairline)] bg-cream-2/50 px-3 py-2 text-left text-[12px] font-medium text-accent hover:bg-cream-2"
          >
            +{openDecisions.length - (inline ? 2 : 3)} more visual decision{openDecisions.length - (inline ? 2 : 3) === 1 ? "" : "s"} in Inbox →
          </button>
        )}

        {(inline ? rows.slice(0, 3) : rows.slice(0, 4)).map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={r.go}
            className="flex w-full cursor-pointer items-start gap-2.5 rounded-lg border border-[var(--border-hairline)] bg-cream-2/35 px-3 py-2 text-left transition-colors hover:border-[var(--border-strong)] hover:bg-cream-2"
          >
            <Icon name={r.icon} size={18} className="mt-0.5 shrink-0 text-amber" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-ink">{r.title}</span>
              <span className="block truncate text-[12px] text-muted">{r.sub}</span>
            </span>
          </button>
        ))}
      </div>

      {!inline && goals.length > 0 && (
        <div className="border-t border-[var(--border-hairline)] pb-3">
          <Heading count={goals.length} action={{ label: "View all", onClick: onGoals }}>
            Goals
          </Heading>
          <div className="flex flex-col gap-2.5 px-4 pt-2.5">
            {goals.slice(0, 3).map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={onGoals}
                className="cursor-pointer rounded-md text-left hover:opacity-80"
                title={`${g.done} of ${g.total} tasks done · $${g.usd.toFixed(2)} spent`}
              >
                <span className="flex items-baseline justify-between gap-2 text-[13px]">
                  <span className="truncate font-medium text-ink">{g.title}</span>
                  <span className="shrink-0 text-[12px] text-muted">
                    {g.done}/{g.total}
                  </span>
                </span>
                <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-cream-3">
                  <span
                    className="block h-full rounded-full bg-accent"
                    style={{ width: `${g.total ? (g.done / g.total) * 100 : 0}%` }}
                  />
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

export function ActivityPanel({ snap, inline = false }: { snap: OfficeSnapshot; inline?: boolean }) {
  const now = useNow(30_000);
  const railExpanded = useUi((s) => s.railExpanded);
  const railW = railExpanded ? DECK.railExpanded : DECK.rail;
  const today = new Date().toDateString();
  const events = snap.activity.filter((e) => new Date(e.at).toDateString() === today).slice(0, inline ? 8 : 30);
  const agent = (id: string | null) => (id ? snap.config.team.find((a) => a.id === id) : undefined);
  return (
    <aside
      className={inline ? inlineCard : column}
      style={inline ? undefined : place("right", railW)}
      aria-label="Today's activity"
    >
      <Heading count={events.length}>Today</Heading>
      <ol
        className={
          inline
            ? "m-0 list-none px-4 pb-3"
            : "scroll-thin m-0 min-h-0 flex-1 list-none overflow-y-auto px-4 pb-3"
        }
      >
        {events.length === 0 && <li className="py-3 text-[13px] text-muted">No activity yet today.</li>}
        {events.map((e) => {
          const a = agent(e.agentId);
          return (
            <li key={e.id} className="flex gap-2.5 border-b border-[var(--border-hairline)] py-2.5 last:border-b-0">
              <span
                className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                style={{ background: a?.color ?? "var(--color-muted)" }}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 text-[13px] text-ink">{e.text}</span>
                <span className="text-[12px] text-muted">{ago(e.at, now)}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
