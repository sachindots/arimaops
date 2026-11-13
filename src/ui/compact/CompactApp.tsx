import { BRAND } from "../../data/brand";
// Tablet/phone layout: a header, a bottom bar (Chat · Board · Inbox · Agents · More) and full-screen
// pages. Opening anything else (an agent, PRs, your terminal, projects) uses the same drawers as the
// office, shown full-screen with a Back button.
import { useEffect, useState, type ReactNode } from "react";
import { CLI_LABEL, HUMAN_ID, type AgentConfig } from "../../data/types";
import { isViewer, officeActions, selectAttention, useOffice } from "../../store/office";
import { ui, useUi } from "../../store/ui";
import { signOut, useAuth } from "../../store/auth";
import { ago, Dot, Logo, Portrait, StateChip, useNow } from "../kit";
import { Home } from "./Home";
import { ActionItemsDrawer } from "../drawers/ActionItemsDrawer";
import { AgentDrawer, MessagesTab } from "../drawers/AgentDrawer";
import { BoardsDrawer } from "../drawers/BoardsDrawer";
import { CtoDrawer } from "../drawers/CtoDrawer";
import { CommandView } from "../command/CommandView";
import { EnvironmentDrawer } from "../drawers/EnvironmentDrawer";
import { PrDrawer } from "../drawers/PrDrawer";
import { TerminalDrawer } from "../drawers/TerminalDrawer";
import { FindingsDrawer } from "../drawers/FindingsDrawer";

type Tab = "home" | "board" | "inbox" | "agents" | "chat" | "more";

/** Wide screens (a landscape tablet, a laptop) get a sidebar; narrower ones a bottom bar. */
const WIDE = "(min-width: 1000px)";
function useWide(): boolean {
  const [on, setOn] = useState(() => window.matchMedia(WIDE).matches);
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const onChange = () => setOn(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return on;
}

const NAV: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: "home", label: "Home", icon: <path d="M3 10.5 12 4l9 6.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" /> },
  { id: "board", label: "Board", icon: <path d="M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z" /> },
  { id: "inbox", label: "Inbox", icon: <path d="M3 13l3-8h12l3 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zm0 0h5l1 3h6l1-3h5" /> },
  { id: "agents", label: "Agents", icon: <path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 10a7 7 0 0 1 14 0M17 3.5a4 4 0 0 1 0 7.5M22 21a7 7 0 0 0-4-6.3" /> },
  { id: "chat", label: "Chat", icon: <path d="M4 5h16v11H9l-5 4z" /> },
  { id: "more", label: "More", icon: <path d="M5 12h.01M12 12h.01M19 12h.01" /> },
];

