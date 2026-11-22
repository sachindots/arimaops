import { ui, useUi } from "../store/ui";
import { useEffect, useState } from "react";

declare global {
  interface Window {
    ArimaNative?: { platform(): "android"; switchServer(): void; pushToken(): Promise<string | null> };
    __TAURI_INTERNALS__?: { invoke?: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
    __arimaBack?: () => boolean;
  }
}

/** True when running inside the unified Tauri v2 desktop/Android client. */
export function isTauriClient(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

/** True when running inside either the Tauri v2 client or the legacy Android WebView wrapper. */
export function isNativeClient(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__ || window.ArimaNative);
}

/** Reactive native-client detector (updates if the wrapper signals readiness after load). */
export function useIsNativeClient(): boolean {
  const [native, setNative] = useState<boolean>(() => isNativeClient());
  useEffect(() => {
    const sync = () => setNative(isNativeClient());
    window.addEventListener("arima-native-ready", sync);
    sync();
    return () => window.removeEventListener("arima-native-ready", sync);
  }, []);
  return native;
}

/** Ask the native Tauri v2 / Android client shell to return to its server-picker screen. */
export async function switchServer(): Promise<void> {
  if (typeof window === "undefined") return;
  if (window.__TAURI_INTERNALS__?.invoke) {
    try {
      await window.__TAURI_INTERNALS__.invoke("switch_server");
      return;
    } catch {
      /* fall through to legacy hook if present */
    }
  }
  window.ArimaNative?.switchServer();
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
