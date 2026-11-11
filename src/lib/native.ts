import { ui, useUi } from "../store/ui";
import { useEffect, useState } from "react";

declare global {
  interface Window {
    ArimaNative?: { platform(): "android"; switchServer(): void; pushToken(): Promise<string | null> };
    __arimaBack?: () => boolean;
  }
}

export function closeTopPanel(): boolean {
  const { setupOpen, settings, drawer } = useUi.getState();
  if (setupOpen) ui.closeSetup();
  else if (settings) ui.closeSettings();
  else if (drawer) ui.closeDrawer();
  else return false;
  return true;
}

export function useNativePush(signedIn: boolean) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    const abort = new AbortController();
    const sync = async () => {
      if (!window.ArimaNative?.pushToken) return;
      try {
        const token = await window.ArimaNative.pushToken();
        if (!active) return;
        const response = await fetch("/api/push/register", {
          method: token ? "POST" : "DELETE", credentials: "same-origin", signal: abort.signal,
          headers: { "Content-Type": "application/json" }, body: token ? JSON.stringify({ token }) : undefined,
        });
        if (!response.ok) throw new Error();
        if (active) setError(null);
      } catch {
        if (active) setError("Notifications are not connected. Check your connection and that your HQ server is up to date.");
      }
    };
    window.addEventListener("arima-native-ready", sync);
    window.addEventListener("arima-native-resume", sync);
    void sync();
    return () => {
      active = false;
      abort.abort();
      window.removeEventListener("arima-native-ready", sync);
      window.removeEventListener("arima-native-resume", sync);
    };
  }, [signedIn]);
  return error;
}
