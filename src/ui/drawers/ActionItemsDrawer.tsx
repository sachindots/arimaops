import { useEffect, useState, type ReactNode } from "react";
import { BRAND } from "../../data/brand";
import type { ActionItem } from "../../data/types";
import { isViewer, officeActions, selectAttention, useOffice } from "../../store/office";
import { ui, useUi } from "../../store/ui";
import { useAuth } from "../../store/auth";
import { ago, Dot, useNow } from "../kit";
import { Icon } from "../deck/Icon";
import { VisualDecisionCard } from "../decisions/VisualDecisionCard";
import { DrawerHeader, PageTitle } from "./Drawer";

function useSplitInboxPane(): boolean {
  const [wide, setWide] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(min-width: 960px)").matches : true,
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 960px)");
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

/** One row of the triage list and what the detail pane shows for it. */
interface Entry {
  key: string;
  icon: string;
  title: string;
  sub: string;
  at?: string;
  color?: string;
  /** "cannot undo" or "undoable": how final the main button is. */
  finality?: "cannot undo" | "undoable";
  waiting?: boolean;
  detail: ReactNode;
  /** Keyboard a / r. Left out where a stray key would cost (sending, spend, memory). */
  approve?: () => void;
  reject?: () => void;
}

const KIND_ICON: Record<string, string> = {
  question: "help", "second-opinion": "compare_arrows", disagreement: "warning", permission: "terminal", "meeting-request": "groups",
  plan: "account_tree", spec: "description", gate: "verified", lesson: "school", skills: "extension", overflow: "swap_horiz",
  send: "send", spend: "payments", approval: "undo", memory: "neurology", info: "info", request: "assignment_ind",
};

