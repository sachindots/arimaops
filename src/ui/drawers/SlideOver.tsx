// A right-hand panel over the page for one thing (a stage, a finding, the scope). Esc or the backdrop closes it;
// focus moves into it when it opens. Rendered on document.body so it covers the header too.
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../deck/Icon";

export function SlideOver({ title, onClose, children, width = 440 }: { title: ReactNode; onClose: () => void; children: ReactNode; width?: number }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    window.addEventListener("keydown", onKey, true);
    panel.current?.focus();
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  // On document.body: inside a page it would sit under the header (the page is its own stacking context).
  return createPortal(
    <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}>
      <button className="absolute inset-0 cursor-default bg-black/35" aria-label="Close" tabIndex={-1} onClick={onClose} />
      <div ref={panel} tabIndex={-1} className="hud-drawer scroll-thin relative flex h-full w-full flex-col gap-4 overflow-y-auto border-l border-[var(--border-hairline)] p-5 outline-none" style={{ maxWidth: width }}>
        <div className="flex items-start gap-2">
          <h2 className="m-0 min-w-0 flex-1 text-[15px] font-semibold leading-snug text-ink">{title}</h2>
          <button type="button" className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted hover:bg-cream-2 hover:text-ink" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
