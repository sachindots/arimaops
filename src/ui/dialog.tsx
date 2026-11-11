// In-app replacements for window.alert / confirm / prompt, which render as the browser's old system dialog
// (on Android, a grey WebView box). One dialog shows at a time; later ones wait their turn.

import { useEffect, useState } from "react";
import { create } from "zustand";

type Field = "text" | "password" | "code";
interface Ask {
  title: string;
  message?: string;
  ok: string;
  danger?: boolean;
  /** No field: a confirm (or an alert when `cancel` is false). */
  field?: Field;
  cancel: boolean;
  done: (value: string | null) => void;
}

const useDialogs = create<{ queue: Ask[] }>(() => ({ queue: [] }));

function open(a: Omit<Ask, "done">): Promise<string | null> {
  return new Promise((resolve) => {
    const done = (v: string | null) => {
      useDialogs.setState((s) => ({ queue: s.queue.slice(1) }));
      resolve(v);
    };
    useDialogs.setState((s) => ({ queue: [...s.queue, { ...a, done }] }));
  });
}

export const ask = {
  alert: (title: string, message?: string) => open({ title, message, ok: "OK", cancel: false }).then(() => undefined),
  confirm: (title: string, message?: string, opts: { ok?: string; danger?: boolean } = {}) =>
    open({ title, message, ok: opts.ok ?? "OK", danger: opts.danger, cancel: true }).then((v) => v !== null),
  /** Resolves to the entered text, or null when cancelled or left empty. */
  text: (title: string, message?: string, opts: { field?: Field; ok?: string } = {}) =>
    open({ title, message, ok: opts.ok ?? "OK", field: opts.field ?? "text", cancel: true }).then((v) => v?.trim() || null),
};

export function DialogHost() {
  const a = useDialogs((s) => s.queue[0]);
  const [value, setValue] = useState("");
  useEffect(() => setValue(""), [a]);
  useEffect(() => {
    if (!a?.cancel) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && a.done(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [a]);
  if (!a) return null;
  const isCode = a.field === "code";
  const ready = !a.field || (isCode ? /^\d{6}$/.test(value) : value.trim().length > 0);
  const submit = () => ready && a.done(a.field ? value : "ok");
  return (
    <div className="fixed inset-0 z-[60] overflow-y-auto bg-[rgba(4,6,12,0.7)]" role="alertdialog" aria-modal="true" aria-label={a.title}>
      <div className="flex min-h-full items-center justify-center p-4">
        <form
          className="panel flex w-full max-w-[440px] flex-col gap-3 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <b className="text-[18px]">{a.title}</b>
          {a.message && <p className="m-0 whitespace-pre-line text-[14px] text-muted">{a.message}</p>}
          {a.field && (
            <input
              className={`field ${isCode ? "text-center font-mono text-[26px] tracking-[0.4em]" : ""}`}
              autoFocus
              type={a.field === "password" ? "password" : "text"}
              inputMode={isCode ? "numeric" : undefined}
              autoComplete={isCode ? "one-time-code" : a.field === "password" ? "new-password" : "off"}
              maxLength={isCode ? 6 : undefined}
              placeholder={isCode ? "000000" : undefined}
              aria-label={a.title}
              value={value}
              onChange={(e) => setValue(isCode ? e.target.value.replace(/\D/g, "") : e.target.value)}
            />
          )}
          <div className="flex justify-end gap-2">
            {a.cancel && (
              <button type="button" className="btn min-h-[40px] px-4" onClick={() => a.done(null)}>
                Cancel
              </button>
            )}
            <button type="submit" autoFocus={!a.field} disabled={!ready} className={`btn min-h-[40px] px-4 ${a.danger ? "border-red text-red" : "border-green text-green"} disabled:opacity-40`}>
              {a.ok}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
