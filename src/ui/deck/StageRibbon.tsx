// Streamlined bottom stage ribbon: pipeline label on the left, clickable stages with task counts in the center
// (the active stage highlighted in a clean pill), and HQ WebSocket status on the right.

import { Fragment } from "react";
import type { OfficeSnapshot } from "../../data/types";
import { useOffice } from "../../store/office";
import { ui, useUi } from "../../store/ui";
import type { Theme } from "../theme/projectTheme";
import { DECK } from "./frame";

export function StageRibbon({ snap, theme }: { snap: OfficeSnapshot; theme: Theme }) {
  const live = useOffice((s) => s.live);
  const connection = useOffice((s) => s.connection);
  const railExpanded = useUi((s) => s.railExpanded);
  const railW = railExpanded ? DECK.railExpanded : DECK.rail;
  const stages = snap.config.template?.flow.stages ?? [];
  if (stages.length < 2) return null;
  const open = snap.tasks.filter((t) => t.status !== "done");
  const busiest = stages.reduce((best, s) => {
    const n = open.filter((t) => t.stageId === s.id && (t.status === "in-progress" || t.status === "in-review")).length;
    return n > best.n ? { id: s.id, n } : best;
  }, { id: "", n: 0 }).id;
  const state = !live
    ? `HQ Demo · :${snap.config.project.hqPort}`
    : connection === "open"
      ? `HQ WebSocket :${snap.config.project.hqPort} · Connected`
      : connection === "unauthorized"
        ? "Signed out"
        : "Reconnecting…";

  return (
    <footer
      className="deck-bar fixed bottom-0 right-0 z-20 flex items-center justify-between border-t px-6 transition-[left] duration-150"
      style={{ left: railW, height: DECK.footer }}
    >
      <div className="hidden shrink-0 items-center gap-2 lg:flex">
        <span className="text-[12px] font-semibold text-ink/80">{theme.pipeline}</span>
      </div>

      <nav aria-label="Flow stages" className="no-scrollbar flex min-w-0 flex-1 items-center justify-center gap-1 overflow-x-auto text-[12px]">
        {stages.map((s, i) => {
          const here = open.filter((t) => t.stageId === s.id);
          const busy = here.filter((t) => t.status === "in-progress" || t.status === "in-review");
          const raised = s.id === busiest || (!busiest && here.length > 0 && stages.findIndex((x) => open.some((t) => t.stageId === x.id)) === i);
          return (
            <Fragment key={s.id}>
              <button
                type="button"
                onClick={() => ui.openBoards(undefined, s.id)}
                className={`deck-stage flex shrink-0 cursor-pointer items-center gap-1 rounded px-2.5 py-1 text-[12px] ${raised ? "is-raised px-3" : "text-muted"}`}
                aria-label={`${s.name}: ${here.length} open task${here.length === 1 ? "" : "s"}. Open on the board`}
              >
                <span>{s.name}</span>
                <span>
                  ({busy.length > 0 ? `${busy.length} active` : here.length})
                </span>
              </button>
              {i < stages.length - 1 && <span className="px-0.5 text-muted/50" aria-hidden="true">›</span>}
            </Fragment>
          );
        })}
      </nav>

      <div className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted" role="status">
        <span className={`h-1.5 w-1.5 rounded-full ${!live || connection === "open" ? "bg-green" : "bg-amber"}`} aria-hidden="true" />
        <span>{state}</span>
      </div>
    </footer>
  );
}
