import { useEffect, useState } from "react";
import { CLI_MODELS, type AgentCli } from "../../data/types";
import { useOffice } from "../../store/office";
import { FREE_SOURCE_INFO } from "../../data/freeModels";
import { Select, type SelectOption } from "./Select";

const CUSTOM_SENTINEL = "__custom__";

export function ModelSelect({
  cli,
  value,
  onChange,
  className = "field",
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
  const freeList = useOffice((s) => s.snap?.freeModels?.models);
  const free = cli === "opencode" && !apiAccount ? (freeList ?? []) : [];
  const freeIds = new Set(free.map((m) => m.id));
  const presets = apiAccount ? catalog : [...free.map((m) => m.id), ...(CLI_MODELS[cli] ?? []).filter((m) => !freeIds.has(m))];
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
          className="btn px-2 py-1 text-[12px]"
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

  const options: SelectOption[] = [
    { value: "", label: "CLI Default" },
    ...free.map((m) => ({
      value: m.id,
      label: `${m.name} · free · ${FREE_SOURCE_INFO[m.source].label}`,
      group: "Free (rotates; HQ swaps if removed)",
    })),
    ...presets
      .filter((m) => !freeIds.has(m))
      .map((m) => ({
        value: m,
        label: m,
        group: free.length > 0 ? "Models" : undefined,
      })),
    { value: CUSTOM_SENTINEL, label: "Custom model ID…", group: free.length > 0 ? "Other" : undefined },
  ];

  return (
    <div>
      <Select
        className={className === "field" ? "" : className}
        size={compact ? "sm" : "md"}
        value={isCustomValue ? CUSTOM_SENTINEL : value}
        aria-label={ariaLabel}
        options={options}
        onChange={(next) => {
          if (next === CUSTOM_SENTINEL) {
            setCustomMode(true);
            return;
          }
          onChange(next);
        }}
      />
      {catalogError && <p role="status" className="text-[12px] text-red">{catalogError}</p>}
    </div>
  );
}
