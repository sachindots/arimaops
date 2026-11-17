import { useEffect, useRef, useState } from "react";
import { MAX_TEMPLATE_BYTES } from "../../data/templateFile";
import { officeActions, useOffice } from "../../store/office";

/** "Import a template…": reads a template file and sends it to HQ; shows HQ's answer below. */
export function TemplateImport({ onImported }: { onImported?: (id: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const result = useOffice((s) => s.templateImport);
  const [waiting, setWaiting] = useState(false);
  const [local, setLocal] = useState<string | null>(null);
  const shown = waiting && result ? result : null;
  const importedId = shown?.ok ? shown.id : undefined;
  useEffect(() => {
    if (importedId) onImported?.(importedId);
  }, [importedId]); // eslint-disable-line react-hooks/exhaustive-deps -- once per import, not per parent render

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setLocal(null);
    if (file.size > MAX_TEMPLATE_BYTES) return setLocal(`${file.name} is over ${MAX_TEMPLATE_BYTES / 1024} KB: not a template file.`);
    setWaiting(true);
    officeActions.importTemplate(await file.text());
    if (input.current) input.current.value = "";
  };

  return (
    <div className="flex flex-col gap-1">
      <input ref={input} type="file" accept=".json,application/json" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />
      <button type="button" className="btn self-start px-2 text-[12px]" onClick={() => input.current?.click()}>
        Import a template…
      </button>
      {local && <span className="text-[12px] text-red">{local}</span>}
      {waiting && !result && <span className="text-[12px] text-muted">Checking the template and its skill packs…</span>}
      {shown && (
        <span className={`text-[12px] ${shown.ok ? "text-green" : "text-red"}`} role="status">
          {shown.message}
        </span>
      )}
    </div>
  );
}
