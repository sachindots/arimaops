import { useState } from "react";
import { CLI_MODELS, type AgentCli } from "../../data/types";

const CUSTOM_SENTINEL = "__custom__";

export function ModelSelect({
  cli,
  value,
  onChange,
  className = "input",
  ariaLabel = "Model",
  compact = false,
}: {
  cli: AgentCli;
  value: string;
  onChange: (model: string) => void;
  className?: string;
  ariaLabel?: string;
  compact?: boolean;
}) {
  const presets = CLI_MODELS[cli] ?? [];
  const isCustomValue = Boolean(value && !presets.includes(value));
  const [customMode, setCustomMode] = useState(isCustomValue);

  if (customMode) {
    return (
      <div className="flex items-center gap-1">
        <input
          className={`${className} font-mono ${compact ? "py-1 text-[12px]" : ""}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`Custom ${cli} model…`}
          aria-label={ariaLabel}
        />
        <button
          type="button"
          className="btn px-2 py-1 text-[11px]"
          title="Back to preset models"
          onClick={() => {
            setCustomMode(false);
            if (!presets.includes(value)) onChange(presets[0] ?? "");
          }}
        >
          List
        </button>
      </div>
    );
  }

  return (
    <select
      className={`${className} font-mono ${compact ? "py-1 text-[12px]" : ""}`}
      value={isCustomValue ? CUSTOM_SENTINEL : value}
      aria-label={ariaLabel}
      onChange={(e) => {
        const next = e.target.value;
        if (next === CUSTOM_SENTINEL) {
          setCustomMode(true);
          return;
        }
        onChange(next);
      }}
    >
      <option value="">CLI Default</option>
      {presets.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
      <option value={CUSTOM_SENTINEL}>Custom model ID…</option>
    </select>
  );
}
