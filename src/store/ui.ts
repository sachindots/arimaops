import { create } from "zustand";
import { readPref, writePref } from "../lib/prefs";

export type DrawerState =
  | { kind: "agent"; id: string; tab?: AgentTab }
  | { kind: "boards"; boardId?: string }
  | { kind: "prs" }
  | { kind: "env"; name: string }
  | { kind: "actions" }
  | { kind: "terminal" }
  | { kind: "cto" }
  | { kind: "findings" }
  | null;

export type AgentTab = "terminal" | "shell" | "task" | "sandbox" | "messages";
export type SettingsTab = "team" | "users" | "accounts" | "workflow" | "stack" | "mcp" | "sandbox" | "boards" | "project";

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
  /** Side drawer width in px, remembered per browser; `maximized` fills the screen. */
  drawerWidth: number;
  drawerMaximized: boolean;
  /** Tablet/phone layout: chat, board and inbox instead of the office (narrow screens, or chosen). */
  compact: boolean;
  layoutChoice: LayoutChoice;
  /** Desktop: the pixel office, or the command center (every agent of every project, tiled). */
  view: View;
  /** A pop-out window showing one thing full-window: an agent (`?solo=agent&agent=<id>`) or the command center. */
  solo: Solo | null;
}

export type View = "office" | "command";
export type Solo = { kind: "agent"; agentId: string } | { kind: "command" };
const VIEW_PREF = "view";
function savedView(): View {
  try {
    return readPref(VIEW_PREF) === "command" ? "command" : "office";
  } catch {
    return "office";
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

function savedLayout(): LayoutChoice {
  try {
    const v = readPref(LAYOUT_PREF);
    return v === "compact" || v === "office" ? v : "auto";
  } catch {
    return "auto";
  }
}
const isCompact = (choice: LayoutChoice) => (choice === "auto" ? window.matchMedia(NARROW).matches : choice === "compact");

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
  drawerWidth: savedWidth(),
  drawerMaximized: false,
  compact: isCompact(savedLayout()),
  layoutChoice: savedLayout(),
  view: soloFromUrl()?.kind === "command" ? "command" : savedView(),
  solo: soloFromUrl(),
}));

window.matchMedia(NARROW).addEventListener("change", () => useUi.setState((s) => ({ compact: isCompact(s.layoutChoice) })));

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
  openBoards(boardId?: string) {
    useUi.setState({ drawer: { kind: "boards", boardId } });
  },
  openTerminal() {
    useUi.setState({ drawer: { kind: "terminal" } });
  },
  openActions() {
    useUi.setState({ drawer: { kind: "actions" } });
  },
  openFindings() {
    useUi.setState({ drawer: { kind: "findings" } });
  },
  openCto() {
    useUi.setState({ drawer: { kind: "cto" } });
  },
  openPrs() {
    useUi.setState({ drawer: { kind: "prs" } });
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
  setView(view: View) {
    try {
      writePref(VIEW_PREF, view);
    } catch {
      /* private window */
    }
    useUi.setState({ view });
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
