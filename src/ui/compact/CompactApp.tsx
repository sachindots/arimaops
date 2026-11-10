import { BRAND } from "../../data/brand";
import { Logo } from "../hud/TopBar";
// Tablet/phone layout: a header, a bottom bar (Chat · Board · Inbox · Agents · More) and full-screen
// pages. Opening anything else (an agent, PRs, your terminal, projects) uses the same drawers as the
// office, shown full-screen with a Back button.
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { CLI_LABEL, HUMAN_ID, type AgentConfig } from "../../data/types";
import { isViewer, officeActions, selectAttention, useOffice } from "../../store/office";
import { ui, useUi, type LayoutChoice } from "../../store/ui";
import { signOut, useAuth } from "../../store/auth";
import { ago, Dot, Portrait, StateChip, useNow } from "../kit";
import { ActionItemsDrawer } from "../drawers/ActionItemsDrawer";
import { AgentDrawer, MessagesTab } from "../drawers/AgentDrawer";
import { BoardsDrawer } from "../drawers/BoardsDrawer";
import { CtoDrawer } from "../drawers/CtoDrawer";
import { EnvironmentDrawer } from "../drawers/EnvironmentDrawer";
import { PrDrawer } from "../drawers/PrDrawer";
import { TerminalDrawer } from "../drawers/TerminalDrawer";
import { FindingsDrawer } from "../drawers/FindingsDrawer";

type Tab = "chat" | "board" | "office" | "inbox" | "agents" | "more";

// Loaded only when shown: Pixi and the office art stay out of the phone's first load.
const CompactOffice = lazy(() => import("../../office/iso/CompactOffice"));

