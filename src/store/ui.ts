import { create } from "zustand";
import { readPref, writePref } from "../lib/prefs";

export type DrawerState =
  | { kind: "agent"; id: string; tab?: AgentTab }
  | { kind: "boards"; boardId?: string; stageId?: string; taskId?: string }
  | { kind: "prs" }
  | { kind: "env"; name: string }
  | { kind: "actions" }
  | { kind: "terminal" }
  | { kind: "cto" }
  | { kind: "findings" }
  | { kind: "flow" }
  | null;

export type AgentTab = "terminal" | "shell" | "task" | "sandbox" | "messages" | "usage";
export type SettingsTab = "team" | "users" | "license" | "accounts" | "memory" | "workflow" | "stack" | "mcp" | "sandbox" | "boards" | "project";
export type WorkspaceId = "home" | "work" | "inbox" | "team" | "preview" | "usage" | "factory" | "ops";
export type WorkTab = "board" | "prs" | "findings" | "goals" | "flow";
export type TeamTab = "agents" | "chat" | "meetings";

/** Something in the office the camera can fly to. */
export type FocusTarget =
  | { kind: "agent"; id: string }
  | { kind: "wing"; project: string }
  | { kind: "home" };

export interface HoverInfo {
  title: string;
  sub?: string;
  x: number;
  y: number;
}

interface UiState {
  drawer: DrawerState;
  settings: { tab: SettingsTab; agentId?: string } | null;
  hover: HoverInfo | null;
  focus: { target: FocusTarget; nonce: number } | null;
  zoomRequest: { delta: number; nonce: number } | null;
  debugOpen: boolean;
  setupOpen: boolean;
  welcomeDismissed: boolean;
  /** Active top-level workspace preserved across desktop <-> tablet resize. */
  workspace: WorkspaceId;
  /** Sub-tab inside Work workspace (Board | PRs/Findings | Goals | Flow). */
  workTab: WorkTab;
  /** Optional board filter state when jumping to Work -> Board. */
  boardFilter: { boardId?: string; stageId?: string; taskId?: string } | null;
  /** Sub-tab inside Team workspace (Agents | Chat | Meetings). */
  teamTab: TeamTab;
  /** Active meeting session in Team -> Meetings. */
  activeMeetingId: string | null;
  /** Selected Inbox item or VisualDecision id. */
  selectedDecisionId: string | null;
  /** Active Chat thread id ("@team" or agentId), preserved across resize. */
  chatThread: string;
  /** Unsent Chat drafts keyed by thread id, preserved across resize. */
  chatDrafts: Record<string, string>;
  /** Whether the desktop left rail is expanded with full labels. */
  railExpanded: boolean;
  /** Side drawer width in px, remembered per browser; `maximized` fills the screen. */
  drawerWidth: number;
  drawerMaximized: boolean;
  /** Tablet/phone layout: chat, board and inbox instead of the office (narrow screens, or chosen). */
  compact: boolean;
  layoutChoice: LayoutChoice;
  /** Desktop: the pixel office, or the command center (every agent of every project, tiled). */
  view: View;
  /** Surface appearance: clean light slate (default for software) or dark obsidian (default for security). */
  scheme: Scheme;
  /** True when the user explicitly toggled light/dark mode in this browser. */
  schemePinned: boolean;
  /** A pop-out window showing one thing full-window: an agent (`?solo=agent&agent=<id>`) or the command center. */
  solo: Solo | null;
}

export type View = "office" | "command";
export type Scheme = "dark" | "light";
export type Solo = { kind: "agent"; agentId: string } | { kind: "command" };
const VIEW_PREF = "view";
const SCHEME_PREF = "scheme";
function savedView(): View {
  try {
    return readPref(VIEW_PREF) === "command" ? "command" : "office";
  } catch {
    return "office";
  }
}
function savedScheme(): { scheme: Scheme; pinned: boolean } {
  try {
    const raw = readPref(SCHEME_PREF);
    if (raw === "light" || raw === "dark") {
      if (typeof document !== "undefined") document.documentElement.dataset.scheme = raw;
      return { scheme: raw, pinned: true };
    }
    if (typeof document !== "undefined") document.documentElement.dataset.scheme = "dark";
    return { scheme: "dark", pinned: false };
  } catch {
    if (typeof document !== "undefined") document.documentElement.dataset.scheme = "dark";
    return { scheme: "dark", pinned: false };
  }
}
function soloFromUrl(): Solo | null {
  const q = new URL(location.href).searchParams;
  if (q.get("solo") === "agent" && q.get("agent")) return { kind: "agent", agentId: q.get("agent")! };
  if (q.get("solo") === "command") return { kind: "command" };
  return null;
}

/** auto = compact below 1280 px (the office needs that width). */
export type LayoutChoice = "auto" | "compact" | "office";
const LAYOUT_PREF = "layout";
const NARROW = "(max-width: 1279px)";
/** Narrower than the office's 1180 px: even when chosen it would be stretched and cut off, so this layout is used. */
const TOO_NARROW = "(max-width: 1179px)";

