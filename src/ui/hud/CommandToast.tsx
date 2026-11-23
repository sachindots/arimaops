import { useEffect, useState } from "react";
import { officeActions, useOffice } from "../../store/office";
import { useUi } from "../../store/ui";
import { Icon } from "../deck/Icon";

/** The reason a command failed (Start with no Docker, a refused edit...). Without it a failed click looks like nothing happened. */
export function CommandToast() {
  const error = useOffice((s) => s.lastCommandError);
  const seq = useOffice((s) => s.commandErrorSeq);
  const welcome = useOffice((s) => s.live && !!s.snap?.welcome);
  const welcomeDismissed = useUi((s) => s.welcomeDismissed);
  const welcomeOpen = welcome && !welcomeDismissed;
  const [shownSeq, setShownSeq] = useState(0);
  const visible = !!error && !welcomeOpen && seq !== shownSeq;

  useEffect(() => {
    if (!error || welcomeOpen) return;
    const timer = window.setTimeout(() => setShownSeq(seq), 12_000);
    return () => window.clearTimeout(timer);
  }, [error, seq, welcomeOpen]);

  if (!visible) return null;
  return (
    <div
      role="alert"
      className="toast-in fixed bottom-20 left-1/2 z-[60] flex w-[min(520px,calc(100vw-2rem))] -translate-x-1/2 items-start gap-2 rounded-lg border border-red/40 bg-[var(--surface-card)] px-3 py-2 text-[13px] text-ink shadow-lg backdrop-blur-xs"
    >
      <Icon name="error" size={18} className="mt-0.5 shrink-0 text-red" />
      <span className="min-w-0 flex-1 break-words">{error}</span>
      <button
        type="button"
        aria-label="Dismiss"
        className="cursor-pointer rounded-lg p-0.5 text-muted hover:text-ink"
        onClick={() => {
          setShownSeq(seq);
          officeActions.clearCommandError();
        }}
      >
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