/** Tablet width: the office sits beside the current page instead of being a tab. */
const SIDE_BY_SIDE = "(min-width: 900px)";
function useSideBySide(): boolean {
  const [on, setOn] = useState(() => window.matchMedia(SIDE_BY_SIDE).matches);
  useEffect(() => {
    const mq = window.matchMedia(SIDE_BY_SIDE);
    const onChange = () => setOn(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return on;
}

function OfficePane() {
  return (
    <div className="relative min-h-0 flex-1 bg-[#070910]">
      <Suspense fallback={<div className="p-4 text-[13px] text-muted">Loading the office…</div>}>
        <CompactOffice />
      </Suspense>
    </div>
  );
}

export function CompactApp() {
  const snap = useOffice((s) => s.snap);
  const drawer = useUi((s) => s.drawer);
  const [tab, setTab] = useState<Tab>("chat");
  const [thread, setThread] = useState<string | null>(null);
  const side = useSideBySide();
  if (!snap) return null;
  const current = side && tab === "office" ? "chat" : tab;
  const attention = selectAttention(snap).total;
  const setupIssues = snap.setup.checks.filter((c) => c.status !== "ok").length;

  // A drawer (agent, PRs, terminal…) is a full-screen page over the current tab.
  const page =
    drawer?.kind === "agent" ? <AgentDrawer id={drawer.id} initialTab={drawer.tab} />
    : drawer?.kind === "prs" ? <PrDrawer />
    : drawer?.kind === "env" ? <EnvironmentDrawer name={drawer.name} />
    : drawer?.kind === "terminal" ? <TerminalDrawer />
    : drawer?.kind === "cto" ? <CtoDrawer />
    : drawer?.kind === "actions" ? <ActionItemsDrawer />
    : drawer?.kind === "boards" ? <BoardsDrawer initialBoardId={drawer.boardId} />
    : drawer?.kind === "findings" ? <FindingsDrawer />
    : null;

  return (
    <div className="fixed inset-0 flex flex-col bg-grass text-ink" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
      <header className="flex h-[48px] shrink-0 items-center gap-2 border-b-[3px] border-ink bg-[rgba(17,26,44,0.96)] px-3">
        <Logo size={28} />
        <b className="text-[20px] font-bold text-gold">{BRAND.name}</b>
        <button className="min-w-0 flex-1 truncate text-left text-[15px]" onClick={() => ui.openCto()} title="Switch project">
          <span className="font-semibold">{snap.config.project.name}</span> <span className="text-muted">▾</span>
        </button>
        {isViewer && <span className="chip text-[11px]">Viewer</span>}
        {setupIssues > 0 && (
          <button className="btn px-2 text-[13px]" onClick={() => ui.openSetup()}>
            Setup · {setupIssues}
          </button>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
      <main className={`relative flex min-h-0 min-w-0 flex-col ${side ? "w-[420px] shrink-0 border-r-[3px] border-ink" : "flex-1"}`}>
        {page ? (
          <div className="panel flex min-h-0 flex-1 flex-col !border-0">{page}</div>
        ) : current === "office" ? (
          <OfficePane />
        ) : current === "chat" ? (
          thread ? (
            <Thread agentId={thread} onBack={() => setThread(null)} />
          ) : (
            <ChatList onOpen={setThread} />
          )
        ) : current === "board" ? (
          <div className="panel flex min-h-0 flex-1 flex-col !border-0">
            <BoardsDrawer />
          </div>
        ) : current === "inbox" ? (
          <div className="panel flex min-h-0 flex-1 flex-col !border-0">
            <ActionItemsDrawer />
          </div>
        ) : current === "agents" ? (
          <AgentList />
        ) : (
          <More />
        )}
      </main>
      {side && <OfficePane />}
      </div>

      <nav className={`grid h-[58px] shrink-0 ${side ? "grid-cols-5" : "grid-cols-6"} border-t-[3px] border-ink bg-[rgba(17,26,44,0.96)]`} aria-label="Sections">
        {(
          [
            ["chat", "Chat", "💬"],
            ["board", "Board", "▦"],
            ...(side ? [] : [["office", "Office", "▙"] as [Tab, string, string]]),
            ["inbox", attention ? `Inbox · ${attention}` : "Inbox", "!"],
            ["agents", "Agents", "◉"],
            ["more", "More", "⋯"],
          ] as [Tab, string, string][]
        ).map(([id, label, icon]) => (
          <button
            key={id}
            className={`flex flex-col items-center justify-center gap-0.5 text-[12px] ${current === id && !page ? "text-green" : "text-muted"} ${id === "inbox" && attention ? "!text-red" : ""}`}
            aria-current={current === id && !page ? "page" : undefined}
            onClick={() => {
              ui.closeDrawer();
              setTab(id);
            }}
          >
            <span className="text-[18px] leading-none" aria-hidden="true">
              {icon}
            </span>
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}

/** Lead first, then the team; each row shows the last message and anything still queued. */
function ChatList({ onOpen }: { onOpen: (agentId: string) => void }) {
  const snap = useOffice((s) => s.snap)!;
  const now = useNow(10_000);
  const team = [...snap.config.team].sort((a, b) => Number(b.isLead) - Number(a.isLead));
  return (
    <ul className="scroll-thin min-h-0 flex-1 overflow-y-auto">
      {team.map((a) => {
        const msgs = snap.messages.filter((m) => m.fromId === a.id || m.toId === a.id);
        const last = msgs[0];
        const queued = msgs.filter((m) => m.toId === a.id && m.delivered === "queued").length;
        const st = snap.agents.find((s) => s.agentId === a.id);
        return (
          <li key={a.id}>
            <button className="flex w-full items-center gap-3 border-b border-ink px-3 py-3 text-left" onClick={() => onOpen(a.id)}>
              <Portrait color={a.color} lead={a.isLead} size={36} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <b className="text-[16px]">{a.name}</b>
                  <span className="truncate text-[12px] text-muted">
                    {a.isLead ? "Lead · " : ""}
                    {a.role}
                  </span>
                  {last && <span className="ml-auto shrink-0 font-term text-[14px] text-muted">{ago(last.at, now)}</span>}
                </div>
                <div className="flex items-center gap-2 text-[13px] text-muted">
                  {st && <StateChip state={st.state} session={st.session.state} blink={false} />}
                  <span className="truncate">{last ? `${last.fromId === HUMAN_ID ? "You: " : ""}${last.text}` : "No messages yet"}</span>
                  {queued > 0 && <span className="shrink-0 font-mono text-[11px] text-orange">◷ {queued}</span>}
                </div>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Thread({ agentId, onBack }: { agentId: string; onBack: () => void }) {
  const snap = useOffice((s) => s.snap)!;
  const agent = snap.config.team.find((a) => a.id === agentId);
  if (!agent) return null;
  const st = snap.agents.find((s) => s.agentId === agentId);
  return (
    <div className="panel flex min-h-0 flex-1 flex-col !border-0">
      <div className="flex items-center gap-2 border-b-[3px] border-ink px-3 py-2">
        <button className="btn px-2.5" aria-label="Back to chats" onClick={onBack}>
          ‹
        </button>
        <Portrait color={agent.color} lead={agent.isLead} size={28} />
        <b className="text-[16px]">{agent.name}</b>
        {st && <StateChip state={st.state} session={st.session.state} />}
        <button className="btn ml-auto px-2 text-[13px]" onClick={() => ui.openAgent(agentId, "terminal")}>
          Terminal
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <MessagesTab snap={snap} agent={agent} />
      </div>
    </div>
  );
}

function AgentList() {
  const snap = useOffice((s) => s.snap)!;
  const now = useNow(10_000);
  const row = (a: AgentConfig) => {
    const st = snap.agents.find((s) => s.agentId === a.id);
    const running = st?.session.state === "running";
    const limited = st?.limitedUntil && Date.parse(st.limitedUntil) > now ? new Date(st.limitedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
    return (
      <li key={a.id} className="flex items-center gap-3 border-b border-ink px-3 py-2.5">
        <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => ui.openAgent(a.id)}>
          <Dot color={a.color} size={10} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <b>{a.name}</b>
              {st && <StateChip state={st.state} session={st.session.state} blink={false} />}
            </div>
            <div className="truncate text-[12px] text-muted">
              {CLI_LABEL[a.cli]} · {a.model || "default"} · {a.mode}
              {limited ? ` · limit until ${limited}` : ""}
              {st?.currentTaskId ? ` · ${st.currentTaskId}` : ""}
            </div>
          </div>
        </button>
        {!isViewer && (
          <button className="btn shrink-0 px-2.5 text-[13px]" onClick={() => (running ? officeActions.stopAgent(a.id) : officeActions.startAgent(a.id))}>
            {running ? "Stop" : st?.session.state === "starting" ? "…" : "Start"}
          </button>
        )}
      </li>
    );
  };
  const stopped = snap.agents.filter((s) => s.session.state === "stopped" || s.session.state === "failed");
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
      {!isViewer && stopped.length > 0 && (
        <div className="border-b-[3px] border-ink p-3">
          <button className="btn w-full text-[14px]" onClick={() => stopped.forEach((s) => officeActions.startAgent(s.agentId))}>
            Start team ({stopped.length} stopped)
          </button>
        </div>
      )}
      <ul>{snap.config.team.map(row)}</ul>
    </div>
  );
}

function More() {
  const choice = useUi((s) => s.layoutChoice);
  const auth = useAuth((s) => s.status);
  const security = useOffice((s) => s.snap?.config.project.type === "security");
  const open = useOffice((s) => (s.snap?.findings ?? []).filter((f) => f.status === "open" || f.status === "confirmed").length);
  const item = (label: string, sub: string, onClick: () => void, show = true): ReactNode =>
    show && (
      <li key={label}>
        <button className="flex w-full flex-col border-b border-ink px-4 py-3 text-left" onClick={onClick}>
          <b className="text-[15px]">{label}</b>
          <span className="text-[12px] text-muted">{sub}</span>
        </button>
      </li>
    );
  const layouts: [LayoutChoice, string][] = [
    ["auto", "Auto"],
    ["compact", "This layout"],
    ["office", "Office"],
  ];
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
      <ul>
        {item(`Findings${open ? ` · ${open}` : ""}`, "What agents found on in-scope targets; triage and the report", () => ui.openFindings(), security)}
        {item("Projects", "Switch project, pause or resume, add tasks anywhere", () => ui.openCto())}
        {item("Pull requests", "Reviews and what's ready to merge", () => ui.openPrs())}
        {item("Your terminal", "A shell on the server: the repo, an agent's folder or any folder", () => ui.openTerminal(), !isViewer)}
        {item("Setup checklist", "What's missing on the server", () => ui.openSetup())}
        {item("Settings", "Team, workflow, sandbox, project", () => ui.openSettings("team"), !isViewer)}
        {item("Sign out", "Sign this device out of HQ", () => void signOut(), auth === "signed-in")}
      </ul>
      <div className="px-4 py-3">
        <div className="mb-1.5 text-[13px] text-muted">Layout on this device</div>
        <div className="flex gap-2">
          {layouts.map(([id, label]) => (
            <button key={id} className="btn flex-1 text-[13px]" aria-pressed={choice === id} onClick={() => ui.setLayout(id)}>
              {label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[12px] text-muted">Auto uses this layout below 1280 px wide and the full office above. Here the office is the Office tab, or beside the page on a tablet.</p>
      </div>
    </div>
  );
}
