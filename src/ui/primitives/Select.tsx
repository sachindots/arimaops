import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../deck/Icon";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  group?: string;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  ariaLabel?: string;
  title?: string;
  id?: string;
  size?: "sm" | "md";
}

interface PopoverPos {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
}

/**
 * Custom accessible Select combobox replacing native OS select controls everywhere.
 * Renders a single Material Symbols chevron, crisp Inter text, and a portaled frosted-glass
 * listbox popover that auto-flips near viewport edges and never gets clipped by overflow containers.
 */
export function Select({
  value,
  onChange,
  options,
  placeholder = "Select…",
  disabled = false,
  className = "",
  "aria-label": ariaLabelProp,
  ariaLabel: ariaLabelCamel,
  title,
  id,
  size = "md",
}: SelectProps) {
  const ariaLabel = ariaLabelProp ?? ariaLabelCamel;
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const [pos, setPos] = useState<PopoverPos | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const selectedIndex = useMemo(() => options.findIndex((o) => o.value === value), [options, value]);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const grouped = useMemo(() => {
    const out: { group: string | null; items: { opt: SelectOption; idx: number }[] }[] = [];
    for (let i = 0; i < options.length; i += 1) {
      const opt = options[i];
      const g = opt.group ?? null;
      const last = out[out.length - 1];
      if (last && last.group === g) {
        last.items.push({ opt, idx: i });
      } else {
        out.push({ group: g, items: [{ opt, idx: i }] });
      }
    }
    return out;
  }, [options]);

  const computePosition = () => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const minW = Math.max(rect.width, 180);
    const maxW = Math.min(360, window.innerWidth - 16);
    const width = Math.min(maxW, minW);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const flipUp = spaceBelow < 240 && spaceAbove > spaceBelow;
    if (flipUp) {
      setPos({ left, width, bottom: window.innerHeight - rect.top + 6 });
    } else {
      setPos({ left, width, top: rect.bottom + 6 });
    }
  };

  useEffect(() => {
    if (!open) return;
    computePosition();
    setCursor(selectedIndex >= 0 ? selectedIndex : options.findIndex((o) => !o.disabled));

    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onResizeOrScroll = () => computePosition();
    const onKeyGlobal = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("resize", onResizeOrScroll);
    window.addEventListener("scroll", onResizeOrScroll, true);
    window.addEventListener("keydown", onKeyGlobal, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("resize", onResizeOrScroll);
      window.removeEventListener("scroll", onResizeOrScroll, true);
      window.removeEventListener("keydown", onKeyGlobal, true);
    };
  }, [open, selectedIndex, options]);

  useEffect(() => {
    if (!open || cursor < 0) return;
    const item = menuRef.current?.querySelector<HTMLElement>(`[data-opt-idx="${cursor}"]`);
    item?.scrollIntoView({ block: "nearest" });
  }, [open, cursor]);

  const moveCursor = (dir: 1 | -1) => {
    if (!options.length) return;
    let next = cursor;
    for (let step = 0; step < options.length; step += 1) {
      next = (next + dir + options.length) % options.length;
      if (!options[next].disabled) {
        setCursor(next);
        return;
      }
    }
  };

  const commit = (idx: number) => {
    const opt = options[idx];
    if (!opt || opt.disabled) return;
    setOpen(false);
    if (opt.value !== value) onChange(opt.value);
    triggerRef.current?.focus();
  };

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      else moveCursor(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) setOpen(true);
      else moveCursor(-1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!open) setOpen(true);
      else if (cursor >= 0) commit(cursor);
    } else if (e.key === "Tab" && open) {
      setOpen(false);
    }
  };

  const hasWidth = /\bw-/.test(className);
  const sizeClass = size === "sm" ? "h-8 text-[12px]" : "h-9 text-[13px]";

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
        title={title ?? selected?.label}
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
        className={`inline-flex cursor-pointer items-center justify-between gap-2 rounded-lg border border-[var(--border-strong)] bg-[var(--cream)] px-3 text-left font-medium text-ink transition-colors hover:border-[var(--color-muted)] hover:bg-cream-2 focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/25 disabled:cursor-not-allowed disabled:opacity-50 ${
          hasWidth ? "" : "w-full"
        } ${sizeClass} ${open ? "border-[var(--accent)] ring-2 ring-[var(--accent)]/20" : ""} ${className}`}
      >
        <span className={`min-w-0 flex-1 truncate ${selected ? "text-ink" : "text-muted"}`}>
          {selected?.label ?? placeholder}
        </span>
        <Icon
          name="expand_more"
          size={16}
          className={`shrink-0 text-muted transition-transform duration-150 ${open ? "rotate-180 text-accent" : ""}`}
        />
      </button>

      {open &&
        pos &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            id={listboxId}
            role="listbox"
            data-select-popover="true"
            aria-label={ariaLabel ?? "Options"}
            className="scroll-thin fixed z-[9999] max-h-[280px] overflow-y-auto rounded-xl border border-[var(--border-strong)] bg-[var(--surface-card)] p-1.5 text-[13px] text-ink shadow-[var(--card-shadow-hover)] backdrop-blur-md"
            style={{
              left: pos.left,
              width: pos.width,
              top: pos.top,
              bottom: pos.bottom,
            }}
          >
            {options.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-muted">No options</div>
            ) : (
              grouped.map((g, gi) => (
                <div key={`${g.group ?? "default"}-${gi}`} className={gi > 0 ? "mt-1 border-t border-[var(--border-hairline)] pt-1" : ""}>
                  {g.group && (
                    <div className="px-2.5 py-1 text-[12px] font-semibold text-muted">{g.group}</div>
                  )}
                  {g.items.map(({ opt, idx }) => {
                    const isSelected = opt.value === value;
                    const isActive = idx === cursor;
                    return (
                      <button
                        key={`${opt.value}-${idx}`}
                        type="button"
                        role="option"
                        data-opt-idx={idx}
                        aria-selected={isSelected}
                        disabled={opt.disabled}
                        onMouseEnter={() => !opt.disabled && setCursor(idx)}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          commit(idx);
                        }}
                        className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                          isSelected
                            ? "bg-[color-mix(in_srgb,var(--accent)_15%,transparent)] font-semibold text-ink"
                            : isActive
                              ? "bg-cream-2 text-ink"
                              : "font-normal text-ink hover:bg-cream-2"
                        }`}
                      >
                        <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                        {isSelected && <Icon name="check" size={15} className="shrink-0 text-accent" />}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
