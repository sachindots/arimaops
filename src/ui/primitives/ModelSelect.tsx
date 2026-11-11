import { useEffect, useState } from "react";
import { CLI_MODELS, type AgentCli } from "../../data/types";
import { useOffice } from "../../store/office";

const CUSTOM_SENTINEL = "__custom__";

export function ModelSelect({
  cli,
  value,
  onChange,
  className = "input",
  ariaLabel = "Model",
  compact = false,
  account,
}: {
  cli: AgentCli;
  value: string;
  onChange: (model: string) => void;
  className?: string;
  ariaLabel?: string;
  compact?: boolean;
  account?: string;
}) {
  const apiAccount = useOffice((s) => s.snap?.accounts?.list.find((a) => a.id === account));
  const live = useOffice((s) => s.live);
  const [catalog, setCatalog] = useState<string[]>([]);
  const [catalogError, setCatalogError] = useState("");
  useEffect(() => {
    setCatalog([]); setCatalogError("");
    if (!apiAccount || !live) return;
    const controller = new AbortController();
    void fetch(`/api/models/account?account=${encodeURIComponent(apiAccount.id)}&cli=${cli}`, { signal: controller.signal }).then(async (r) => {
      const data = await r.json() as { models?: string[]; error?: string };
      if (!r.ok || !data.models) throw new Error(data.error ?? "Catalog unavailable");
      setCatalog(data.models);
    }).catch((e: unknown) => { if (!controller.signal.aborted) setCatalogError(e instanceof Error ? e.message : "Catalog unavailable"); });
    return () => controller.abort();
  }, [apiAccount?.id, apiAccount?.provider, apiAccount?.secret?.updatedAt, cli, live]);
  const presets = apiAccount ? catalog : CLI_MODELS[cli] ?? [];
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
          title={catalogError || (apiAccount ? "Use a model ID from the selected API account's catalog." : "Availability is checked by the signed-in CLI.")}
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

  return (<div>
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
    {catalogError && <p role="status" className="text-[11px] text-red">{catalogError}</p>}
  </div>);
}
