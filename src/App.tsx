import { useEffect, useState } from "react";
import type { OfficeSnapshot } from "./data/types";
import { connectOffice, isViewer, officeActions, useOffice } from "./store/office";
import { GITHUB_STATE_KEY } from "./data/githubApp";
import { checkAuth, useAuth } from "./store/auth";
import { prefKey } from "./lib/prefs";
import { SignIn } from "./ui/auth/SignIn";
import { OwnerPrompt } from "./ui/auth/OwnerPrompt";
import { ui, useUi } from "./store/ui";
import { DrawerHost } from "./ui/drawers/Drawer";
import { CommandToast } from "./ui/hud/CommandToast";
import { ConnectionBanner } from "./ui/hud/ConnectionBanner";
import { SetupChecklist } from "./ui/setup/SetupChecklist";
import { SetupWizard } from "./ui/setup/SetupWizard";
import { WelcomeModal } from "./ui/setup/WelcomeModal";
import { useProjectTheme } from "./ui/theme/projectTheme";
import { Deck } from "./ui/deck/Deck";
import { ask, DialogHost } from "./ui/dialog";
import { CommandView } from "./ui/command/CommandView";
import { AgentDrawer } from "./ui/drawers/AgentDrawer";
import { Logo } from "./ui/kit";
import { closeTopPanel, useNativePush } from "./lib/native";


function useKeyboard() {
  useEffect(() => {
    window.__arimaBack = closeTopPanel;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      // Never steal keys from inputs or the terminal.
      if (el && (el.closest("input, textarea, select, [contenteditable], .xterm") || e.metaKey || e.ctrlKey || e.altKey)) {
        if (e.key === "Escape" && el.closest(".xterm")) el.blur();
        return;
      }
      const { settings, setupOpen } = useUi.getState();
      if (e.key === "Escape") {
        closeTopPanel();
        return;
      }
      if (settings || setupOpen) return;
      let handled = true;
      if (e.key === "d" || e.key === "D") ui.toggleDebug();
      else if ((e.key === "o" || e.key === "O") && !useUi.getState().compact) ui.setView("command");
      else if (e.key === "+" || e.key === "=") ui.zoom(1);
      else if (e.key === "-") ui.zoom(-1);
      else if (/^[1-9]$/.test(e.key)) {
        const team = useOffice.getState().snap?.config.team ?? [];
        const agent = team[Number(e.key) - 1];
        if (agent) ui.openAgent(agent.id);
      } else handled = false;
      // The drawer focuses its terminal; don't let this key land in it too.
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      delete window.__arimaBack;
    };
  }, []);
}

/** The team was just created in this browser (welcome went from open to done): continue with sign-in, readiness and the first Start. */
function useWizardAfterWelcome() {
  useEffect(() => {
    let was = false;
    return useOffice.subscribe((s) => {
      const now = s.live && !!s.snap?.welcome;
      if (was && s.live && s.snap && !s.snap.welcome && !isViewer) ui.openWizard();
      was = now;
    });
  }, []);
}

/**
 * On a real HQ, open the setup checklist (after the welcome) when something needed is missing, but only
 * when that list changed since this browser last saw it: not on every reload (phones reload a lot).
 */
function useSetupPrompt() {
  useEffect(() => {
    let shown = false;
    return useOffice.subscribe((s) => {
      if (shown || !s.live || !s.snap || s.snap.welcome) return;
      shown = true;
      // Right after HQ starts, some checks fail until it is listening and re-checks: decide a few seconds later.
      window.setTimeout(() => {
        const snap = useOffice.getState().snap;
        if (!snap || snap.welcome) return;
        // Only what this team needs: a Sandbox item doesn't pop up for a team that runs in containers.
        const modes = new Set<string>(snap.config.team.map((a) => a.mode));
        const missing = snap.setup.checks
          .filter((c) => c.status !== "ok" && c.status !== "unsupported" && c.neededFor !== "local" && (c.neededFor === "all" || modes.has(c.neededFor)))
          .map((c) => c.id)
          .sort()
          .join(",");
        // Per machine, not per project: the checks are about this computer, so switching project doesn't reopen them.
        const key = prefKey("setupSeen");
        let seen: string | null = null;
        try {
          seen = localStorage.getItem(key);
          localStorage.setItem(key, missing);
        } catch {
          /* private window: show it */
        }
        if (missing && missing !== seen) ui.openSetup();
      }, 6000);
    });
  }, []);
}

/** `?open=actions` / `?open=agent:<id>` / `?open=board` (links from push notifications): open it once connected. */
/**
 * GitHub's manifest flow lands here with a one-time code. Read once when the app loads (effects may run twice), and
 * kept only if it answers the form this browser sent.
 */
const githubReturn = (() => {
  const url = new URL(location.href);
  const code = url.searchParams.get("github_code");
  if (!code) return null;
  const state = url.searchParams.get("github_state") ?? "";
  url.searchParams.delete("github_code");
  url.searchParams.delete("github_state");
  history.replaceState(null, "", url.toString());
  let expected: string | null = null;
  try {
    expected = sessionStorage.getItem(GITHUB_STATE_KEY);
    sessionStorage.removeItem(GITHUB_STATE_KEY);
  } catch {
    /* no storage: refused */
  }
  return { code, ok: !!expected && expected === state, used: false };
})();

