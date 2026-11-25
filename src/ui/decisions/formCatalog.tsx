import { createContext, useContext, useId, type ReactNode } from "react";
import catalogJson from "../../data/form-catalog.json" with { type: "json" };
import { Meter, Sparkline } from "../kit";
import { Select } from "../primitives/Select";
import { OptionRow } from "./OptionRow";
import { isPathBinding, isPlainObject, resolveValue } from "./formPointers";
import { SafeMarkdown } from "./SafeMarkdown";

/** True once the form is answered, or for a viewer: every input is disabled and no button submits. */
export const FormLocked = createContext(false);

export const FORM_CATALOG_ID = catalogJson.catalogId;
const MAX_RENDER_DEPTH = 6;

export interface FormRenderCtx {
  byId: Map<string, Record<string, unknown>>;
  data: Record<string, unknown>;
  locked: boolean;
  onBindChange: (pointer: string, nextValue: unknown) => void;
  onButtonAction: (componentId: string, action: Record<string, unknown>) => void;
  renderId: (id: string, depth: number, visiting: Set<string>) => ReactNode;
}

const labelClass = "text-[13px] font-medium text-ink";
const asText = (v: unknown) => (v == null ? "" : String(v));
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

interface OptionItem {
  value: string;
  label: string;
  description?: string;
}

function asOptions(v: unknown): OptionItem[] {
  return asList(v).filter(
    (o): o is OptionItem => isPlainObject(o) && typeof o.value === "string" && typeof o.label === "string",
  );
}

function pointerOf(v: unknown): string | null {
  return isPathBinding(v) ? v["@path"] : null;
}

function a11yProps(c: Record<string, unknown>, data: Record<string, unknown>) {
  const raw = isPlainObject(c["@accessibility"]) ? c["@accessibility"] : null;
  if (!raw) return {};
  const label = raw.label !== undefined ? asText(resolveValue(raw.label, data)) : undefined;
  const live: "off" | "polite" | "assertive" | undefined =
    raw.live === "polite" || raw.live === "assertive" || raw.live === "off" ? raw.live : undefined;
  return { label, live };
}

function ColumnNode({
  c,
  depth,
  visiting,
  ctx,
}: {
  c: Record<string, unknown>;
  depth: number;
  visiting: Set<string>;
  ctx: FormRenderCtx;
}) {
  const children = asList(c.children).filter((id): id is string => typeof id === "string");
  return (
    <div className="flex w-full min-w-0 flex-col gap-3">
      {children.map((id) => (
        <div key={id} className="w-full min-w-0">
          {ctx.renderId(id, depth + 1, visiting)}
        </div>
      ))}
    </div>
  );
}

function TextNode({ c, ctx }: { c: Record<string, unknown>; ctx: FormRenderCtx }) {
  const text = asText(resolveValue(c.text, ctx.data));
  if (c.variant === "heading") {
    return <h4 className="m-0 text-[15px] font-semibold text-ink">{text}</h4>;
  }
  return (
    <p className={`m-0 whitespace-pre-wrap ${c.variant === "caption" ? "text-[12px] text-muted" : "text-[13px] text-ink"}`}>
      {text}
    </p>
  );
}

function MarkdownNode({ c, ctx }: { c: Record<string, unknown>; ctx: FormRenderCtx }) {
  return <SafeMarkdown markdown={asText(resolveValue(c.text, ctx.data))} />;
}

