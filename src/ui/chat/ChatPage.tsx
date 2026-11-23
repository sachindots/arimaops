// The desktop Chat page: channels on the left (the Team thread, then a direct thread per agent, lead first), the
// conversation on the right, oldest at the top, grouped by sender, with a composer that completes @mentions.
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { mentioned } from "../../data/mentions";
import { HUMAN_ID, type AgentMessage, type OfficeSnapshot } from "../../data/types";
import { BRAND } from "../../data/brand";
import { isViewer, officeActions, useOffice } from "../../store/office";
import { ui, useUi } from "../../store/ui";
import { modeOf } from "../../data/mode";
import { Icon } from "../deck/Icon";
import { VisualDecisionCard } from "../decisions/VisualDecisionCard";
import { ago, Portrait, useNow } from "../kit";
import { MessageText, shown, TagChip } from "./MessageBody";

export const TEAM = "@team";
const GROUP_MS = 5 * 60_000;

type Who = { id: string; name: string; color: string; role: string; lead: boolean };

function people(snap: OfficeSnapshot) {
  const map = new Map<string, Who>();
  for (const a of snap.config.team) map.set(a.id, { id: a.id, name: a.name, color: a.color, role: a.role, lead: a.isLead });
  map.set(HUMAN_ID, { id: HUMAN_ID, name: "You", color: "#16a34a", role: "Owner", lead: false });
  map.set("hq", { id: "hq", name: BRAND.name, color: "var(--accent)", role: "HQ", lead: false });
  return (id: string): Who => map.get(id) ?? { id, name: id, color: "#64748b", role: "", lead: false };
}

const dayLabel = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
};
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function ChatPage({ thread, onThread }: { thread: string; onThread: (id: string) => void }) {
  const snap = useOffice((s) => s.snap)!;
  const [showChannels, setShowChannels] = useState(false);
  return (
    <div className="flex min-h-0 flex-1">
      <Channels
        snap={snap}
        thread={thread}
        onThread={(id) => {
          onThread(id);
          setShowChannels(false);
        }}
        mobileOpen={showChannels}
      />
      <Conversation
        key={thread}
        snap={snap}
        thread={thread}
        mobileHidden={showChannels}
        onOpenChannels={() => setShowChannels(true)}
      />
    </div>
  );
}

function Channels({
  snap,
  thread,
  onThread,
  mobileOpen,
}: {
  snap: OfficeSnapshot;
  thread: string;
  onThread: (id: string) => void;
  mobileOpen: boolean;
}) {
  const now = useNow(15_000);
  const who = people(snap);
  const team = [...snap.config.team].sort((a, b) => Number(b.isLead) - Number(a.isLead));
  const row = (id: string, active: boolean, avatar: React.ReactNode, title: string, last: AgentMessage | undefined, extra?: React.ReactNode) => (
    <button
      key={id}
      type="button"
      onClick={() => onThread(id)}
      aria-current={active ? "true" : undefined}
      className={`flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${active ? "bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]" : "hover:bg-cream-2"}`}
    >
      {avatar}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={`truncate text-[13px] ${active ? "font-semibold text-ink" : "font-medium text-ink"}`}>{title}</span>
          {last && <span className="ml-auto shrink-0 text-[12px] text-muted">{ago(last.at, now)}</span>}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[12px] text-muted">{last ? `${who(last.fromId).name}: ${shown(last, last.fromId !== HUMAN_ID && last.fromId !== "hq").body}` : "No messages yet"}</span>
          {extra}
        </span>
      </span>
    </button>
  );
  return (
    <nav
      className={`${mobileOpen ? "flex w-full" : "hidden md:flex"} shrink-0 flex-col border-r border-[var(--border-hairline)] bg-cream-2/40 md:w-[260px] lg:w-[300px]`}
      aria-label="Chats"
    >
      <div className="px-4 pt-4 pb-2">
        <h1 className="m-0 text-[20px] font-semibold tracking-tight text-ink">Chat</h1>
        <p className="m-0 text-[12px] text-muted">Every message goes through HQ.</p>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <div className="px-2.5 pt-2 pb-1 text-[12px] font-medium text-muted">Channels</div>
        {row(
          TEAM,
          thread === TEAM,
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-cream-3 text-ink">
            <Icon name="groups" size={18} />
          </span>,
          "Team",
          snap.messages[0],
        )}
        <div className="px-2.5 pt-3 pb-1 text-[12px] font-medium text-muted">Direct</div>
        {team.map((a) => {
          const msgs = snap.messages.filter((m) => m.fromId === a.id || m.toId === a.id);
          const queued = msgs.filter((m) => m.toId === a.id && m.delivered === "queued").length;
          const st = snap.agents.find((s) => s.agentId === a.id);
          const mode = st ? modeOf(st) : "stopped";
          const dot = mode === "needs-input" ? "var(--color-amber)" : mode === "working" ? "var(--accent)" : mode === "alert" ? "var(--color-red)" : "var(--color-muted)";
          return row(
            a.id,
            thread === a.id,
            <span className="relative shrink-0">
              <Portrait name={a.name} color={a.color} lead={a.isLead} size={32} />
              <span className="absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--surface-card)]" style={{ background: dot }} title={mode} />
            </span>,
            `${a.name}${a.isLead ? " · Lead" : ""}`,
            msgs[0],
            queued > 0 ? <span className="shrink-0 rounded-full bg-amber/15 px-1.5 text-[12px] text-amber" title="Waiting until the agent is free">{queued} queued</span> : undefined,
          );
        })}
      </div>
    </nav>
  );
}

