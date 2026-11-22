import { markSignedOut } from "../../store/auth";
import { useOffice } from "../../store/office";

/** Shown when the real HQ server is unreachable. */
export function ConnectionBanner() {
  const live = useOffice((s) => s.live);
  const connection = useOffice((s) => s.connection);
  const ready = useOffice((s) => s.snap !== null);
  const persistent = useOffice((s) => s.snap?.setup.machine.persistentAgents ?? true);
  if (!live || connection === "open" || (connection === "connecting" && !ready)) return null;
  const unauthorized = connection === "unauthorized";
  const text = unauthorized
    ? "Session expired or HQ restarted with a new link."
    : `Lost connection to HQ. Reconnecting…${persistent ? " Agents keep running in tmux." : ""}`;
  return (
    <div
      role="status"
      className="fixed left-1/2 top-[68px] z-50 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-white/10 bg-red px-3 py-1 text-[13px] font-semibold text-white"
    >
      <span>{text}</span>
      {unauthorized && (
        <button
          type="button"
          onClick={() => markSignedOut()}
          className="rounded border border-white/30 bg-white/15 px-2 py-0.5 text-[12px] font-semibold text-white hover:bg-white/25"
        >
          Sign in
        </button>
      )}
    </div>
  );
}
