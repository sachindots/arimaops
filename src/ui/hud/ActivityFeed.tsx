import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { ActivityEvent, ActivityType } from "../../data/types";
import { useOffice } from "../../store/office";
import { ago, useNow } from "../kit";

const ICON: Record<ActivityType, [string, string]> = {
  "task.assigned": ["▸", "#c04dff"],
  "task.started": ["●", "#00e5ff"],
  "task.created": ["+", "#c04dff"],
  "agent.needs-input": ["!", "#ff1744"],
  "agent.answered": ["✓", "#00ff66"],
  message: ["✉", "#ff2a85"],
  "pr.opened": ["⇡", "#00e5ff"],
  "review.started": ["◎", "#c04dff"],
  "review.passed": ["✓", "#00ff66"],
  "review.changes": ["✗", "#ff1744"],
  "pr.merged": ["⇢", "#00ff66"],
  deploy: ["▲", "#3ee0d0"],
  session: ["◆", "#6e7b94"],
  config: ["⚙", "#6e7b94"],
  "scope.refused": ["⛔", "#ff3b3b"],
};

const EMPTY: ActivityEvent[] = [];

export function ActivityFeed() {
  const activity = useOffice((s) => s.snap?.activity ?? EMPTY);
  const now = useNow(1000);
  const reduce = useReducedMotion();
  const items = activity.slice(0, 7);

  return (
    <section aria-label="Activity" className="hq-feed panel-dark fixed bottom-4 left-4 z-10 h-[220px] w-[280px] [@media(max-height:760px)]:h-[130px] overflow-hidden px-2.5 pb-1.5 pt-2">
      <div className="mb-1 flex items-center gap-2 text-[13px] uppercase tracking-[0.14em] text-[#b9c3e6]">
        <i className="led" />
        Activity
      </div>
      <ul className="m-0 list-none p-0 font-term text-[17px] leading-none" aria-live="polite">
        <AnimatePresence initial={false}>
          {items.map((e) => {
            const [icon, color] = ICON[e.type];
            return (
              <motion.li
                key={e.id}
                layout={!reduce}
                initial={reduce ? false : { opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.25 }}
                className="flex gap-1.5 border-t border-dashed border-[rgba(185,195,230,0.15)] py-[3px] first:border-t-0"
              >
                <span className="w-3 shrink-0 text-center" style={{ color }}>
                  {icon}
                </span>
                <span className="min-w-0 flex-1 truncate" title={e.text}>
                  {e.text}
                </span>
                <time className="shrink-0 text-[#7f8bb5]">{ago(e.at, now)}</time>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
    </section>
  );
}
