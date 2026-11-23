import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";
import { BRAND } from "../../data/brand";
import { Lion } from "./Lion";

export interface BootStage {
  label: string;
  done: boolean;
}

/**
 * Shown from the first paint until the team is loaded. The three stages follow what is really happening
 * (HQ answered, this device is signed in, the first snapshot arrived), so it is progress, not decoration.
 */
export function BootScreen({ stages }: { stages: BootStage[] }) {
  const reduce = useReducedMotion();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), 8000);
    return () => window.clearTimeout(t);
  }, []);
  const active = stages.findIndex((s) => !s.done);
  const doneCount = stages.filter((s) => s.done).length;

  return (
    <motion.div
      className="deck-grid fixed inset-0 z-[100] flex flex-col items-center justify-center gap-8 bg-[var(--color-grass)] text-ink"
      initial={false}
      exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 1.04, filter: "blur(6px)" }}
      transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
      role="status"
      aria-live="polite"
      aria-label={`Starting ${BRAND.name}`}
    >
      <div className="relative flex h-40 w-40 items-center justify-center">
        <div
          className="boot-ring absolute inset-0 rounded-full"
          style={{ background: "conic-gradient(from 0deg, transparent 0deg, var(--accent) 120deg, transparent 220deg)", mask: "radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px))", WebkitMask: "radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px))" }}
          aria-hidden
        />
        <div className="absolute inset-3 rounded-full border border-[var(--border-hairline)]" aria-hidden />
        <div className="boot-lion text-accent">
          <Lion size={72} />
        </div>
      </div>

      <div className="flex flex-col items-center gap-1">
        <h1 className="m-0 font-display text-[28px] font-semibold tracking-tight">{BRAND.name}</h1>
        <p className="m-0 text-[13px] text-muted">{slow ? "Still trying to reach HQ. Check that it is running and your connection is up." : "Getting your team ready"}</p>
      </div>

      <ol className="m-0 flex w-[min(320px,calc(100vw-48px))] list-none flex-col gap-2.5 p-0">
        {stages.map((s, i) => (
          <li key={s.label} className={`flex items-center gap-3 text-[13px] transition-colors duration-300 ${s.done ? "text-ink" : i === active ? "text-ink" : "text-muted"}`}>
            <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
              {s.done ? (
                <span className="step-pop flex h-5 w-5 items-center justify-center rounded-full bg-[var(--accent)] text-[12px] font-semibold text-[var(--color-grass)]" aria-hidden>
                  ✓
                </span>
              ) : i === active ? (
                <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-[var(--accent)] shadow-[0_0_10px_var(--accent)]" aria-hidden />
              ) : (
                <span className="h-2 w-2 rounded-full bg-[var(--border-strong)]" aria-hidden />
              )}
            </span>
            {s.label}
          </li>
        ))}
      </ol>

      <div className="relative h-[3px] w-[min(320px,calc(100vw-48px))] overflow-hidden rounded-full bg-[var(--border-hairline)]" aria-hidden>
        <motion.div className="absolute inset-y-0 left-0 rounded-full bg-[var(--accent)]" initial={false} animate={{ width: `${(Math.max(doneCount, 0.4) / stages.length) * 100}%` }} transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }} />
        <div className="boot-bar absolute inset-0" />
      </div>
    </motion.div>
  );
}
