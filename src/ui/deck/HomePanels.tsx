// Home's side columns, beside the orbit: what needs the owner and the goals (left), and what the team just did
// (right). Shown only when the window is wide enough to keep the orbit readable (HOME_SIDE in frame.ts).
import type { OfficeSnapshot } from "../../data/types";
import { selectAttention } from "../../store/office";
import { ui } from "../../store/ui";
import { ago, useNow } from "../kit";
import { DECK, HOME_SIDE } from "./frame";
import { Icon } from "./Icon";

const column = "deck-panel pointer-events-auto fixed z-20 flex flex-col overflow-hidden rounded-xl border border-[var(--border-hairline)] bg-[var(--surface-card)] shadow-[var(--card-shadow)]";
const place = (side: "left" | "right") => ({
  top: DECK.header + 16,
  bottom: DECK.footer + 16,
  width: HOME_SIDE - 16,
  [side]: side === "left" ? DECK.rail + 16 : 16,
});

function Heading({ children, count }: { children: string; count?: number }) {
  return (
    <div className="flex items-center gap-2 px-4 pt-3.5 pb-2">
      <h2 className="m-0 text-[13px] font-semibold text-ink">{children}</h2>
      {count !== undefined && <span className="text-[12px] text-muted">{count}</span>}
    </div>
  );
}

export function NeedsYouPanel({ snap, onGoals }: { snap: OfficeSnapshot; onGoals: () => void }) {
  const a = selectAttention(snap);
  const name = (id: string) => snap.config.team.find((x) => x.id === id)?.name ?? (id === "hq" ? "HQ" : id);
  const rows = [
    ...a.items.map((i) => ({ key: i.id, icon: i.waiting ? "hourglass_top" : "inbox", title: i.title, sub: name(i.fromId), go: () => ui.openActions() })),
    ...a.asking.map((s) => ({ key: `ask-${s.agentId}`, icon: "help", title: `${name(s.agentId)} is asking you`, sub: s.note ?? "Open the terminal to answer", go: () => ui.openAgent(s.agentId, "terminal") })),
    ...a.access.map((r) => ({ key: `acc-${r.id}`, icon: "lock_open", title: `${name(r.agentId)} asks to reach ${r.domain}`, sub: r.reason || "Allow or deny in the Inbox", go: () => ui.openActions() })),
    ...a.blocked.map((b) => ({ key: `blk-${b.agentId}`, icon: "block", title: `${name(b.agentId)}'s sandbox blocked ${b.count} request${b.count === 1 ? "" : "s"}`, sub: "Review the sandbox approvals", go: () => ui.openAgent(b.agentId) })),
    ...a.readyPrs.map((p) => ({ key: `pr-${p.number}`, icon: "merge", title: `PR #${p.number} is ready to merge`, sub: p.title, go: () => ui.openPrs() })),
  ];
  const goals = (snap.goals ?? []).filter((g) => g.status === "active");
  return (
    <aside className={column} style={place("left")} aria-label="Needs you and goals">
      <Heading count={rows.length}>Needs you</Heading>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {rows.length === 0 && <p className="m-0 px-2 py-1 text-[13px] text-muted">Nothing waits on you.</p>}
        {rows.map((r) => (
          <button key={r.key} type="button" onClick={r.go} className="flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-cream-2">
            <Icon name={r.icon} size={18} className="mt-px text-amber" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-ink">{r.title}</span>
              <span className="block truncate text-[12px] text-muted">{r.sub}</span>
            </span>
          </button>
        ))}
      </div>
      {goals.length > 0 && (
        <div className="border-t border-[var(--border-hairline)] pb-3">
          <Heading count={goals.length}>Goals</Heading>
          <div className="flex flex-col gap-2.5 px-4">
            {goals.slice(0, 4).map((g) => (
              <button key={g.id} type="button" onClick={onGoals} className="cursor-pointer rounded-md text-left hover:opacity-80" title={`${g.done} of ${g.total} tasks done · $${g.usd.toFixed(2)} spent`}>
                <span className="flex items-baseline justify-between gap-2 text-[13px]">
                  <span className="truncate text-ink">{g.title}</span>
                  <span className="shrink-0 text-[12px] text-muted">
                    {g.done}/{g.total}
                  </span>
                </span>
                <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-cream-3">
                  <span className="block h-full rounded-full bg-accent" style={{ width: `${g.total ? (g.done / g.total) * 100 : 0}%` }} />
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

export function ActivityPanel({ snap }: { snap: OfficeSnapshot }) {
  const now = useNow(30_000);
  const today = new Date().toDateString();
  const events = snap.activity.filter((e) => new Date(e.at).toDateString() === today).slice(0, 30);
  const agent = (id: string | null) => (id ? snap.config.team.find((a) => a.id === id) : undefined);
  return (
    <aside className={column} style={place("right")} aria-label="Today's activity">
      <Heading count={events.length}>Today</Heading>
      <ol className="scroll-thin m-0 min-h-0 flex-1 list-none overflow-y-auto px-4 pb-3">
        {events.length === 0 && <li className="text-[13px] text-muted">No activity yet today.</li>}
        {events.map((e) => {
          const a = agent(e.agentId);
          return (
            <li key={e.id} className="flex gap-2.5 border-b border-[var(--border-hairline)] py-2 last:border-b-0">
              <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: a?.color ?? "var(--color-muted)" }} aria-hidden="true" />
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