function savedLayout(): LayoutChoice {
  try {
    const v = readPref(LAYOUT_PREF);
    return v === "compact" || v === "office" ? v : "auto";
  } catch {
    return "auto";
  }
}
const isCompact = (_choice: LayoutChoice) => true; // one layout on every screen: pages, no office scene

const WIDTH_PREF = "drawerWidth";
export const DRAWER_MIN = 420;
export const DRAWER_DEFAULT = 520;

/** Room left for the office and team panel when the drawer is as wide as it gets. */
export function drawerMax() {
  return Math.max(DRAWER_MIN, window.innerWidth - 32);
}

function savedWidth(): number {
  try {
    const v = Number(readPref(WIDTH_PREF));
    return Number.isFinite(v) && v >= DRAWER_MIN ? v : DRAWER_DEFAULT;
  } catch {
    return DRAWER_DEFAULT;
  }
}

export const useUi = create<UiState>(() => ({
  drawer: null,
  settings: null,
  hover: null,
  focus: null,
  zoomRequest: null,
  debugOpen: false,
  setupOpen: false,
  welcomeDismissed: (() => {
    try {
      return sessionStorage.getItem("arima.welcomeDismissed") === "1";
    } catch {
      return false;
    }
  })(),
  workspace: "home",
  workTab: "board",
  boardFilter: null,
  teamTab: "agents",
  activeMeetingId: null,
  selectedDecisionId: null,
  chatThread: "@team",
  chatDrafts: {},
  railExpanded: false,
  drawerWidth: savedWidth(),
  drawerMaximized: false,
  compact: isCompact(savedLayout()),
  layoutChoice: savedLayout(),
  view: soloFromUrl()?.kind === "command" ? "command" : savedView(),
  scheme: savedScheme().scheme,
  schemePinned: savedScheme().pinned,
  solo: soloFromUrl(),
}));

for (const q of [NARROW, TOO_NARROW]) window.matchMedia(q).addEventListener("change", () => useUi.setState((s) => ({ compact: isCompact(s.layoutChoice) })));

let nonce = 0;

