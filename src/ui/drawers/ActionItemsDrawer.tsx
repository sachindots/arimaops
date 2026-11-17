import { useEffect, useState, type ReactNode } from "react";
import { BRAND } from "../../data/brand";
import type { ActionItem } from "../../data/types";
import { isViewer, officeActions, selectAttention, useOffice } from "../../store/office";
import { ui } from "../../store/ui";
import { useAuth } from "../../store/auth";
import { ago, Dot, SectionTitle, useNow } from "../kit";
import { DrawerHeader, PageTitle } from "./Drawer";

/** Everything waiting on the user: agents' action items first, then the other things that need them. */
export function ActionItemsDrawer() {
  const snap = useOffice((s) => s.snap);
  const now = useNow(10_000);
  const [showClosed, setShowClosed] = useState(false);
  if (!snap) return null;
  const a = selectAttention(snap);
  const agent = (id: string) => snap.config.team.find((x) => x.id === id);
  const closed = (snap.actionItems ?? [])
    .filter((i) => i.status !== "open")
    .sort((x, y) => (y.closedAt ?? "").localeCompare(x.closedAt ?? ""))
    .slice(0, 20);
  // Waiting items first, then oldest first (what's been waiting longest).
  const open = [...a.items].sort((x, y) => Number(y.waiting) - Number(x.waiting) || x.at.localeCompare(y.at));
  const others = a.asking.length + a.access.length + a.blocked.length + a.readyPrs.length;

  return (
    <>
      <DrawerHeader>
        <PageTitle title="Inbox" context={<>{a.total ? `${a.total} waiting on you` : "Nothing waiting on you"}</>} />
      </DrawerHeader>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
        <SectionTitle>From agents</SectionTitle>
        {open.length === 0 ? (
          <p className="mb-4 text-[13px] text-muted">No requests. When an agent needs you to do something outside its sandbox, it shows up here.</p>
        ) : (
          <ul className="mb-4 flex flex-col gap-2">
            {open.map((item) => (
              item.kind === "memory" ? <MemoryItem key={item.id} item={item} now={now} /> : <Item key={item.id} item={item} from={agent(item.fromId)} now={now} />
            ))}
          </ul>
        )}

        {others > 0 && (
          <>
            <SectionTitle>Also waiting on you</SectionTitle>
            <ul className="mb-4 flex flex-col gap-1.5 text-[13px]">
              {a.asking.map((s) => (
                <Row key={`ask-${s.agentId}`} color={agent(s.agentId)?.color} text={`${agent(s.agentId)?.name ?? s.agentId} is asking you something in the terminal`} onOpen={() => ui.openAgent(s.agentId, "terminal")} />
              ))}
              {a.access.map((r) => (
                <Row
                  key={r.id}
                  color={agent(r.agentId)?.color}
                  text={`${agent(r.agentId)?.name ?? r.agentId} ${r.observed ? "tried to reach" : "wants to reach"} ${r.domain}`}
                  onOpen={() => ui.openAgent(r.agentId)}
                  actions={
                    isViewer ? undefined : (
                      <>
                        <button className="btn px-2 text-[12px]" onClick={() => officeActions.resolveAccess(r.id, "agent")} title={`Allow ${r.domain} for ${agent(r.agentId)?.name ?? "this agent"}`}>
                          Allow
                        </button>
                        <button className="btn px-2 text-[12px]" onClick={() => officeActions.resolveAccess(r.id, "deny")}>
                          Deny
                        </button>
                      </>
                    )
                  }
                />
              ))}
              {a.blocked.map((b) => (
                <Row
                  key={`blk-${b.agentId}`}
                  color={agent(b.agentId)?.color}
                  text={`${agent(b.agentId)?.name ?? b.agentId}'s sandbox blocked ${b.count} request${b.count === 1 ? "" : "s"}`}
                  onOpen={() => ui.openAgent(b.agentId)}
                />
              ))}
              {a.readyPrs.map((p) =>
                p.url ? (
                  <li key={`pr-${p.number}`} className="flex items-center gap-2 rounded-lg border border-green/35 bg-[var(--surface-card)] px-3 py-2 shadow-[var(--card-shadow)]" style={{ boxShadow: "inset 3px 0 0 #3fb950" }}>
                    <span className="flex-1">
                      PR <b>#{p.number}</b> {p.title} passed review and is ready to merge
                    </span>
                    <a className="btn px-2 text-[12px]" href={p.url} target="_blank" rel="noreferrer">
                      Open ↗
                    </a>
                  </li>
                ) : (
                  <Row key={`pr-${p.number}`} text={`PR #${p.number} ${p.title} passed review and is ready to merge`} onOpen={() => ui.openPrs()} />
                ),
              )}
            </ul>
          </>
        )}

        {closed.length > 0 && (
          <>
            <button className="text-[13px] underline" onClick={() => setShowClosed(!showClosed)}>
              {showClosed ? "Hide closed" : `Show closed (${closed.length})`}
            </button>
            {showClosed && (
              <ul className="mt-2 flex flex-col gap-1 text-[13px] text-muted">
                {closed.map((i) => (
                  <li key={i.id} className="border-t border-[var(--border-hairline)] py-1.5">
                    <span className={i.status === "dismissed" ? "line-through" : ""}>{i.title}</span> · {i.kind === "memory" ? "Team memory" : (agent(i.fromId)?.name ?? (i.fromId === "hq" ? BRAND.name : i.fromId))} ·{" "}
                    {i.kind === "send" ? (i.status === "done" ? "sent" : "not sent") : i.kind === "approval" ? (i.status === "done" ? "kept" : "undone") : i.kind === "overflow" ? (i.status === "done" ? "moved" : "waited") : i.kind === "skills" ? (i.status === "done" ? "approved" : "rejected") : i.kind === "gate" ? (i.status === "done" ? "approved" : "sent back") : i.kind === "lesson" ? (i.status === "done" ? "added" : "left out") : i.kind === "spec" ? (i.status === "done" ? "approved" : i.note?.startsWith("Replaced") ? "replaced" : "sent back") : i.status} {i.closedAt ? `${ago(i.closedAt, now)} ago` : ""}
                    {i.note && <div className="pl-3">“{i.note}”</div>}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </>
  );
}

function Row({ text, color, onOpen, actions }: { text: string; color?: string; onOpen: () => void; actions?: ReactNode }) {
  return (
    <li className="flex items-center gap-2 rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-card)] px-3 py-2 shadow-[var(--card-shadow)]" style={{ boxShadow: "inset 3px 0 0 #ffb020" }}>
      {color && <Dot color={color} size={8} />}
      <span className="flex-1">{text}</span>
      {actions}
      <button className="btn px-2 text-[12px]" onClick={onOpen}>
        Open
      </button>
    </li>
  );
}

function Item({ item, from, now }: { item: ActionItem; from?: { id: string; name: string; color: string }; now: number }) {
  const [note, setNote] = useState("");
  const [expanded, setExpanded] = useState(false);
  const long = item.details.split("\n").length > 6 || item.details.length > 400;
  return (
    <li
      className="rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-card)] px-4 py-3 shadow-[var(--card-shadow)] transition-colors hover:border-[var(--border-strong)]"
      style={{ boxShadow: `inset 3px 0 0 ${item.waiting ? "#8b5cf6" : "#f59e0b"}` }}
    >
      <div className="flex items-start gap-2">
        <b className="flex-1 text-[15px] font-semibold">{item.title}</b>
        {item.kind === "plan" && <span className="chip shrink-0 text-[12px]" style={{ ["--c" as string]: "#818cf8" }}>plan · needs approval</span>}
        {item.kind === "lesson" && <span className="chip shrink-0 text-[12px]" style={{ ["--c" as string]: "#a371f7" }}>lesson · for the template</span>}
        {item.kind === "gate" && <span className="chip shrink-0 text-[12px]" style={{ ["--c" as string]: "#ffb020" }}>{item.gate?.reason === "outbound" ? "send · you send it" : `${item.gate?.reason ?? "gate"} · needs approval`}</span>}
        {item.kind === "spec" && <span className="chip shrink-0 text-[12px]" style={{ ["--c" as string]: "#818cf8" }}>spec · needs approval</span>}
        {item.kind === "skills" && <span className="chip shrink-0 text-[12px]" style={{ ["--c" as string]: "#a371f7" }}>skills · scan</span>}
        {item.kind === "overflow" && <span className="chip shrink-0 text-[12px]" style={{ ["--c" as string]: "#818cf8" }}>usage limit</span>}
        {item.kind === "send" && <span className="chip shrink-0 text-[12px]" style={{ ["--c" as string]: "#ffb020" }}>send · {item.send?.connection}</span>}
        {item.kind === "spend" && <span className="chip shrink-0 text-[12px]" style={{ ["--c" as string]: "#ff2a4b" }}>spend</span>}
        {item.kind === "approval" && <span className="chip shrink-0 text-[12px]" style={{ ["--c" as string]: "#ffb020" }}>lead approved · undoable</span>}
        {item.waiting && <span className="chip shrink-0 text-[12px]" style={{ ["--c" as string]: "#a371f7" }}>waiting</span>}
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
        <div className={`whitespace-pre-wrap text-[13px] ${long && !expanded ? "line-clamp-6" : ""}`}>{item.details}</div>
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
      <div className="mt-2 flex items-center gap-2">
        <input
          className="field min-w-0 flex-1 text-[13px]"
          value={note}
          placeholder="Note for the agent (optional, no secrets)"
          aria-label={`Note for the agent: ${item.title}`}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && officeActions.resolveActionItem(item.id, "done", note)}
        />
        <button className="btn px-2 text-[12px]" onClick={() => officeActions.resolveActionItem(item.id, "done", note)}>
          {item.kind === "plan" || item.kind === "spec" || item.kind === "gate" || item.kind === "lesson" ? "Approve" : item.kind === "approval" ? "Keep" : "Done"}
        </button>
        <button className="btn px-2 text-[12px]" onClick={() => officeActions.resolveActionItem(item.id, "dismissed", note)}>
          {item.kind === "plan" || item.kind === "lesson" ? "Reject" : item.kind === "spec" || item.kind === "gate" ? "Send back" : item.kind === "approval" ? "Undo" : "Dismiss"}
        </button>
      </div>
      )}
    </li>
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

const TYPE_COLOR: Record<string, string> = { Decision: "#818cf8", Lesson: "#3fb950", DeadEnd: "#ff4d6d" };

/** New memories from one task: certify or reject each, or certify them all at once. */
function MemoryItem({ item, now }: { item: ActionItem; now: number }) {
  const list = item.memories ?? [];
  const decide = (decisions: Record<string, "certify" | "reject">) => officeActions.decideMemories(item.id, decisions);
  return (
    <li className="panel px-3 py-2">
      <div className="flex flex-wrap items-start gap-2">
        <b className="flex-1 text-[15px]">{item.title}</b>
        {!isViewer && list.length > 1 && (
          <button className="btn shrink-0 border-green px-2 text-[12px] text-green" onClick={() => decide(Object.fromEntries(list.map((m) => [m.id, "certify" as const])))}>
            Certify all {list.length}
          </button>
        )}
      </div>
      <div className="mb-1 text-[12px] text-muted">
        Team memory{item.taskId ? ` · ${item.taskId}` : ""} · {ago(item.at, now)} ago
      </div>
      <ul className="flex flex-col">
        {list.map((m) => (
          <li key={m.id} className="flex flex-col gap-1 border-t-2 border-dashed border-cream-3 py-2 first:border-t-0">
            <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
              <span className="chip chip-dot text-[12px]" style={{ ["--c" as string]: TYPE_COLOR[m.type] ?? "#a371f7" }}>
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
    </li>
  );
}
