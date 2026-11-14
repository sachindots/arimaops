// Tablet/phone layout: a header, a bottom bar (Chat · Board · Inbox · Agents · More) and full-screen
// pages. Opening anything else (an agent, PRs, your terminal, projects) uses the same drawers as the
// office, shown full-screen with a Back button.
import { useEffect, useState, type ReactNode } from "react";
import { CLI_LABEL, HUMAN_ID } from "../../data/types";
import { isViewer, officeActions, selectAttention, selectTeam, useOffice } from "../../store/office";
import { modeOf, type Mode } from "../../data/mode";
import { AgentOrbit } from "../hud/AgentOrbit";
import { ParticleCore } from "../hud/ParticleCore";
import { projectMode } from "../hud/theme";
import { ui, useUi } from "../../store/ui";
import { signOut, useAuth } from "../../store/auth";
import { ago, fmtTokens, fmtUsd, Logo, Meter, Portrait, Sparkline, StateChip, useNow } from "../kit";
import { useAgentUsage } from "../../store/usage";
import { ActionItemsDrawer } from "../drawers/ActionItemsDrawer";
import { AgentDrawer, MessagesTab } from "../drawers/AgentDrawer";
import { BoardsDrawer } from "../drawers/BoardsDrawer";
import { CtoDrawer } from "../drawers/CtoDrawer";
import { CommandView } from "../command/CommandView";
import { EnvironmentDrawer } from "../drawers/EnvironmentDrawer";
import { PrDrawer } from "../drawers/PrDrawer";
import { TerminalDrawer } from "../drawers/TerminalDrawer";
import { FindingsDrawer } from "../drawers/FindingsDrawer";
import { FlowDrawer } from "../drawers/FlowDrawer";
import { StageStrip } from "../hud/StageStrip";

export type Tab = "home" | "board" | "inbox" | "agents" | "chat" | "more";

const MODE_COLOR: Record<Mode, string> = { working: "#00f0ff", cheer: "#3fb950", "needs-input": "#ffb020", alert: "#ff2a4b", starting: "#818cf8", idle: "#8b9bb4", stopped: "#475569" };

export const NAV: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: "home", label: "Home", icon: <path d="M3 10.5 12 4l9 6.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" /> },
  { id: "board", label: "Board", icon: <path d="M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z" /> },
  { id: "inbox", label: "Inbox", icon: <path d="M3 13l3-8h12l3 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zm0 0h5l1 3h6l1-3h5" /> },
  { id: "agents", label: "Agents", icon: <path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 10a7 7 0 0 1 14 0M17 3.5a4 4 0 0 1 0 7.5M22 21a7 7 0 0 0-4-6.3" /> },
  { id: "chat", label: "Chat", icon: <path d="M4 5h16v11H9l-5 4z" /> },
  { id: "more", label: "More", icon: <path d="M5 12h.01M12 12h.01M19 12h.01" /> },
];

export function NavIcon({ children }: { children: ReactNode }) {
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
    : drawer?.kind === "flow" ? <FlowDrawer />
    : null;

  // The command center is a full-screen page; an agent opened from it is a page over it (Back returns).
  if (view === "command" && !page) return <CommandView />;

  const navButton = (n: (typeof NAV)[number]) => {
    const on = current === n.id && !page;
    const label = n.id === "inbox" && attention ? `Inbox` : n.label;
    return (
      <button
        key={n.id}
        className={`relative flex items-center gap-3 rounded-md transition-colors flex-col justify-center gap-0.5 py-1 text-[11px] ${on ? "bg-accent/12 text-accent" : "text-muted hover:bg-white/[0.04] hover:text-ink"}`}
        aria-current={on ? "page" : undefined}
        onClick={() => go(n.id)}
      >
        <NavIcon>{n.icon}</NavIcon>
        <span>{label}</span>
        {n.id === "inbox" && attention > 0 && (
          <span className={`rounded-full bg-[#ffb020] px-1.5 font-term text-[11px] font-semibold text-navy absolute right-[calc(50%-22px)] top-0`}>{attention}</span>
        )}
      </button>
    );
  };

  const main = page ? (
    <div className="flex min-h-0 flex-1 flex-col">{page}</div>
  ) : current === "home" ? (
    <HudHome />
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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-white/[0.08] bg-navy-2 px-4">
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
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">{main}</main>
        <nav className="grid h-[60px] shrink-0 grid-cols-6 gap-1 border-t border-white/[0.08] bg-navy-2 px-1" aria-label="Sections">
          {NAV.map(navButton)}
        </nav>
      </div>
    </div>
  );
}

