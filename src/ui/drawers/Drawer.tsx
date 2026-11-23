import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { DRAWER_DEFAULT, ui, useUi } from "../../store/ui";
import { Icon } from "../deck/Icon";
import { AgentDrawer } from "./AgentDrawer";
import { BoardsDrawer } from "./BoardsDrawer";
import { CtoDrawer } from "./CtoDrawer";
import { EnvironmentDrawer } from "./EnvironmentDrawer";
import { PrDrawer } from "./PrDrawer";
import { ActionItemsDrawer } from "./ActionItemsDrawer";
import { TerminalDrawer } from "./TerminalDrawer";
import { FindingsDrawer } from "./FindingsDrawer";
import { FlowDrawer } from "./FlowDrawer";

const SLIDE_OVER_KINDS = new Set(["agent", "env", "terminal", "cto"]);

function useDesktop(): boolean {
  const [wide, setWide] = useState(() => (typeof window !== "undefined" ? window.matchMedia("(min-width: 1000px)").matches : true));
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1000px)");
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

/** Every page's heading: title, then one line of context. Actions go after it in the DrawerHeader. */
export function PageTitle({ title, context }: { title: string; context?: ReactNode }) {
  return (
    <>
      <h1 className="m-0 font-display text-[20px] font-semibold tracking-tight text-ink">{title}</h1>
      {context !== undefined && <span className="min-w-0 truncate text-[13px] text-muted">{context}</span>}
    </>
  );
}

export function DrawerHeader({ children }: { children: ReactNode }) {
  const desktop = useDesktop();
  const drawer = useUi((s) => s.drawer);
  const isSlideOver = !!drawer && SLIDE_OVER_KINDS.has(drawer.kind);
  const solo = useUi((s) => s.solo !== null);
  const showControls = desktop && !solo && isSlideOver;
  return (
    <div className="flex flex-wrap items-center gap-2.5 border-b border-[var(--border-hairline)] bg-cream-2/50 px-4 py-3 md:px-5">
      {!desktop && !solo && isSlideOver && (
        <button type="button" className="btn px-2 py-1 text-[12px]" aria-label="Back" onClick={() => ui.closeDrawer()}>
          <Icon name="arrow_back" size={16} />
        </button>
      )}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2.5">{children}</div>
      {showControls && <MaximizeButton />}
      {showControls && (
        <button
          type="button"
          className="grid h-8 w-8 cursor-pointer place-items-center rounded-lg text-muted transition-colors hover:bg-cream-2 hover:text-ink"
          aria-label="Close"
          onClick={() => ui.closeDrawer()}
        >
          <Icon name="close" size={18} />
        </button>
      )}
    </div>
  );
}

function MaximizeButton() {
  const max = useUi((s) => s.drawerMaximized);
  const label = max ? "Restore size" : "Maximize";
  return (
    <button
      type="button"
      className={`grid h-8 w-8 cursor-pointer place-items-center rounded-lg transition-colors ${max ? "bg-cream-2 text-ink" : "text-muted hover:bg-cream-2 hover:text-ink"}`}
      aria-label={label}
      title={label}
      aria-pressed={max}
      onClick={() => ui.toggleDrawerMaximized()}
    >
      <Icon name={max ? "close_fullscreen" : "open_in_full"} size={17} />
    </button>
  );
}

/**
 * The drawer's left edge: drag to resize (the width is remembered in this browser), double-click
 * for the default width. Pointer capture keeps the drag going over the terminal's canvas.
 */
function ResizeHandle() {
  const start = useRef<{ x: number; width: number } | null>(null);
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const aside = e.currentTarget.parentElement;
    if (!aside) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, width: aside.getBoundingClientRect().width };
    document.body.style.userSelect = "none";
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (start.current) ui.setDrawerWidth(start.current.width + (start.current.x - e.clientX));
  };
  const up = () => {
    start.current = null;
    document.body.style.userSelect = "";
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      title="Drag to resize. Double-click to reset."
      className="group absolute -left-[9px] top-0 z-10 flex h-full w-[12px] cursor-col-resize justify-center"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={() => ui.setDrawerWidth(DRAWER_DEFAULT)}
    >
      <div className="my-auto h-12 w-[4px] bg-ink opacity-0 transition-opacity group-hover:opacity-60" />
    </div>
  );
}

export function DrawerHost() {
  const drawer = useUi((s) => s.drawer);
  const reduce = useReducedMotion();
  const width = useUi((s) => s.drawerWidth);
  const maximized = useUi((s) => s.drawerMaximized);
  const key = drawer ? (drawer.kind === "agent" ? `agent:${drawer.id}` : drawer.kind === "env" ? `env:${drawer.name}` : drawer.kind) : null;

  // The task board needs room for its columns: it opens as a large centered modal, not a side drawer.
  if (drawer?.kind === "boards")
    return (
      <div
        className="fixed inset-0 z-30 grid place-items-center bg-[rgba(36,26,46,0.55)] p-4"
        role="dialog"
        aria-modal="true"
        aria-label="Boards"
        onMouseDown={(e) => e.target === e.currentTarget && ui.closeDrawer()}
      >
        <motion.div
          initial={reduce ? false : { y: -8, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
          className="panel flex h-[90vh] w-[90vw] flex-col"
        >
          <BoardsDrawer initialBoardId={drawer.boardId} />
        </motion.div>
      </div>
    );

  return (
    <AnimatePresence mode="wait">
      {drawer && (
        <motion.aside
          key={key}
          initial={reduce ? false : { x: "110%" }}
          animate={{ x: 0 }}
          exit={reduce ? { opacity: 0 } : { x: "110%" }}
          transition={{ duration: reduce ? 0 : 0.28, ease: [0.3, 0, 0.2, 1] }}
          className={`hq-drawer panel fixed bottom-4 right-4 top-[74px] z-20 flex flex-col ${maximized ? "left-4" : ""}`}
          style={maximized ? undefined : { width: `min(${width}px, calc(100vw - 32px))` }}
          aria-label="Details"
        >
          {!maximized && <ResizeHandle />}
          {drawer.kind === "agent" && <AgentDrawer id={drawer.id} initialTab={drawer.tab} />}
          {drawer.kind === "prs" && <PrDrawer />}
          {drawer.kind === "actions" && <ActionItemsDrawer />}
          {drawer.kind === "env" && <EnvironmentDrawer name={drawer.name} />}
          {drawer.kind === "terminal" && <TerminalDrawer />}
          {drawer.kind === "cto" && <CtoDrawer />}
          {drawer.kind === "findings" && <FindingsDrawer />}
          {drawer.kind === "flow" && <FlowDrawer />}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
