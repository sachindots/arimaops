import { useEffect, useRef, useState } from "react";
import type { Provider } from "../../data/providers";
import { officeActions, useOffice } from "../../store/office";
import { Icon } from "../deck/Icon";

/** Where a person gets a key for each provider. */
export const GET_KEY_URL: Partial<Record<Provider, string>> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  google: "https://aistudio.google.com/apikey",
  openrouter: "https://openrouter.ai/keys",
  nvidia: "https://build.nvidia.com/",
  deepseek: "https://platform.deepseek.com/api_keys",
};

export type KeyState = "idle" | "checking" | "ok" | "bad" | "unknown";

const MIN_AUTO = 20; // real keys are longer; this keeps half-typed text from being sent
const WAIT_MS = 800;

/**
 * Checks a key with its provider a moment after it stops changing (a paste is checked right away), so the person
 * sees a tick or a reason without pressing anything. `check()` runs it on demand.
 */
export function useKeyTest(provider: Provider, secret: string) {
  const [id, setId] = useState<string | null>(null);
  const result = useOffice((s) => (id ? s.keyTests[id] : undefined));
  const sent = useRef("");
  const key = secret.trim();

  const check = () => {
    if (!key) return;
    const next = `kt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    sent.current = `${provider}:${key}`;
    setId(next);
    officeActions.testAccountKey(provider, key, next);
  };

  useEffect(() => {
    // A different key or provider: the earlier answer no longer applies.
    if (sent.current !== `${provider}:${key}`) setId(null);
    if (key.length < MIN_AUTO || sent.current === `${provider}:${key}`) return;
    const t = window.setTimeout(check, WAIT_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, key]);

  const state: KeyState = !key || !id ? "idle" : !result ? "checking" : result.ok === true ? "ok" : result.ok === false ? "bad" : "unknown";
  return { state, message: result?.message ?? "", check };
}

/** The tick, cross or note under a key field, with a Check button until it has been checked. */
export function KeyTestStatus({ state, message, onCheck, hasKey }: { state: KeyState; message: string; onCheck: () => void; hasKey: boolean }) {
  if (!hasKey) return null;
  const look: Record<Exclude<KeyState, "idle">, { icon: string; color: string }> = {
    checking: { icon: "progress_activity", color: "var(--color-muted)" },
    ok: { icon: "check_circle", color: "var(--color-green)" },
    bad: { icon: "error", color: "var(--color-red)" },
    unknown: { icon: "info", color: "var(--color-amber)" },
  };
  return (
    <div className="flex flex-col items-start gap-2 text-[13px]" role="status" aria-live="polite">
      {state === "idle" ? (
        <button type="button" className="btn px-2 text-[12px]" onClick={onCheck}>
          Check this key
        </button>
      ) : (
        <>
          <div className="flex items-start gap-2">
            <span style={{ color: look[state].color }} className={`mt-px shrink-0 ${state === "checking" ? "animate-spin" : ""}`}>
              <Icon name={look[state].icon} size={18} />
            </span>
            <span className={state === "bad" ? "text-red" : "text-ink"}>{state === "checking" ? "Checking the key…" : message}</span>
          </div>
          {state !== "checking" && (
            <button type="button" className="btn px-2 text-[12px]" onClick={onCheck}>
              Check again
            </button>
          )}
        </>
      )}
    </div>
  );
}
