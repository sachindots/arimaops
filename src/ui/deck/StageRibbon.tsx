// The footer under the home screen: the flow's name, each stage with its open tasks (the busiest one raised, the
// agents working in it), and whether HQ is connected. A stage opens the Board filtered to that stage.

import { Fragment } from "react";
import type { OfficeSnapshot } from "../../data/types";
import { useOffice } from "../../store/office";
import { ui } from "../../store/ui";
import { Portrait } from "../kit";
import type { Theme } from "../theme/projectTheme";
import { DECK } from "./frame";
import { Icon } from "./Icon";

export function StageRibbon({ snap, theme }: { snap: OfficeSnapshot; theme: Theme }) {
  const live = useOffice((s) => s.live);
  const connection = useOffice((s) => s.connection);
  const stages = snap.config.template?.flow.stages ?? [];
  if (stages.length < 2) return null; // one stage has nothing to show between
  const open = snap.tasks.filter((t) => t.status !== "done");
  const busiest = stages.reduce((best, s) => {
    const n = open.filter((t) => t.stageId === s.id && (t.status === "in-progress" || t.status === "in-review")).length;
    return n > best.n ? { id: s.id, n } : best;
  }, { id: "", n: 0 }).id;
  const state = !live ? "Demo data" : connection === "open" ? "Connected" : connection === "unauthorized" ? "Signed out" : "Reconnecting…";

  return (
    <footer className="deck-bar fixed bottom-0 right-0 z-20 flex items-center gap-4 border-t px-4" style={{ left: DECK.rail, height: DECK.footer }}>
      <span className="hidden shrink-0 text-[12px] text-muted lg:inline">{theme.pipeline}</span>
      <nav aria-label="Flow stages" className="no-scrollbar flex min-w-0 flex-1 items-center justify-center gap-1 overflow-x-auto">
        {stages.map((s, i) => {
          const here = open.filter((t) => t.stageId === s.id);
          const busy = here.filter((t) => t.status === "in-progress" || t.status === "in-review");
          const who = [...new Set(busy.map((t) => t.ownerId).filter(Boolean))]
            .map((id) => snap.config.team.find((a) => a.id === id))
            .filter((a) => !!a)
            .slice(0, 3);
          const raised = s.id === busiest;
          return (
            <Fragment key={s.id}>
              <button
                type="button"
                onClick={() => ui.openBoards(undefined, s.id)}
                className={`deck-stage flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 ${raised ? "is-raised" : ""}`}
                aria-label={`${s.name}: ${here.length} open task${here.length === 1 ? "" : "s"}${who.length ? `, ${who.map((a) => a.name).join(", ")} working` : ""}. Open on the board`}
              >
                <span className={`text-[12px] font-medium ${here.length ? "text-ink" : "text-muted"}`}>{s.name}</span>
                <span key={here.length} className={`deck-count font-display text-[14px] font-semibold leading-none ${busy.length ? "text-accent" : here.length ? "text-ink" : "text-muted/60"}`}>
                  {here.length}
                </span>
                {who.length > 0 && (
                  <span className="flex -space-x-1.5">
                    {who.map((a) => (
                      <Portrait key={a.id} name={a.name} color={a.color} lead={false} size={20} />
                    ))}
                  </span>
                )}
              </button>
              {i < stages.length - 1 && <Icon name="chevron_right" size={16} className="shrink-0 text-accent/50" />}
            </Fragment>
          );
        })}
      </nav>
      <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted" role="status">
        <span className={`h-2 w-2 rounded-full ${!live || connection === "open" ? "bg-green" : "bg-amber"}`} aria-hidden="true" />
        {state}
      </span>
    </footer>
  );
}