function NavIcon({ children }: { children: ReactNode }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

export function CompactApp() {
  const view = useUi((st) => st.view);
  const snap = useOffice((s) => s.snap);
  const drawer = useUi((s) => s.drawer);
  const [tab, setTab] = useState<Tab>("home");
  const [thread, setThread] = useState<string | null>(null);
  const wide = useWide();
  if (!snap) return null;
  const current = tab;
  const attention = selectAttention(snap).total;
  const setupIssues = snap.setup.checks.filter((c) => c.status !== "ok").length;
  const go = (id: Tab) => {
    ui.closeDrawer();
    setTab(id);
  };

  // A drawer (agent, PRs, terminal…) is a full page over the current tab.
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

  // The command center is a full-screen page; an agent opened from it is a page over it (Back returns).
  if (view === "command" && !page) return <CommandView />;

  const navButton = (n: (typeof NAV)[number]) => {
    const on = current === n.id && !page;
    const label = n.id === "inbox" && attention ? `Inbox` : n.label;
    return (
      <button
        key={n.id}
        className={`relative flex items-center gap-3 rounded-md transition-colors ${wide ? "w-full px-3 py-2 text-[14px]" : "flex-col justify-center gap-0.5 py-1 text-[11px]"} ${on ? "bg-[rgba(99,102,241,0.14)] text-[#c7d2fe]" : "text-muted hover:bg-white/[0.04] hover:text-ink"}`}
        aria-current={on ? "page" : undefined}
        onClick={() => go(n.id)}
      >
        <NavIcon>{n.icon}</NavIcon>
        <span>{label}</span>
        {n.id === "inbox" && attention > 0 && (
          <span className={`rounded-full bg-[#d29922] px-1.5 font-term text-[11px] font-semibold text-[#0f1115] ${wide ? "ml-auto" : "absolute right-[calc(50%-22px)] top-0"}`}>{attention}</span>
        )}
      </button>
    );
  };

  const main = page ? (
    <div className="flex min-h-0 flex-1 flex-col">{page}</div>
  ) : current === "home" ? (
    <Home onOpen={(t) => go(t)} />
  ) : current === "chat" ? (
    thread ? <Thread agentId={thread} onBack={() => setThread(null)} /> : <ChatList onOpen={setThread} />
  ) : current === "board" ? (
    <div className="flex min-h-0 flex-1 flex-col">
      <BoardsDrawer />
    </div>
  ) : current === "inbox" ? (
    <div className="flex min-h-0 flex-1 flex-col">
      <ActionItemsDrawer />
    </div>
  ) : current === "agents" ? (
    <AgentList />
  ) : (
    <More />
  );

  return (
    <div className="fixed inset-0 flex bg-grass text-ink" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
      {wide && (
        <aside className="flex w-[216px] shrink-0 flex-col gap-1 border-r border-ink bg-[#0b0c0f] px-3 py-3" aria-label="Sections">
          <div className="mb-3 flex items-center gap-2 px-1">
            <Logo size={26} />
            <b className="text-[15px] font-semibold">{BRAND.name}</b>
          </div>
          <button className="mb-3 flex items-center gap-2 rounded-md border border-ink px-2.5 py-2 text-left text-[13px] hover:bg-white/[0.04]" onClick={() => ui.openCto()} title="Switch project">
            <span className="min-w-0 flex-1 truncate font-medium">{snap.config.project.name}</span>
            <span className="text-muted">▾</span>
          </button>
          {NAV.map(navButton)}
          <span className="flex-1" />
          {setupIssues > 0 && (
            <button className="flex items-center gap-2 rounded-md px-3 py-2 text-[13px] text-[#d29922] hover:bg-white/[0.04]" onClick={() => ui.openSetup()}>
              Setup · {setupIssues} to do
            </button>
          )}
          {isViewer && <span className="chip self-start text-[11px]">Viewer</span>}
        </aside>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!wide && (
          <header className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-ink bg-[#0b0c0f] px-4">
            <Logo size={24} />
            <button className="min-h-[40px] min-w-0 flex-1 truncate text-left text-[15px]" onClick={() => ui.openCto()} title="Switch project">
              <span className="font-semibold">{snap.config.project.name}</span> <span className="text-muted">▾</span>
            </button>
            {isViewer && <span className="chip text-[11px]">Viewer</span>}
            {setupIssues > 0 && (
              <button className="btn px-2 text-[12px]" onClick={() => ui.openSetup()}>
                Setup · {setupIssues}
              </button>
            )}
          </header>
        )}
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">{main}</main>
        {!wide && (
          <nav className="grid h-[60px] shrink-0 grid-cols-6 gap-1 border-t border-ink bg-[#0b0c0f] px-1" aria-label="Sections">
            {NAV.map(navButton)}
          </nav>
        )}
      </div>
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
              <Portrait name={a.name} color={a.color} lead={a.isLead} size={36} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <b className="text-[16px]">{a.name}</b>
                  <span className="truncate text-[12px] text-muted">
                    {a.isLead && !/lead/i.test(a.role) ? "Lead · " : ""}
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
      <div className="flex items-center gap-2 border-b border-ink px-3 py-2">
        <button className="btn px-2.5" aria-label="Back to chats" onClick={onBack}>
          ‹
        </button>
        <Portrait name={agent.name} color={agent.color} lead={agent.isLead} size={28} />
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
        <div className="border-b border-ink p-3">
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
  const [native, setNative] = useState(() => !!window.ArimaNative);
  useEffect(() => {
    const ready = () => setNative(!!window.ArimaNative);
    window.addEventListener("arima-native-ready", ready);
    ready();
    return () => window.removeEventListener("arima-native-ready", ready);
  }, []);
  const auth = useAuth((s) => s.status);
  const security = useOffice((s) => !!s.snap?.config.rules.findings);
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
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
      <ul>
        {item(`Findings${open ? ` · ${open}` : ""}`, "What agents found on in-scope targets; triage and the report", () => ui.openFindings(), security)}
        {item("Command center", "Every agent of every project, needs-you first", () => ui.setView("command", false))}
        {item("Projects", "Switch, create, pause, archive or delete projects", () => ui.openCto())}
        {item("Pull requests", "Reviews and what's ready to merge", () => ui.openPrs())}
        {item("Your terminal", "A shell on the server: the repo, an agent's folder or any folder", () => ui.openTerminal(), !isViewer)}
        {item("Setup checklist", "What's missing on the server", () => ui.openSetup())}
        {item("Settings", "Team, workflow, sandbox, project", () => ui.openSettings("team"), !isViewer)}
        {item("Sign out", "Sign this device out of HQ", () => void signOut(), auth === "signed-in")}
        {item("Switch server", "Connect this app to another HQ", () => window.ArimaNative?.switchServer(), native)}
      </ul>
    </div>
  );
}