function useGithubAppReturn() {
  useEffect(() => {
    if (!githubReturn || githubReturn.used) return;
    if (!githubReturn.ok) return void ((githubReturn.used = true), ask.alert("GitHub App not created", "That return from GitHub doesn't match a form this browser sent. Create the App again from Settings → Workflow."));
    let done = false;
    const send = () => {
      if (done) return;
      done = true;
      githubReturn.used = true; // once, even if the effect runs again
      officeActions.finishGithubApp(githubReturn.code);
      ui.openSettings("workflow");
    };
    if (useOffice.getState().snap) return send();
    return useOffice.subscribe((st) => st.snap && send());
  }, []);
}

function useDeepLink() {
  // Read once: dev StrictMode runs the effect twice, and the first run strips the param from the URL.
  const [open] = useState(() => new URL(location.href).searchParams.get("open"));
  useEffect(() => {
    if (!open) return;
    const url = new URL(location.href);
    url.searchParams.delete("open");
    history.replaceState(null, "", url.toString());
    let done = false;
    const go = (snap: OfficeSnapshot | null) => {
      if (!snap || done) return;
      done = true;
      if (open === "actions") ui.openActions();
      else if (open === "board") ui.openBoards();
      else if (open === "findings") ui.openFindings();
      else if (open.startsWith("agent:") && snap.config.team.some((a) => a.id === open.slice(6))) ui.openAgent(open.slice(6));
    };
    go(useOffice.getState().snap);
    return useOffice.subscribe((s) => go(s.snap));
  }, [open]);
}

export function App() {
  useEffect(() => connectOffice(), []);
  useEffect(() => void checkAuth(), []);
  const auth = useAuth((s) => s.status);
  const live = useOffice((s) => s.live);
  const welcomeDismissed = useUi((s) => s.welcomeDismissed);
  const forceMock = new URLSearchParams(location.search).get("mock") === "1";
  const pushError = useNativePush(auth === "signed-in");
  useDeepLink();
  useGithubAppReturn();
  useKeyboard();
  useSetupPrompt();
  useWizardAfterWelcome();
  useProjectTheme(useOffice((s) => s.snap)); // <html data-theme>: the accent follows the open project
  const ready = useOffice((s) => s.snap !== null);
  const setupOpen = useUi((s) => s.setupOpen);
  const wizardOpen = useUi((s) => s.wizardOpen);
  // A server somebody else could reach: the owner sign-in comes first, on top of the welcome.
  const remoteHost = !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const welcome = useOffice((s) => s.live && !!s.snap?.welcome);
  const showWelcome = welcome && !welcomeDismissed;
  const readOnly = useOffice((s) => s.live && !!s.snap && !s.snap.welcome && !s.snap.config.template);
  const readOnlyNote = "Read-only: this project was made before team templates. You can watch, answer and stop its agents.";
  const compact = useUi((s) => s.compact);
  const solo = useUi((s) => s.solo);
  const agentName = useOffice((s) => (solo?.kind === "agent" ? s.snap?.config.team.find((a) => a.id === solo.agentId)?.name : undefined));
  useEffect(() => {
    if (solo) document.title = solo.kind === "agent" ? `${agentName ?? "Agent"} · ArimaOps` : "Command · ArimaOps";
  }, [solo, agentName]);
  useEffect(() => void (document.body.style.minWidth = ""), []);
  if (auth === "checking" && !forceMock && !live) {
    return (
      <div className="deck-grid fixed inset-0 flex items-center justify-center bg-[var(--color-grass)] text-ink">
        <div className="panel flex items-center gap-3 rounded-xl px-5 py-4 text-[13px] font-medium text-muted">
          <Logo size={32} />
          <span>Connecting to HQ…</span>
        </div>
      </div>
    );
  }
  // A real HQ that doesn't know this device: sign in first (not the demo data).
  if (!forceMock && auth === "signed-out") return <SignIn />;

  // A pop-out window (another monitor): one agent, or the command center, filling the window.
  if (solo)
    return (
      <>
        <ConnectionBanner />
        <CommandToast />
        {ready && (
          <>
            {solo.kind === "agent" ? (
              <div className="panel fixed inset-0 flex flex-col">
                <AgentDrawer id={solo.agentId} />
              </div>
            ) : (
              <>
                <CommandView />
                <DrawerHost />
              </>
            )}
            {/* One dialog at a time: the owner sign-in waits for the welcome and the setup checklist. */}
            {(remoteHost || (!showWelcome && !setupOpen && !wizardOpen)) && <OwnerPrompt />}
            {wizardOpen && !showWelcome && <SetupWizard />}
            <DialogHost />
          </>
        )}
      </>
    );

  if (compact)
    return (
      <>
        <ConnectionBanner />
        <CommandToast />
        {pushError && <div role="status" className="bg-panel px-4 py-2 text-sm text-muted">{pushError}</div>}
        {readOnly && (
          <div role="status" className="pointer-events-none fixed bottom-[70px] left-1/2 z-10 w-max max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-2xl border border-white/10 bg-navy/85 px-3 py-1 text-center text-[12px] text-muted backdrop-blur-md min-[1000px]:bottom-3.5">
            {readOnlyNote}
          </div>
        )}
        {ready && (
          <>
            <Deck />
            {/* One dialog at a time: the owner sign-in waits for the welcome and the setup checklist. */}
            {showWelcome ? <WelcomeModal /> : wizardOpen ? <SetupWizard /> : setupOpen && <SetupChecklist />}
            {(remoteHost || (!showWelcome && !setupOpen && !wizardOpen)) && <OwnerPrompt />}
            <DialogHost />
          </>
        )}
      </>
    );

  return null; // isCompact is always true: the page layout above is the only one
}