/** Everything waiting on the user in one triage list (j / k to move, a to approve, r to send back) and the item in full beside it. */
export function ActionItemsDrawer() {
  const snap = useOffice((s) => s.snap);
  const now = useNow(10_000);
  const splitPane = useSplitInboxPane();
  const [showClosed, setShowClosed] = useState(false);
  const selectedFromStore = useUi((s) => s.selectedDecisionId);
  const [selected, setSelected] = useState<string | null>(selectedFromStore);
  useEffect(() => {
    if (selectedFromStore) setSelected(selectedFromStore);
  }, [selectedFromStore]);
  const a = snap ? selectAttention(snap) : null;
  const agent = (id: string) => snap?.config.team.find((x) => x.id === id);
  const who = (id: string) => agent(id)?.name ?? (id === "hq" ? BRAND.name : id);

  const entries: Entry[] = [];
  if (snap && a) {
    // 1. Unified v2 Visual Decisions first (waiting first, then oldest first)
    const openDecisions = [...a.decisions].sort(
      (x, y) => Number(y.waiting) - Number(x.waiting) || x.createdAt.localeCompare(y.createdAt),
    );
    for (const dec of openDecisions) {
      const pKind = dec.payload.kind;
      entries.push({
        key: dec.id,
        icon: KIND_ICON[pKind] ?? "help",
        title: dec.title,
        sub: [who(dec.fromId), dec.taskId].filter(Boolean).join(" · "),
        at: dec.createdAt,
        color: agent(dec.fromId)?.color,
        waiting: dec.waiting,
        finality: dec.ownerOnly ? "cannot undo" : undefined,
        detail: <VisualDecisionCard decision={dec} />,
      });
    }

    // 2. Legacy Action Items
    const open = [...a.items].sort((x, y) => Number(y.waiting) - Number(x.waiting) || x.at.localeCompare(y.at));
    for (const item of open) {
      const kind = item.kind ?? "request";
      const keyed = !["send", "spend", "memory"].includes(kind) && !isViewer;
      entries.push({
        key: item.id,
        icon: KIND_ICON[kind] ?? "assignment",
        title: item.title,
        sub: [kind === "memory" ? "Team memory" : who(item.fromId), item.taskId].filter(Boolean).join(" · "),
        at: item.at,
        color: agent(item.fromId)?.color,
        finality: kind === "send" ? "cannot undo" : kind === "approval" ? "undoable" : undefined,
        waiting: item.waiting,
        detail: kind === "memory" ? <MemoryItem item={item} now={now} /> : <Item item={item} from={agent(item.fromId)} now={now} />,
        approve: keyed ? () => officeActions.resolveActionItem(item.id, "done") : undefined,
        reject: keyed ? () => officeActions.resolveActionItem(item.id, "dismissed") : undefined,
      });
    }
    for (const st of a.asking)
      entries.push({
        key: `ask-${st.agentId}`, icon: "help", title: `${who(st.agentId)} is asking you something`, sub: st.note ?? "In the terminal", color: agent(st.agentId)?.color,
        detail: <Plain text={`${who(st.agentId)} is waiting for an answer in its terminal.`} action={["Open terminal", () => ui.openAgent(st.agentId, "terminal")]} />,
      });
    for (const r of a.access)
      entries.push({
        key: r.id, icon: "lock_open", title: `${who(r.agentId)} ${r.observed ? "tried to reach" : "wants to reach"} ${r.domain}`, sub: r.reason || "Network access", at: r.at, color: agent(r.agentId)?.color,
        detail: (
          <Plain text={`${who(r.agentId)} ${r.observed ? "tried to reach" : "wants to reach"} ${r.domain}.${r.reason ? `\n\n${r.reason}` : ""}`}>
            {!isViewer && (
              <>
                <button className="btn btn-primary text-[13px]" onClick={() => officeActions.resolveAccess(r.id, "agent")}>Allow for {who(r.agentId)}</button>
                <button className="btn text-[13px]" onClick={() => officeActions.resolveAccess(r.id, "deny")}>Deny</button>
              </>
            )}
          </Plain>
        ),
        approve: isViewer ? undefined : () => officeActions.resolveAccess(r.id, "agent"),
        reject: isViewer ? undefined : () => officeActions.resolveAccess(r.id, "deny"),
      });
    for (const bl of a.blocked)
      entries.push({
        key: `blk-${bl.agentId}`, icon: "block", title: `${who(bl.agentId)}'s sandbox blocked ${bl.count} request${bl.count === 1 ? "" : "s"}`, sub: "Sandbox approvals", color: agent(bl.agentId)?.color,
        detail: <Plain text="The sandbox stopped these requests. Review them in the agent's panel." action={["Open the agent", () => ui.openAgent(bl.agentId)]} />,
      });
    for (const pr of a.readyPrs)
      entries.push({
        key: `pr-${pr.number}`, icon: "merge", title: `PR #${pr.number} is ready to merge`, sub: pr.title,
        detail: (
          <Plain text={`${pr.title}\n\nIt passed review. Merging stays yours.`}>
            {pr.url ? <a className="btn btn-primary text-[13px]" href={pr.url} target="_blank" rel="noreferrer">Open on GitHub ↗</a> : <button className="btn text-[13px]" onClick={() => ui.openPrs()}>Open PRs</button>}
          </Plain>
        ),
      });
  }
  const current = entries.find((e) => e.key === selected) ?? entries[0];
  const idx = current ? entries.indexOf(current) : -1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (e.metaKey || e.ctrlKey || e.altKey || (t instanceof Element && t.closest("input, textarea, select, [contenteditable=true]"))) return;
      if (e.key === "j" || e.key === "ArrowDown") entries[idx + 1] && (e.preventDefault(), setSelected(entries[idx + 1].key));
      else if (e.key === "k" || e.key === "ArrowUp") entries[idx - 1] && (e.preventDefault(), setSelected(entries[idx - 1].key));
      else if (e.key === "a" && current?.approve) (e.preventDefault(), current.approve(), setSelected(entries[idx + 1]?.key ?? null));
      else if (e.key === "r" && current?.reject) (e.preventDefault(), current.reject(), setSelected(entries[idx + 1]?.key ?? null));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!snap || !a) return null;
  const closed = (snap.actionItems ?? [])
    .filter((i) => i.status !== "open")
    .sort((x, y) => (y.closedAt ?? "").localeCompare(x.closedAt ?? ""))
    .slice(0, 20);

  return (
    <>
      <DrawerHeader>
        <PageTitle title="Inbox" context={<>{a.total ? `${a.total} waiting on you` : "Nothing waiting on you"}</>} />
        {entries.length > 0 && <span className="ml-auto hidden text-[12px] text-muted md:inline">j / k to move · a approve · r send back</span>}
      </DrawerHeader>
      <div className="flex min-h-0 flex-1">
        <div className={`flex shrink-0 flex-col border-r border-[var(--border-hairline)] ${splitPane ? "w-[380px]" : "w-full"}`}>
          <ul className="scroll-thin m-0 min-h-0 flex-1 list-none overflow-y-auto p-2" role="listbox" aria-label="Waiting on you">
            {entries.length === 0 && <li className="p-4 text-[13px] text-muted">All clear. When an agent needs a decision, approval or meeting, it shows up here.</li>}
            {entries.map((e) => {
              const on = e === current;
              return (
                <li key={e.key} role="option" aria-selected={on}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(e.key);
                      ui.setSelectedDecision(e.key);
                    }}
                    className={`flex w-full cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${on ? "bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]" : "hover:bg-cream-2"}`}
                  >
                    <Icon name={e.icon} size={18} className={`mt-0.5 ${e.waiting ? "text-amber" : "text-muted"}`} />
                    <span className="min-w-0 flex-1">
                      <span className={`line-clamp-2 text-[13px] ${on ? "font-semibold" : "font-medium"} text-ink`}>{e.title}</span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted">
                        {e.color && <Dot color={e.color} size={6} />}
                        <span className="truncate">{e.sub}</span>
                        {e.at && <span className="ml-auto shrink-0">{ago(e.at, now)}</span>}
                      </span>
                      {(e.waiting || e.finality) && (
                        <span className="mt-1 flex gap-1.5">
                          {e.waiting && <span className="rounded-full bg-amber/15 px-1.5 text-[12px] text-amber">agent waiting</span>}
                          {e.finality && (
                            <span className={`rounded-full px-1.5 text-[12px] ${e.finality === "cannot undo" ? "bg-red/10 text-red" : "bg-cream-3 text-muted"}`}>{e.finality}</span>
                          )}
                        </span>
                      )}
                    </span>
                  </button>
                  {!splitPane && on && <div className="px-3 pt-2 pb-4">{e.detail}</div>}
                </li>
              );
            })}
          </ul>
          {closed.length > 0 && (
            <div className="border-t border-[var(--border-hairline)] px-4 py-2">
              <button className="text-[13px] text-muted hover:text-ink" onClick={() => setShowClosed(!showClosed)}>
                {showClosed ? "Hide closed" : `Closed (${closed.length})`}
              </button>
              {showClosed && (
                <ul className="scroll-thin mt-1 flex max-h-[220px] list-none flex-col overflow-y-auto p-0 text-[12px] text-muted">
                  {closed.map((i) => (
                    <li key={i.id} className="border-t border-[var(--border-hairline)] py-1.5">
                      <span className={i.status === "dismissed" ? "line-through" : ""}>{i.title}</span> · {i.kind === "memory" ? "Team memory" : who(i.fromId)} ·{" "}
                      {i.kind === "send" ? (i.status === "done" ? "sent" : "not sent") : i.kind === "approval" ? (i.status === "done" ? "kept" : "undone") : i.kind === "overflow" ? (i.status === "done" ? "moved" : "waited") : i.kind === "skills" ? (i.status === "done" ? "approved" : "rejected") : i.kind === "gate" ? (i.status === "done" ? "approved" : "sent back") : i.kind === "lesson" ? (i.status === "done" ? "added" : "left out") : i.kind === "spec" ? (i.status === "done" ? "approved" : i.note?.startsWith("Replaced") ? "replaced" : "sent back") : i.status} {i.closedAt ? `${ago(i.closedAt, now)} ago` : ""}
                      {i.note && <div className="pl-3">“{i.note}”</div>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        {splitPane && (
          <section className="scroll-thin min-w-0 flex-1 overflow-y-auto px-8 py-6" aria-label="Selected item">
            {current ? <div key={current.key} className="mx-auto max-w-[760px]">{current.detail}</div> : <p className="text-[13px] text-muted">Nothing selected.</p>}
          </section>
        )}
      </div>
    </>
  );
}

/** Detail for things that aren't action items: what it is, and where to act. */
function Plain({ text, action, children }: { text: string; action?: [string, () => void]; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 whitespace-pre-wrap text-[15px] leading-7 text-ink">{text}</p>
      <div className="flex flex-wrap gap-2">
        {children}
        {action && (
          <button className="btn btn-primary text-[13px]" onClick={action[1]}>
            {action[0]}
          </button>
        )}
      </div>
    </div>
  );
}

function Item({ item, from, now }: { item: ActionItem; from?: { id: string; name: string; color: string }; now: number }) {
  const [note, setNote] = useState("");
  const [expanded, setExpanded] = useState(false);
  const long = item.details.split("\n").length > 12 || item.details.length > 900;
  return (
    <article className="flex flex-col gap-1">
      <div className="flex items-start gap-2">
        <h2 className="m-0 flex-1 text-[20px] font-semibold leading-snug text-ink">{item.title}</h2>
        {item.kind === "plan" && <span className="chip shrink-0 text-[12px]" style={{ ["--c" as string]: "#818cf8" }}>plan · needs approval</span>}
        {item.kind === "lesson" && <span className="chip shrink-0 text-[12px]" style={{ ["--c" as string]: "#8b5cf6" }}>lesson · for the template</span>}
        {item.kind === "gate" && <span className="chip shrink-0 text-[12px]" style={{ ["--c" as string]: "var(--color-amber)" }}>{item.gate?.reason === "outbound" ? "send · you send it" : `${item.gate?.reason ?? "gate"} · needs approval`}</span>}
        {item.kind === "spec" && <span className="chip shrink-0 text-[12px]" style={{ ["--c" as string]: "#818cf8" }}>spec · needs approval</span>}
        {item.kind === "skills" && <span className="chip shrink-0 text-[12px]" style={{ ["--c" as string]: "#8b5cf6" }}>skills · scan</span>}
        {item.kind === "overflow" && <span className="chip shrink-0 text-[12px]" style={{ ["--c" as string]: "#818cf8" }}>usage limit</span>}
        {item.kind === "send" && <span className="chip shrink-0 text-[12px]" style={{ ["--c" as string]: "var(--color-amber)" }}>send · {item.send?.connection}</span>}
        {item.kind === "spend" && <span className="chip shrink-0 text-[12px]" style={{ ["--c" as string]: "var(--color-red)" }}>spend</span>}
        {item.kind === "approval" && <span className="chip shrink-0 text-[12px]" style={{ ["--c" as string]: "var(--color-amber)" }}>lead approved · undoable</span>}
        {item.waiting && <span className="chip shrink-0 text-[12px]" style={{ ["--c" as string]: "#8b5cf6" }}>waiting</span>}
      </div>
      <div className="mb-1 flex items-center gap-1.5 text-[12px] text-muted">
        {from && <Dot color={from.color} size={8} />}
        {from ? (
          <button className="-my-2 py-2 underline" onClick={() => ui.openAgent(from.id, "messages")}>
            {from.name}
          </button>
        ) : (
          <span>{item.fromId === "hq" ? BRAND.name : item.fromId}</span>
        )}
        {item.taskId && <span>· {item.taskId}</span>}
        <span>· {ago(item.at, now)} ago</span>
      </div>
      {item.details && (
        <div className={`mt-2 whitespace-pre-wrap text-[15px] leading-7 text-ink ${long && !expanded ? "line-clamp-[12]" : ""}`}>{item.details}</div>
      )}
      {long && (
        <button className="text-[12px] underline" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Show all"}
        </button>
      )}
      {item.kind === "send" && item.send ? (
        <SendProposal item={item} send={item.send} />
      ) : item.kind === "skills" ? (
        <div className="mt-2 flex items-center gap-2">
          <button className="btn min-h-[44px] px-2 text-[12px]" onClick={() => officeActions.resolveActionItem(item.id, "done")}>
            Approve
          </button>
          <button className="btn min-h-[44px] px-2 text-[12px]" onClick={() => officeActions.resolveActionItem(item.id, "dismissed")}>
            Reject
          </button>
        </div>
      ) : item.kind === "overflow" && item.overflow ? (
        <div className="mt-2 flex items-center gap-2">
          <button className="btn min-h-[44px] px-2 text-[12px]" onClick={() => officeActions.resolveActionItem(item.id, "done")}>
            Move to {item.overflow.cli === "codex" ? "Codex" : item.overflow.cli}
          </button>
          <button className="btn min-h-[44px] px-2 text-[12px]" onClick={() => officeActions.resolveActionItem(item.id, "dismissed")}>
            Wait
          </button>
        </div>
      ) : item.kind === "spend" ? (
        <div className="mt-2 flex items-center gap-2">
          <button
            className="btn min-h-[44px] px-2 text-[12px]"
            onClick={() => {
              officeActions.resolveActionItem(item.id, "done");
              ui.openSettings("project");
            }}
          >
            Raise the cap
          </button>
          <button className="btn min-h-[44px] px-2 text-[12px]" onClick={() => officeActions.resolveActionItem(item.id, "dismissed")}>
            {/^Paused/.test(item.title) ? "Resume when it resets" : "OK"}
          </button>
        </div>
      ) : (
      <div className="mt-4 flex items-center gap-2">
        <input
          className="field min-w-0 flex-1 text-[13px]"
          value={note}
          placeholder="Note for the agent (optional, no secrets)"
          aria-label={`Note for the agent: ${item.title}`}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && officeActions.resolveActionItem(item.id, "done", note)}
        />
        <button className="btn btn-primary text-[13px]" onClick={() => officeActions.resolveActionItem(item.id, "done", note)}>
          {item.kind === "plan" || item.kind === "spec" || item.kind === "gate" || item.kind === "lesson" ? "Approve" : item.kind === "approval" ? "Keep" : "Done"}
        </button>
        <button className="btn text-[13px]" onClick={() => officeActions.resolveActionItem(item.id, "dismissed", note)}>
          {item.kind === "plan" || item.kind === "lesson" ? "Reject" : item.kind === "spec" || item.kind === "gate" ? "Send back" : item.kind === "approval" ? "Undo" : "Dismiss"}
        </button>
      </div>
      )}
    </article>
  );
}

/** An agent's proposed send: the exact call, and Send (owner only) makes it once. */
function SendProposal({ item, send }: { item: ActionItem; send: NonNullable<ActionItem["send"]> }) {
  const owner = useAuth((s) => s.role === "owner" || s.status === "none"); // "none": the demo, no sign-in
  const [busy, setBusy] = useState(false);
  useEffect(() => setBusy(false), [send.error, send.sentAt]);
  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="text-[12px] text-muted">
        HQ calls <span className="font-term text-ink">{send.tool}</span> on {send.connection} with exactly this, once, when you click Send:
      </div>
      <pre className="scroll-thin max-h-[240px] overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--border-hairline)] bg-cream-2 p-2 font-term text-[12px] text-ink">{JSON.stringify(send.args, null, 2)}</pre>
      {send.error && (
        <p className="text-[13px] text-red" role="alert">
          {send.error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button
          className="btn min-h-[44px] px-3 text-[13px]"
          disabled={!owner || busy}
          title={owner ? undefined : "Only the owner sends"}
          onClick={() => {
            setBusy(true);
            officeActions.sendProposal(item.id);
          }}
        >
          {busy ? "Sending…" : send.error ? "Send again" : "Send"}
        </button>
        <button className="btn min-h-[44px] px-2 text-[12px]" onClick={() => officeActions.resolveActionItem(item.id, "dismissed")}>
          Don't send
        </button>
      </div>
    </div>
  );
}

const TYPE_COLOR: Record<string, string> = { Decision: "#818cf8", Lesson: "#10b981", DeadEnd: "#ff4d6d" };

/** New memories from one task: certify or reject each, or certify them all at once. */
function MemoryItem({ item, now }: { item: ActionItem; now: number }) {
  const list = item.memories ?? [];
  const decide = (decisions: Record<string, "certify" | "reject">) => officeActions.decideMemories(item.id, decisions);
  return (
    <article className="flex flex-col">
      <div className="flex flex-wrap items-start gap-2">
        <h2 className="m-0 flex-1 text-[20px] font-semibold text-ink">{item.title}</h2>
        {!isViewer && list.length > 1 && (
          <button className="btn shrink-0 border-green px-2 text-[12px] text-green" onClick={() => decide(Object.fromEntries(list.map((m) => [m.id, "certify" as const])))}>
            Certify all {list.length}
          </button>
        )}
      </div>
      <div className="mb-1 text-[12px] text-muted">
        Team memory{item.taskId ? ` · ${item.taskId}` : ""} · {ago(item.at, now)} ago
      </div>
      <ul className="m-0 flex list-none flex-col divide-y divide-[var(--border-hairline)] p-0">
        {list.map((m) => (
          <li key={m.id} className="flex flex-col gap-2 py-3">
            <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
              <span className="chip chip-dot text-[12px]" style={{ ["--c" as string]: TYPE_COLOR[m.type] ?? "#8b5cf6" }}>
                {m.type}
              </span>
              <span className="font-mono text-muted">{m.id}</span>
              {m.about.map((a) => (
                <span key={a} className="font-mono text-muted">
                  {a}
                </span>
              ))}
            </div>
            <p className="m-0 text-[13px]">{m.text}</p>
            {m.conflict && (
              <p className="m-0 border-l border-orange pl-2 text-[12px]">
                May contradict certified {m.conflict.id}: “{m.conflict.text}”
              </p>
            )}
            {!isViewer && (
              <div className="flex gap-2">
                <button className="btn border-green px-3 text-[12px] text-green" onClick={() => decide({ [m.id]: "certify" })}>
                  Certify
                </button>
                <button className="btn px-3 text-[12px]" onClick={() => decide({ [m.id]: "reject" })}>
                  Reject
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </article>
  );
}
