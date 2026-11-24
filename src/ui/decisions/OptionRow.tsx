import type { ReactNode } from "react";
import { Icon } from "../deck/Icon";

/** One pickable option: a radio-style row, or a check-box row when `multi`. */
export function OptionRow({
  label,
  description,
  badge,
  picked,
  multi,
  disabled,
  onClick,
}: {
  label: string;
  description?: string | null;
  badge?: ReactNode;
  picked: boolean;
  multi: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={picked}
      onClick={onClick}
      className={`flex w-full cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-default ${
        picked
          ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]"
          : "border-[var(--border-hairline)] bg-[var(--surface-card)] hover:border-[var(--border-strong)] hover:bg-cream-2/60"
      }`}
    >
      <Icon
        name={multi ? (picked ? "check_box" : "check_box_outline_blank") : picked ? "radio_button_checked" : "radio_button_unchecked"}
        size={18}
        className={`mt-0.5 shrink-0 ${picked ? "text-accent" : "text-muted"}`}
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium text-ink">{label}</span>
          {badge}
        </span>
        {description && <span className="mt-0.5 block text-[12px] text-muted">{description}</span>}
      </span>
    </button>
  );
}
