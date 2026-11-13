import { BRAND } from "../../data/brand";
import { useRef, useState } from "react";
import type { SetupCheck, SetupStatus } from "../../data/types";
import { officeActions, useOffice } from "../../store/office";
import { ui } from "../../store/ui";
import { TerminalView } from "../drawers/TerminalView";

const ICON: Record<SetupStatus, [string, string]> = {
  ok: ["✓", "#3fb950"],
  missing: ["✗", "#f85149"],
  unsupported: ["✗", "#f85149"],
  warning: ["!", "#a371f7"],
};

const NEEDED: Record<SetupCheck["neededFor"], string> = {
  sandbox: "for sandboxes",
  container: "for Container mode",
  local: "for Local mode",
  all: "required",
  github: "for PRs & reviews",
};

function CheckRow({ c, running, onRun }: { c: SetupCheck; running: boolean; onRun: () => void }) {
  const [copied, setCopied] = useState(false);
  const [icon, color] = ICON[c.status];
  return (
    <li className="border-t-2 border-dashed border-cream-3 py-2.5 first:border-t-0">
      <div className="flex items-start gap-2.5">
        <span className="w-4 shrink-0 text-center text-[18px] font-bold leading-6" style={{ color }} aria-label={c.status}>
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <b className="text-[16px]">{c.label}</b>
            <span className="text-[12px] text-muted">{NEEDED[c.neededFor]}</span>
          </div>
          <div className="text-[14px] text-muted">{c.detail}</div>
          {c.fix && c.status !== "ok" && (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {c.fix.command && (
                <>
                  <code className="max-w-full truncate border-2 border-ink bg-navy-2 px-2 py-0.5 font-term text-[17px] text-[#e6e8eb]">{c.fix.command}</code>
                  <button
                    className="btn px-2 text-[12px]"
                    onClick={() => {
                      void navigator.clipboard?.writeText(c.fix?.command ?? "");
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1200);
                    }}
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                  {c.fix.runnable && (
                    <button className="btn px-2 text-[12px]" disabled={running} onClick={onRun}>
                      {running ? "Running…" : "Run in terminal"}
                    </button>
                  )}
                </>
              )}
              {c.fix.docs && (
                <a className="text-[13px] font-semibold underline" href={c.fix.docs} target="_blank" rel="noreferrer">
                  Docs ↗
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

/** "Get ArimaOps ready": what's missing on this machine and how to fix it. */
export function SetupChecklist() {
  const setup = useOffice((s) => s.snap?.setup);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [big, setBig] = useState(false);
  const termBox = useRef<HTMLDivElement>(null);
  if (!setup) return null;

  return (
    <div className="fixed inset-0 z-40 grid grid-cols-[minmax(0,1fr)] place-items-center bg-[rgba(4,5,8,0.75)] p-4" role="dialog" aria-modal="true" aria-label="Setup checklist">
      <div className="panel flex max-h-[calc(100dvh-2rem)] w-[min(760px,100%)] flex-col">
        <div className="flex items-center gap-3 border-b border-ink px-4 py-2">
          <h2 className="m-0 flex-1 text-[22px] font-bold">Get {BRAND.name} ready</h2>
          <button className="btn text-[14px]" onClick={() => officeActions.recheckSetup()}>
            Check again
          </button>
        </div>
        <div className="scroll-thin min-h-0 overflow-y-auto px-4 py-2">
          <div className="mb-2 flex flex-wrap gap-2 text-[14px]">
            <span className="chip chip-dot" style={{ ["--c" as string]: setup.sandboxReady ? "#3fb950" : "#f85149" }}>
              Sandboxes {setup.sandboxReady ? "ready" : "not ready"}
            </span>
            <span className="chip chip-dot" style={{ ["--c" as string]: setup.localReady ? "#3fb950" : "#6b7280" }}>
              Local mode {setup.localReady ? "ready" : "not ready"}
            </span>
            {setup.checks.some((c) => c.neededFor === "container") && (
              <span className="chip chip-dot" style={{ ["--c" as string]: setup.containerReady ? "#3fb950" : "#f85149" }}>
                Containers {setup.containerReady ? "ready" : "not ready"}
              </span>
            )}
          </div>
          <ul>
            {setup.checks.map((c) => (
              <CheckRow
                key={c.id}
                c={c}
                running={runningId === c.id}
                onRun={() => {
                  setRunningId(c.id);
                  officeActions.runSetupFix(c.id);
                  window.setTimeout(() => termBox.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
                }}
              />
            ))}
          </ul>
          {runningId && (
            <div ref={termBox} className={big ? "fixed inset-0 z-[55] flex flex-col bg-navy-2" : "mb-2 mt-1 scroll-mt-2 border border-ink"}>
              <div className="flex items-center gap-2 bg-navy px-2 py-1 text-[13px] text-cream">
                <span className="min-w-0 flex-1 truncate">{setup.checks.find((c) => c.id === runningId)?.label ?? "Running"} · type here if it asks for input</span>
                <button className="btn px-2 py-1 text-[12px]" onClick={() => setBig(!big)}>
                  {big ? "Exit full screen" : "Full screen"}
                </button>
                <button className="btn px-2 py-1 text-[12px]" onClick={() => (setBig(false), setRunningId(null))}>
                  Hide
                </button>
              </div>
              <div className={big ? "min-h-0 flex-1" : "h-[min(62vh,520px)]"}>
                <TerminalView key={runningId} agentId={`setup:${runningId}`} />
              </div>
            </div>
          )}
          {!setup.sandboxReady && setup.localReady && (
            <p className="mb-2 border border-orange bg-[rgba(192,77,255,0.14)] px-3 py-2 text-[14px]">
              Sandboxes aren't available here, but Local mode is. Set agents to <b>Local</b> in Settings → Team. They run plain Claude Code in their own folder, with permission prompts on.
            </p>
          )}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-ink px-4 py-2">
          <span className="text-[12px] text-muted">{BRAND.name} never runs sudo or install scripts for you. "Run in terminal" shows exactly what runs.</span>
          <button className="btn" onClick={() => ui.closeSetup()}>
            Continue to the office
          </button>
        </div>
      </div>
    </div>
  );
}
