import { lazy, Suspense, useEffect, useState } from "react";
import type { OfficeSnapshot } from "./data/types";
import { connectOffice, useOffice } from "./store/office";
import { checkAuth, useAuth } from "./store/auth";
import { prefKey } from "./lib/prefs";
import { SignIn } from "./ui/auth/SignIn";
import { OwnerPrompt } from "./ui/auth/OwnerPrompt";
import { ui, useUi } from "./store/ui";
import { DebugPanel } from "./ui/DebugPanel";
import { DrawerHost } from "./ui/drawers/Drawer";
import { ActivityFeed } from "./ui/hud/ActivityFeed";
import { ConnectionBanner } from "./ui/hud/ConnectionBanner";
import { SetupChecklist } from "./ui/setup/SetupChecklist";
import { WelcomeModal } from "./ui/setup/WelcomeModal";
import { TeamPanel } from "./ui/hud/TeamPanel";
import { Tooltip } from "./ui/hud/Tooltip";
import { TopBar } from "./ui/hud/TopBar";
import { SettingsModal } from "./ui/settings/SettingsModal";
import { CompactApp } from "./ui/compact/CompactApp";
import { closeTopPanel } from "./lib/native";

// The office (PixiJS, most of the bundle) loads only when it's shown, so phones and tablets skip it.
const OfficeCanvas = lazy(() => import("./office/OfficeCanvas").then((m) => ({ default: m.OfficeCanvas })));

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
      const missing = s.snap.setup.checks
        .filter((c) => c.status !== "ok" && c.neededFor !== "github" && c.neededFor !== "local")
        .map((c) => c.id)
        .sort()
        .join(",");
      const key = prefKey(`setupSeen.${s.snap.config.project.id}`);
      let seen: string | null = null;
      try {
        seen = localStorage.getItem(key);
        localStorage.setItem(key, missing);
      } catch {
        /* private window: show it */
      }
      if (missing && missing !== seen) ui.openSetup();
    });
  }, []);
}

/** `?open=actions` / `?open=agent:<id>` / `?open=board` (links from push notifications): open it once connected. */
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
  useDeepLink();
  useKeyboard();
  useSetupPrompt();
  const ready = useOffice((s) => s.snap !== null);
  const setupOpen = useUi((s) => s.setupOpen);
  const welcome = useOffice((s) => s.live && !!s.snap?.welcome);
  const compact = useUi((s) => s.compact);
  // The office layout needs about 1180 px (a landscape tablet); narrower, when chosen anyway, the page scrolls instead of squeezing.
  useEffect(() => void (document.body.style.minWidth = compact ? "" : "1180px"), [compact]);
  // A real HQ that doesn't know this device: sign in first (not the demo data).
  if (auth === "signed-out") return <SignIn />;

  if (compact)
    return (
      <>
        <ConnectionBanner />
        {ready && (
          <>
            <CompactApp />
            <SettingsModal />
            <OwnerPrompt />
            {welcome ? <WelcomeModal /> : setupOpen && <SetupChecklist />}
          </>
        )}
      </>
    );

  return (
    <>
      <Suspense fallback={null}>
        <OfficeCanvas />
      </Suspense>
      <ConnectionBanner />
      {ready && (
        <>
          <TopBar />
          <TeamPanel />
          <ActivityFeed />
          <DrawerHost />
          <DebugPanel />
          <SettingsModal />
          <OwnerPrompt />
          {welcome ? <WelcomeModal /> : setupOpen && <SetupChecklist />}
          <Tooltip />
        </>
      )}
    </>
  );
}
