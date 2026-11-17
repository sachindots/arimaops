// The flow under the HUD (ROADMAP 5.3): each stage with its open tasks and the agents working in it now.
// It replaces the old office's rooms-per-stage. Opens the Flow page.

import { Fragment } from "react";
import type { OfficeSnapshot } from "../../data/types";
import { ui } from "../../store/ui";
import { Portrait } from "../kit";

export function StageStrip({ snap, compact = false }: { snap: OfficeSnapshot; compact?: boolean }) {
  const stages = snap.config.template?.flow.stages ?? [];
  if (stages.length < 2) return null; // one stage has nothing to show between
  const open = snap.tasks.filter((t) => t.status !== "done");
  return (
    <nav aria-label="Flow stages" className={compact ? "absolute inset-x-2 bottom-2 z-10 flex justify-center" : "pointer-events-none fixed bottom-4 left-[92px] right-4 z-10 flex justify-center"}>
      <button
        type="button"
        onClick={() => ui.openFlow()}
        title="Open the flow"
        className="hud-glass no-scrollbar pointer-events-auto flex max-w-full cursor-pointer items-center gap-0.5 overflow-x-auto rounded-2xl px-1.5 py-1.5 transition-colors hover:border-accent/45"
      >
        {stages.map((s, i) => {
          const here = open.filter((t) => t.stageId === s.id);
          const busy = here.filter((t) => t.status === "in-progress" || t.status === "in-review");
          const who = [...new Set(busy.map((t) => t.ownerId).filter(Boolean))]
            .map((id) => snap.config.team.find((a) => a.id === id))
            .filter((a) => !!a)
            .slice(0, 3);
          return (
            <Fragment key={s.id}>
              <span
                className={`flex shrink-0 items-center gap-1.5 rounded-xl px-2.5 py-1 ${busy.length ? "bg-accent/10" : ""}`}
                aria-label={`${s.name}: ${here.length} open task${here.length === 1 ? "" : "s"}${who.length ? `, ${who.map((a) => a.name).join(", ")} working` : ""}`}
              >
                <span className={`text-[12px] font-medium ${here.length ? "text-ink" : "text-muted"}`}>{s.name}</span>
                <span className={`font-display text-[14px] font-semibold leading-none ${busy.length ? "text-accent" : here.length ? "text-ink" : "text-muted/60"}`}>{here.length}</span>
                {who.length > 0 && (
                  <span className="flex -space-x-1.5">
                    {who.map((a) => (
                      <Portrait key={a.id} name={a.name} color={a.color} lead={false} size={20} />
                    ))}
                  </span>
                )}
              </span>
              {i < stages.length - 1 && (
                <svg width="14" height="14" viewBox="0 0 24 24" className="shrink-0 text-accent/50" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="M9 6l6 6-6 6" />
                </svg>
              )}
            </Fragment>
          );
        })}
      </button>
    </nav>
  );
}