function Conversation({
  snap,
  thread,
  mobileHidden,
  onOpenChannels,
}: {
  snap: OfficeSnapshot;
  thread: string;
  mobileHidden: boolean;
  onOpenChannels: () => void;
}) {
  const who = people(snap);
  const agent = snap.config.team.find((a) => a.id === thread);
  const st = agent ? snap.agents.find((s) => s.agentId === agent.id) : undefined;
  const list = useMemo(
    () => [...(thread === TEAM ? snap.messages : snap.messages.filter((m) => m.fromId === thread || m.toId === thread))].reverse(),
    [snap.messages, thread],
  );
  const threadDecisions = useMemo(
    () =>
      (snap.visualDecisions ?? []).filter(
        (d) => d.status === "open" && (thread === TEAM || d.fromId === thread),
      ),
    [snap.visualDecisions, thread],
  );
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" }); // newer browsers return a Promise here: never hand it to React as cleanup
  }, [list.length]);

  return (
    <section
      className={`${mobileHidden ? "hidden md:flex" : "flex"} min-w-0 flex-1 flex-col`}
      aria-label={agent ? `Chat with ${agent.name}` : "Team chat"}
    >
      <header className="flex items-center gap-2.5 border-b border-[var(--border-hairline)] px-4 py-3 md:gap-3 md:px-6">
        <button
          type="button"
          onClick={onOpenChannels}
          aria-label="Show channels"
          className="btn px-2 py-1 text-[12px] md:hidden"
        >
          <Icon name="arrow_back" size={16} />
          <span>Chats</span>
        </button>
        {agent ? <Portrait name={agent.name} color={agent.color} lead={agent.isLead} size={32} /> : <Icon name="groups" size={22} className="text-muted" />}
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold text-ink">{agent ? agent.name : "Team"}</div>
          <div className="truncate text-[12px] text-muted">
            {agent ? `${agent.role}${st?.note ? ` · ${st.note}` : ""}` : `${snap.config.team.length} agents · every message, agent to agent too`}
          </div>
        </div>
        {agent && (
          <button type="button" className="btn text-[13px]" onClick={() => ui.openAgent(agent.id, "terminal")}>
            <Icon name="terminal" size={16} /> Terminal
          </button>
        )}
      </header>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6" aria-live="polite">
        {list.length === 0 && <p className="text-[13px] text-muted">{agent ? `No messages with ${agent.name} yet.` : "No messages yet. Ask the team something below."}</p>}
        {list.map((m, i) => {
          const prev = list[i - 1];
          const newDay = !prev || new Date(prev.at).toDateString() !== new Date(m.at).toDateString();
          const grouped = !newDay && prev.fromId === m.fromId && prev.toId === m.toId && Date.parse(m.at) - Date.parse(prev.at) < GROUP_MS;
          const from = who(m.fromId);
          const view = shown(m, m.fromId !== HUMAN_ID && m.fromId !== "hq");
          const toName = m.team ? "the team" : who(m.toId).name;
          return (
            <Fragment key={m.id}>
              {newDay && (
                <div className="my-3 flex items-center gap-3 text-[12px] font-medium text-muted" role="separator">
                  <span className="h-px flex-1 bg-[var(--border-hairline)]" />
                  {dayLabel(m.at)}
                  <span className="h-px flex-1 bg-[var(--border-hairline)]" />
                </div>
              )}
              <article className={`${Date.now() - Date.parse(m.at) < 4000 ? "msg-in " : ""}group flex gap-3 rounded-lg px-2 ${grouped ? "py-0.5" : "mt-2 py-1.5"} hover:bg-cream-2/50 ${view.tag === "disagree" ? "bg-amber/[0.05]" : ""}`}>
                <div className="w-9 shrink-0">
                  {grouped ? (
                    <span className="hidden pt-1 text-[12px] text-muted group-hover:block">{clock(m.at)}</span>
                  ) : m.fromId === HUMAN_ID || m.fromId === "hq" ? (
                    <span className="grid h-9 w-9 place-items-center rounded-lg text-[13px] font-semibold text-white" style={{ background: from.color }} aria-hidden>
                      {m.fromId === "hq" ? <Icon name="hub" size={18} /> : "Y"}
                    </span>
                  ) : (
                    <Portrait name={from.name} color={from.color} lead={from.lead} size={36} />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  {!grouped && (
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-[13px] font-semibold text-ink">{from.name}</span>
                      {from.role && <span className="text-[12px] text-muted">{from.role}</span>}
                      {(thread === TEAM || m.fromId !== thread) && m.toId !== thread && <span className="text-[12px] text-muted">→ {toName}</span>}
                      <span className="text-[12px] text-muted">{clock(m.at)}</span>
                    </div>
                  )}
                  <div className="flex items-start gap-2">
                    {(view.tag || m.taskId) && (
                      <span className="mt-0.5 flex shrink-0 items-center gap-1.5">
                        {view.tag && <TagChip tag={view.tag} />}
                        {m.taskId && (
                          <button type="button" className="rounded-lg px-1 text-[12px] font-medium text-accent hover:underline" onClick={() => ui.openTask(m.taskId!)}>
                            {m.taskId}
                          </button>
                        )}
                      </span>
                    )}
                    <MessageText body={view.body} className="min-w-0 flex-1 text-[13px] leading-6 text-ink" />
                  </div>
                  {m.toId === thread && m.delivered === "queued" && <span className="text-[12px] text-amber">Waiting until {who(m.toId).name} is free</span>}
                </div>
              </article>
            </Fragment>
          );
        })}
        {threadDecisions.length > 0 && (
          <div className="mt-4 flex flex-col gap-3">
            {threadDecisions.map((dec) => (
              <VisualDecisionCard key={dec.id} decision={dec} compact />
            ))}
          </div>
        )}
        <div ref={end} />
      </div>

      {!isViewer && <Composer snap={snap} thread={thread} />}
    </section>
  );
}

/** Enter sends, Shift+Enter is a new line, "@" offers the team (↑ ↓ to pick, Enter or Tab to take). */
function Composer({ snap, thread }: { snap: OfficeSnapshot; thread: string }) {
  const draft = useUi((s) => s.chatDrafts[thread] ?? "");
  const setDraft = (next: string) => ui.setChatDraft(thread, next);
  const [pick, setPick] = useState(0);
  const box = useRef<HTMLTextAreaElement>(null);
  const team = snap.config.team;
  const lead = team.find((a) => a.isLead);
  const agent = team.find((a) => a.id === thread);
  const at = draft.match(/(?:^|\s)@([\w-]*)$/);
  const options = at ? team.filter((a) => a.name.toLowerCase().startsWith(at[1].toLowerCase()) || a.id.startsWith(at[1].toLowerCase())).slice(0, 6) : [];
  const to = agent ? [agent.id] : mentioned(team, draft);

  const take = (name: string) => {
    setDraft(draft.replace(/@([\w-]*)$/, `@${name} `));
    setPick(0);
    box.current?.focus();
  };
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    if (agent) officeActions.sendMessage(agent.id, text);
    else if (to.length) for (const id of to) officeActions.sendMessage(id, text);
    else officeActions.askTeam(text);
    setDraft("");
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (options.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setPick((p) => (p + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        take(options[Math.min(pick, options.length - 1)].name);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };
  const hint = agent
    ? `To ${agent.name}. Delivered now if idle, otherwise when the current turn ends.`
    : to.length
      ? `Goes straight to ${to.map((id) => team.find((a) => a.id === id)?.name).join(", ")}.`
      : lead
        ? `${lead.name} asks whoever knows, then answers you once. @Name writes to someone directly.`
        : "This team has no lead: @Name an agent to write to them.";

  return (
    <div className="relative border-t border-[var(--border-hairline)] px-3.5 py-3 md:px-6">
      {options.length > 0 && (
        <ul className="absolute bottom-full left-6 m-0 mb-1 w-64 list-none overflow-hidden rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-card)] p-1 shadow-[var(--card-shadow-hover)]" role="listbox" aria-label="Mention">
          {options.map((a, i) => (
            <li key={a.id} role="option" aria-selected={i === pick}>
              <button
                type="button"
                onMouseDown={(e) => (e.preventDefault(), take(a.name))}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] ${i === pick ? "bg-cream-2" : ""}`}
              >
                <Portrait name={a.name} color={a.color} lead={a.isLead} size={22} />
                <span className="font-medium text-ink">{a.name}</span>
                <span className="truncate text-[12px] text-muted">{a.role}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2 rounded-xl border border-[var(--border-strong)] bg-[var(--surface-card)] px-3 py-2 focus-within:border-[var(--accent)]">
        <textarea
          ref={box}
          rows={1}
          value={draft}
          onChange={(e) => (setDraft(e.target.value), setPick(0))}
          onKeyDown={onKey}
          placeholder={agent ? `Message ${agent.name}` : "Ask the team, or @Name someone"}
          aria-label={agent ? `Message ${agent.name}` : "Ask the team, or mention an agent with @"}
          className="max-h-40 min-h-[24px] flex-1 resize-none bg-transparent text-[13px] leading-6 text-ink outline-none placeholder:text-muted"
          style={{ height: `${Math.min(160, 24 * Math.max(1, draft.split("\n").length))}px` }}
        />
        <button type="submit" className="btn btn-primary text-[13px]" disabled={!draft.trim() || (!agent && !lead && !to.length)} onClick={send}>
          {agent ? "Send" : to.length ? `Send to ${to.length}` : "Ask"}
        </button>
      </div>
      <p className="m-0 mt-1.5 text-[12px] text-muted">{hint}</p>
    </div>
  );
}