/** Lead first, then the team; each row shows the last message and anything still queued. */
export function ChatList({ onOpen, selected }: { onOpen: (agentId: string) => void; selected?: string | null }) {
  const snap = useOffice((s) => s.snap)!;
  const now = useNow(10_000);
  const team = [...snap.config.team].sort((a, b) => Number(b.isLead) - Number(a.isLead));
  return (
    <ul className="scroll-thin m-0 flex min-h-0 flex-1 list-none flex-col gap-1.5 overflow-y-auto p-2">
      {team.map((a) => {
        const msgs = snap.messages.filter((m) => m.fromId === a.id || m.toId === a.id);
        const last = msgs[0];
        const queued = msgs.filter((m) => m.toId === a.id && m.delivered === "queued").length;
        const st = snap.agents.find((s) => s.agentId === a.id);
        return (
          <li key={a.id}>
            <button className={`hud-scan flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${selected === a.id ? "hud-corners border-accent/50 bg-accent/[0.08]" : "border-white/[0.06] hover:border-white/20 hover:bg-white/[0.03]"}`} aria-current={selected === a.id ? "true" : undefined} onClick={() => onOpen(a.id)}>
              <Portrait name={a.name} color={a.color} lead={a.isLead} size={36} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <b className="font-display text-[15px] font-semibold">{a.name}</b>
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

/** `onBack` only where the thread replaces the list (phones); beside the list there is nothing to go back to. */
export function Thread({ agentId, onBack }: { agentId: string; onBack?: () => void }) {
  const snap = useOffice((s) => s.snap)!;
  const agent = snap.config.team.find((a) => a.id === agentId);
  if (!agent) return null;
  const st = snap.agents.find((s) => s.agentId === agentId);
  return (
    <div className="panel flex min-h-0 flex-1 flex-col !border-0">
      <div className="flex items-center gap-2.5 border-b border-white/[0.08] px-4 py-2.5">
        {onBack && (
          <button className="btn px-2.5" aria-label="Back to chats" onClick={onBack}>
            ‹
          </button>
        )}
        <Portrait name={agent.name} color={agent.color} lead={agent.isLead} size={28} />
        <b className="font-display text-[17px] font-semibold">{agent.name}</b>
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

/** The team as cards: who, what it runs on, what it's doing, today's tokens, and start/stop. */
export function AgentList() {
  const snap = useOffice((s) => s.snap)!;
  const now = useNow(10_000);
  const usage = useAgentUsage(1);
  const stopped = snap.agents.filter((s) => s.session.state === "stopped" || s.session.state === "failed");
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4">
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="m-0 font-display text-[22px] font-semibold">Agents</h1>
          <span className="text-[13px] text-muted">
            {snap.config.team.length} in {snap.config.project.name}
          </span>
          <span className="flex-1" />
          {!isViewer && stopped.length > 0 && (
            <button className="btn btn-primary px-3 text-[13px]" onClick={() => stopped.forEach((s) => officeActions.startAgent(s.agentId))}>
              Start team · {stopped.length}
            </button>
          )}
        </header>
        <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-3 p-0">
          {snap.config.team.map((a) => {
            const st = snap.agents.find((s) => s.agentId === a.id);
            const mode = modeOf(st, now);
            const color = MODE_COLOR[mode];
            const running = st?.session.state === "running";
            const limited = st?.limitedUntil && Date.parse(st.limitedUntil) > now ? new Date(st.limitedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
            const use = usage.byId.get(a.id);
            const tokens = use ? usage.total(use) : 0;
            const task = st?.currentTaskId ? snap.tasks.find((t) => t.id === st.currentTaskId) : undefined;
            return (
              <li key={a.id} className="hud-glass hud-corners hud-scan flex flex-col gap-3 rounded-2xl p-3.5" style={{ ["--corner" as string]: color }}>
                <button className="flex min-w-0 items-center gap-3 text-left" onClick={() => ui.openAgent(a.id)} title={`Open ${a.name}`}>
                  <span className="relative shrink-0">
                    <Portrait name={a.name} color={a.color} lead={a.isLead} size={42} />
                    <i className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-navy ${mode === "working" || mode === "needs-input" ? "animate-pulse" : ""}`} style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <b className="truncate font-display text-[17px] font-semibold">{a.name}</b>
                      {st && <StateChip state={st.state} session={st.session.state} blink={false} />}
                    </span>
                    <span className="block truncate text-[12px] text-muted">
                      {a.role} · {CLI_LABEL[a.cli]} · {a.model || "default model"} · {a.mode === "sandbox" ? "sandbox" : a.mode === "container" ? "container" : "local"}
                    </span>
                  </span>
                </button>
                <p className="m-0 truncate text-[12px]" title={task?.title ?? st?.note ?? undefined}>
                  {task ? (
                    <>
                      <span className="mr-1.5 font-term text-accent">{task.id}</span>
                      <span className="text-ink">{task.title}</span>
                    </>
                  ) : (
                    <span className="text-muted">{st?.note ?? "No task"}</span>
                  )}
                  {limited && <span className="text-amber"> · limit until {limited}</span>}
                </p>
                <div className="flex items-end gap-2">
                  <span className="font-display text-[20px] font-semibold leading-none">{fmtTokens(tokens)}</span>
                  <span className="text-[11px] text-muted">today</span>
                  <span className="text-[12px] text-muted">· {fmtUsd(use?.costUsd ?? 0)}</span>
                  <span className="flex-1" />
                  <Sparkline data={use?.series ?? []} color={color} width={80} height={22} label={`${a.name} today`} />
                </div>
                <Meter value={tokens} max={usage.max} color={color} label={`${a.name}'s share of the busiest agent's tokens`} />
                <div className="flex flex-wrap items-center gap-1.5 border-t border-white/[0.06] pt-2.5">
                  <button className="btn px-2.5 text-[12px]" onClick={() => ui.openAgent(a.id, "terminal")}>
                    Terminal
                  </button>
                  <button className="btn px-2.5 text-[12px]" onClick={() => ui.openAgent(a.id, "messages")}>
                    Chat
                  </button>
                  <button className="btn px-2.5 text-[12px]" onClick={() => ui.openAgent(a.id, "usage")}>
                    Usage
                  </button>
                  <span className="flex-1" />
                  {!isViewer && (
                    <button
                      className={`btn px-2.5 text-[12px] ${running ? "border-red/35 text-red hover:bg-red/15" : "border-accent/40 text-accent hover:bg-accent/15"}`}
                      onClick={() => (running ? officeActions.stopAgent(a.id) : officeActions.startAgent(a.id))}
                    >
                      {running ? "Stop" : st?.session.state === "starting" ? "Starting…" : "Start"}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

export function More() {
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
        <button className="hud-glass hud-corners hud-scan flex h-full w-full flex-col gap-1 rounded-2xl px-4 py-3.5 text-left transition-colors hover:border-accent/40" onClick={onClick}>
          <b className="font-display text-[16px] font-semibold">{label}</b>
          <span className="text-[12px] text-muted">{sub}</span>
        </button>
      </li>
    );
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
      <ul className="m-0 mx-auto grid w-full max-w-[1000px] list-none grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))] gap-3 p-0">
        {item(`Findings${open ? ` · ${open}` : ""}`, "What agents found on in-scope targets; triage and the report", () => ui.openFindings(), security)}
        {item("Command center", "Every agent of every project, needs-you first", () => ui.setView("command", false))}
        {item("Projects", "Switch, create, pause, archive or delete projects", () => ui.openCto())}
        {item("Flow", "Stages, who works them and the gates between", () => ui.openFlow())}
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

/** Phones and tablets: the same HUD as the desktop, sized to the page between the header and the tabs. */
function HudHome() {
  const snap = useOffice((s) => s.snap)!;
  const team = selectTeam(snap);
  const working = team.filter((a) => modeOf(a.status) === "working").length;
  const inFlight = snap.tasks.filter((t) => t.status === "in-progress" || t.status === "in-review" || t.status === "blocked").length;
  const caption = team.length
    ? `${team.length} agent${team.length === 1 ? "" : "s"} · ${working} working${inFlight ? ` · ${inFlight} task${inFlight === 1 ? "" : "s"} in flight` : ""}`
    : snap.config.template ? "No agents yet. Add a team in Settings → Team." : "No agents in this project.";
  return (
    <div className="hud-void relative min-h-0 flex-1 overflow-hidden" aria-label="Team">
      <ParticleCore compact workingCount={working} attentionCount={selectAttention(snap).total} redTeam={projectMode(snap) === "redteam" || projectMode(snap) === "purpleteam"} />
      <StageStrip compact snap={snap} />
      <AgentOrbit compact team={team} tasks={snap.tasks} activeAgentId={null} caption={caption} redTeamProject={projectMode(snap) !== "build"} lift={!snap.welcome && !snap.config.template} />
    </div>
  );
}