export const ui = {
  focus(target: FocusTarget) {
    nonce += 1;
    useUi.setState({ focus: { target, nonce } });
  },
  openAgent(id: string, tab?: AgentTab) {
    useUi.setState({ drawer: { kind: "agent", id, tab } });
    ui.focus({ kind: "agent", id });
  },
  setWorkspace(workspace: WorkspaceId) {
    useUi.setState({
      workspace,
      view: "office",
      settings: null,
      drawer: null,
    });
  },
  openOps() {
    useUi.setState({
      workspace: "ops",
      view: "office",
      settings: null,
      drawer: null,
    });
  },
  setWorkTab(workTab: WorkTab) {
    useUi.setState((s) => ({
      workspace: "work",
      workTab,
      view: "office",
      settings: null,
      drawer:
        s.drawer && ["boards", "prs", "findings", "flow", "actions"].includes(s.drawer.kind)
          ? null
          : s.drawer,
    }));
  },
  setTeamTab(teamTab: TeamTab) {
    useUi.setState((s) => ({
      workspace: "team",
      teamTab,
      view: "office",
      settings: null,
      drawer:
        s.drawer && ["boards", "prs", "findings", "flow", "actions"].includes(s.drawer.kind)
          ? null
          : s.drawer,
    }));
  },
  openBoards(boardId?: string, stageId?: string) {
    useUi.setState({
      workspace: "work",
      workTab: "board",
      boardFilter: { boardId, stageId },
      drawer: { kind: "boards", boardId, stageId },
      settings: null,
    });
  },
  /** The board the task is on, with the task open. */
  openTask(taskId: string, boardId?: string) {
    useUi.setState({
      workspace: "work",
      workTab: "board",
      boardFilter: { boardId, taskId },
      drawer: { kind: "boards", boardId, taskId },
      settings: null,
    });
  },
  openGoals() {
    useUi.setState({
      workspace: "work",
      workTab: "goals",
      drawer: null,
      settings: null,
    });
  },
  openUsage() {
    useUi.setState({
      workspace: "usage",
      view: "office",
      drawer: null,
      settings: null,
    });
  },
  openFactory() {
    useUi.setState({
      workspace: "factory",
      view: "office",
      drawer: null,
      settings: null,
    });
  },
  openPreview() {
    useUi.setState({
      workspace: "preview",
      drawer: null,
      settings: null,
    });
  },
  openChat(thread?: string) {
    useUi.setState((s) => ({
      workspace: "team",
      teamTab: "chat",
      chatThread: thread ?? s.chatThread,
      drawer: null,
      settings: null,
    }));
  },
  setChatThread(chatThread: string) {
    useUi.setState({ chatThread });
  },
  setChatDraft(thread: string, text: string) {
    useUi.setState((s) => ({
      chatDrafts: { ...s.chatDrafts, [thread]: text },
    }));
  },
  openMeetings(meetingId?: string | null) {
    useUi.setState((s) => ({
      workspace: "team",
      teamTab: "meetings",
      activeMeetingId: meetingId !== undefined ? meetingId : s.activeMeetingId,
      drawer: null,
      settings: null,
    }));
  },
  setActiveMeeting(activeMeetingId: string | null) {
    useUi.setState({ activeMeetingId });
  },
  toggleRail() {
    useUi.setState((s) => ({ railExpanded: !s.railExpanded }));
  },
  openTerminal() {
    useUi.setState({ drawer: { kind: "terminal" } });
  },
  openActions(decisionId?: string) {
    useUi.setState((s) => ({
      workspace: "inbox",
      selectedDecisionId: decisionId ?? s.selectedDecisionId,
      drawer: { kind: "actions" },
      settings: null,
    }));
  },
  setSelectedDecision(selectedDecisionId: string | null) {
    useUi.setState({ selectedDecisionId });
  },
  openFindings() {
    useUi.setState({
      workspace: "work",
      workTab: "findings",
      drawer: { kind: "findings" },
      settings: null,
    });
  },
  openCto() {
    useUi.setState({ drawer: { kind: "cto" } });
  },
  openFlow() {
    useUi.setState({
      workspace: "work",
      workTab: "flow",
      drawer: { kind: "flow" },
      settings: null,
    });
  },
  openPrs() {
    useUi.setState({
      workspace: "work",
      workTab: "prs",
      drawer: { kind: "prs" },
      settings: null,
    });
  },
  openEnv(name: string) {
    useUi.setState({ drawer: { kind: "env", name } });
  },
  closeDrawer() {
    useUi.setState({ drawer: null });
    ui.focus({ kind: "home" });
  },
  openSettings(tab: SettingsTab = "team", agentId?: string) {
    useUi.setState({ settings: { tab, agentId } });
  },
  closeSettings() {
    useUi.setState({ settings: null });
  },
  setHover(hover: HoverInfo | null) {
    useUi.setState({ hover });
  },
  zoom(delta: number) {
    nonce += 1;
    useUi.setState({ zoomRequest: { delta, nonce } });
  },
  openSetup() {
    useUi.setState({ setupOpen: true });
  },
  closeSetup() {
    useUi.setState({ setupOpen: false });
  },
  dismissWelcome() {
    try {
      sessionStorage.setItem("arima.welcomeDismissed", "1");
    } catch {
      /* private mode */
    }
    useUi.setState({ welcomeDismissed: true });
  },
  openWelcome() {
    try {
      sessionStorage.removeItem("arima.welcomeDismissed");
    } catch {
      /* private mode */
    }
    useUi.setState({ welcomeDismissed: false });
  },
  setDrawerWidth(px: number) {
    const w = Math.round(Math.min(drawerMax(), Math.max(DRAWER_MIN, px)));
    useUi.setState({ drawerWidth: w, drawerMaximized: false });
    try {
      writePref(WIDTH_PREF, String(w));
    } catch {
      /* private window: applies until reload */
    }
  },
  toggleDrawerMaximized() {
    useUi.setState((s) => ({ drawerMaximized: !s.drawerMaximized }));
  },
  /** `remember`: keep it for the next visit (the phone/tablet layout opens it as a page instead, so it doesn't). */
  setView(view: View, remember = true) {
    try {
      if (remember) writePref(VIEW_PREF, view);
    } catch {
      /* private window */
    }
    useUi.setState({ view });
  },
  setScheme(next: Scheme, pinned = true) {
    document.documentElement.dataset.scheme = next;
    try {
      if (pinned) writePref(SCHEME_PREF, next);
    } catch {
      /* private window */
    }
    useUi.setState({ scheme: next, schemePinned: pinned });
  },
  toggleScheme() {
    const next: Scheme = useUi.getState().scheme === "light" ? "dark" : "light";
    ui.setScheme(next, true);
  },
  /** Opens an agent in its own window (drag it to another monitor). */
  popOutAgent(project: string, agentId: string) {
    window.open(`/?project=${encodeURIComponent(project)}&solo=agent&agent=${encodeURIComponent(agentId)}`, `arima-${project}-${agentId}`, "popup=yes,width=1040,height=780");
  },
  popOutCommand(project: string) {
    window.open(`/?project=${encodeURIComponent(project)}&solo=command`, "arima-command", "popup=yes,width=1600,height=900");
  },
  setLayout(choice: LayoutChoice) {
    try {
      writePref(LAYOUT_PREF, choice);
    } catch {
      /* private window */
    }
    useUi.setState({ layoutChoice: choice, compact: isCompact(choice), drawer: null });
  },
  toggleDebug() {
    useUi.setState((s) => ({ debugOpen: !s.debugOpen }));
  },
};