function KeyValueNode({ c, ctx }: { c: Record<string, unknown>; ctx: FormRenderCtx }) {
  const rows = asList(resolveValue(c.rows, ctx.data)).filter(
    (r): r is { label: string; value: string } => isPlainObject(r) && typeof r.label === "string" && typeof r.value === "string",
  );
  return (
    <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-card)] px-3 py-2.5 text-[13px]">
      {rows.map((r, i) => (
        <div key={i} className="contents">
          <dt className="font-medium text-muted">{r.label}</dt>
          <dd className="m-0 min-w-0 break-words text-ink">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function CodeNode({ c, ctx }: { c: Record<string, unknown>; ctx: FormRenderCtx }) {
  const code = asText(resolveValue(c.code, ctx.data));
  const label = typeof c.label === "string" && c.label.length > 0 ? c.label : null;
  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5">
      {label && <span className={labelClass}>{label}</span>}
      <pre className="m-0 overflow-x-auto whitespace-pre-wrap rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-card)] px-3 py-2 font-term text-[12px] leading-5 text-ink">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function TextFieldNode({ c, ctx }: { c: Record<string, unknown>; ctx: FormRenderCtx }) {
  const id = useId();
  const locked = useContext(FormLocked) || ctx.locked;
  const ptr = pointerOf(c.value);
  const value = asText(resolveValue(c.value, ctx.data));
  const fieldLabel = asText(c.label);
  const placeholder = typeof c.placeholder === "string" ? c.placeholder : undefined;
  const common = {
    id,
    className: "field w-full text-[13px]",
    value,
    placeholder,
    disabled: locked,
    onChange: (e: { target: { value: string } }) => {
      if (!locked && ptr) ctx.onBindChange(ptr, e.target.value);
    },
  };
  return (
    <div className="flex w-full flex-col gap-1.5">
      <label htmlFor={id} className={labelClass}>
        {fieldLabel}
      </label>
      {c.multiline ? <textarea rows={3} {...common} /> : <input {...common} />}
    </div>
  );
}

function SelectNode({ c, ctx }: { c: Record<string, unknown>; ctx: FormRenderCtx }) {
  const id = useId();
  const locked = useContext(FormLocked) || ctx.locked;
  const ptr = pointerOf(c.value);
  const value = asText(resolveValue(c.value, ctx.data));
  const fieldLabel = asText(c.label);
  const options = asOptions(c.options);
  return (
    <div className="flex w-full flex-col gap-1.5">
      <label htmlFor={id} className={labelClass}>
        {fieldLabel}
      </label>
      <Select
        id={id}
        aria-label={fieldLabel}
        value={value}
        onChange={(v) => {
          if (!locked && ptr) ctx.onBindChange(ptr, v);
        }}
        options={options}
        disabled={locked}
      />
    </div>
  );
}

function CheckListNode({ c, ctx }: { c: Record<string, unknown>; ctx: FormRenderCtx }) {
  const locked = useContext(FormLocked) || ctx.locked;
  const ptr = pointerOf(c.values);
  const picked = asList(resolveValue(c.values, ctx.data)).map(asText);
  const multi = !!c.multi;
  const options = asOptions(c.options);
  const toggle = (value: string) => {
    if (locked || !ptr) return;
    const next = multi ? (picked.includes(value) ? picked.filter((v) => v !== value) : [...picked, value]) : [value];
    ctx.onBindChange(ptr, next);
  };
  return (
    <fieldset className="m-0 flex w-full min-w-0 flex-col gap-1.5 border-0 p-0">
      <legend className={`${labelClass} mb-1.5 p-0`}>{asText(c.label)}</legend>
      {options.map((o) => (
        <OptionRow
          key={o.value}
          label={o.label}
          description={o.description}
          picked={picked.includes(o.value)}
          multi={multi}
          disabled={locked}
          onClick={() => toggle(o.value)}
        />
      ))}
    </fieldset>
  );
}

function TableNode({ c, ctx }: { c: Record<string, unknown>; ctx: FormRenderCtx }) {
  const columns = asList(c.columns).map(asText);
  const rows = asList(resolveValue(c.rows, ctx.data));
  return (
    <div className="w-full overflow-x-auto rounded-lg border border-[var(--border-hairline)]">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-[12px] text-muted">
            {columns.map((col, i) => (
              <th key={i} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t border-[var(--border-hairline)]">
              {asList(row).map((cell, j) => (
                <td key={j} className="px-3 py-2 text-ink whitespace-nowrap">
                  {asText(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ButtonRowNode({ c, ctx }: { c: Record<string, unknown>; ctx: FormRenderCtx }) {
  const locked = useContext(FormLocked) || ctx.locked;
  const componentId = asText(c.id);
  const buttons = asList(c.buttons).filter(isPlainObject);
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      {buttons.map((b, i) => (
        <button
          key={i}
          type="button"
          className={`btn text-[13px] ${b.variant === "primary" ? "btn-primary" : ""}`}
          disabled={locked}
          onClick={() => {
            if (!locked && isPlainObject(b.action)) {
              ctx.onButtonAction(componentId, b.action);
            }
          }}
        >
          {asText(b.label)}
        </button>
      ))}
    </div>
  );
}

function MeterNode({ c, ctx }: { c: Record<string, unknown>; ctx: FormRenderCtx }) {
  const fieldLabel = asText(c.label);
  const a11y = a11yProps(c, ctx.data);
  const value = Number(resolveValue(c.value, ctx.data)) || 0;
  const max = Number(resolveValue(c.max, ctx.data)) || 0;
  return (
    <div className="flex w-full flex-col gap-1.5" aria-live={a11y.live}>
      <div className="flex items-baseline justify-between gap-2">
        <span className={labelClass}>{fieldLabel}</span>
        <span className="text-[12px] text-muted">
          {value} / {max}
        </span>
      </div>
      <Meter label={a11y.label || fieldLabel} value={value} max={max} />
    </div>
  );
}

function ChartNode({ c, ctx }: { c: Record<string, unknown>; ctx: FormRenderCtx }) {
  const fieldLabel = asText(c.label);
  const points = asList(resolveValue(c.points, ctx.data)).map((p) => Number(p) || 0);
  return (
    <div className="flex w-full flex-col gap-1.5">
      <span className={labelClass}>{fieldLabel}</span>
      <Sparkline label={fieldLabel} data={points} width={240} height={48} />
    </div>
  );
}

export function renderFormNode(
  c: Record<string, unknown>,
  depth: number,
  visiting: Set<string>,
  ctx: FormRenderCtx,
): ReactNode {
  const name = asText(c.component);
  switch (name) {
    case "Column":
      return <ColumnNode c={c} depth={depth} visiting={visiting} ctx={ctx} />;
    case "Text":
      return <TextNode c={c} ctx={ctx} />;
    case "Markdown":
      return <MarkdownNode c={c} ctx={ctx} />;
    case "KeyValue":
      return <KeyValueNode c={c} ctx={ctx} />;
    case "Code":
      return <CodeNode c={c} ctx={ctx} />;
    case "TextField":
      return <TextFieldNode c={c} ctx={ctx} />;
    case "Select":
      return <SelectNode c={c} ctx={ctx} />;
    case "CheckList":
      return <CheckListNode c={c} ctx={ctx} />;
    case "Table":
      return <TableNode c={c} ctx={ctx} />;
    case "ButtonRow":
      return <ButtonRowNode c={c} ctx={ctx} />;
    case "Meter":
      return <MeterNode c={c} ctx={ctx} />;
    case "Chart":
      return <ChartNode c={c} ctx={ctx} />;
    default:
      return null;
  }
}

export function FormSurfaceView({
  components,
  data,
  locked,
  onBindChange,
  onButtonAction,
}: {
  components: Record<string, unknown>[];
  data: Record<string, unknown>;
  locked: boolean;
  onBindChange: (pointer: string, nextValue: unknown) => void;
  onButtonAction: (componentId: string, action: Record<string, unknown>) => void;
}) {
  const byId = new Map<string, Record<string, unknown>>();
  for (const c of components) {
    if (typeof c.id === "string" && typeof c.component === "string") {
      byId.set(c.id, c);
    }
  }
  const root = byId.get("root");
  if (!root) {
    return <p className="m-0 text-[13px] text-muted">This form can&apos;t be shown.</p>;
  }

  const ctx: FormRenderCtx = {
    byId,
    data,
    locked,
    onBindChange,
    onButtonAction,
    renderId(id, depth, visiting) {
      if (depth > MAX_RENDER_DEPTH || visiting.has(id)) return null;
      const node = byId.get(id);
      if (!node) return null;
      const next = new Set(visiting);
      next.add(id);
      return renderFormNode(node, depth, next, ctx);
    },
  };

  return <>{ctx.renderId("root", 1, new Set())}</>;
}
