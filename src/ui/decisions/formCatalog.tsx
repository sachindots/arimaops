import { createContext, useContext, useId } from "react";
import { createComponentImplementation, type ReactCatalogComponent } from "@a2ui/react";
import { Catalog } from "@a2ui/web_core";
import catalogJson from "../../data/form-catalog.json";
import { Meter, Sparkline } from "../kit";
import { Select } from "../primitives/Select";
import { FORM_APIS as A } from "./formApis";
import { OptionRow } from "./OptionRow";

/** True once the form is answered, or for a viewer: every input is disabled and no button submits. */
export const FormLocked = createContext(false);

const label = "text-[13px] font-medium text-ink";
const asText = (v: unknown) => (v == null ? "" : String(v));
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const Column = createComponentImplementation({ name: "Column", schema: A.Column }, ({ props, buildChild }) => (
  <div className="flex w-full min-w-0 flex-col gap-3">
    {props.children?.map((c) => (typeof c === "string" ? buildChild(c) : buildChild(c.id, c.basePath)))}
  </div>
));

const Text = createComponentImplementation({ name: "Text", schema: A.Text }, ({ props }) =>
  props.variant === "heading" ? (
    <h4 className="m-0 text-[15px] font-semibold text-ink">{asText(props.text)}</h4>
  ) : (
    <p className={`m-0 whitespace-pre-wrap ${props.variant === "caption" ? "text-[12px] text-muted" : "text-[13px] text-ink"}`}>{asText(props.text)}</p>
  ),
);

const TextField = createComponentImplementation({ name: "TextField", schema: A.TextField }, ({ props, accessibilityRef }) => {
  const id = useId();
  const locked = useContext(FormLocked);
  const common = {
    id,
    ref: accessibilityRef,
    className: "field w-full text-[13px]",
    value: asText(props.value),
    placeholder: props.placeholder,
    disabled: locked,
    onChange: (e: { target: { value: string } }) => props.setValue(e.target.value),
  };
  return (
    <div className="flex w-full flex-col gap-1.5">
      <label htmlFor={id} className={label}>
        {props.label}
      </label>
      {props.multiline ? <textarea rows={3} {...common} /> : <input {...common} />}
    </div>
  );
});

const FormSelect = createComponentImplementation({ name: "Select", schema: A.Select }, ({ props }) => {
  const id = useId();
  const locked = useContext(FormLocked);
  return (
    <div className="flex w-full flex-col gap-1.5">
      <label htmlFor={id} className={label}>
        {props.label}
      </label>
      <Select id={id} aria-label={props.label} value={asText(props.value)} onChange={(v) => props.setValue(v)} options={props.options} disabled={locked} />
    </div>
  );
});

const CheckList = createComponentImplementation({ name: "CheckList", schema: A.CheckList }, ({ props }) => {
  const locked = useContext(FormLocked);
  const picked = asList(props.values).map(asText);
  const toggle = (value: string) =>
    props.setValues(props.multi ? (picked.includes(value) ? picked.filter((v) => v !== value) : [...picked, value]) : [value]);
  return (
    <fieldset className="m-0 flex w-full min-w-0 flex-col gap-1.5 border-0 p-0">
      <legend className={`${label} mb-1.5 p-0`}>{props.label}</legend>
      {props.options.map((o) => (
        <OptionRow key={o.value} label={o.label} description={o.description} picked={picked.includes(o.value)} multi={!!props.multi} disabled={locked} onClick={() => toggle(o.value)} />
      ))}
    </fieldset>
  );
});

const Table = createComponentImplementation({ name: "Table", schema: A.Table }, ({ props }) => (
  <div className="w-full overflow-x-auto rounded-lg border border-[var(--border-hairline)]">
    <table className="w-full text-[13px]">
      <thead>
        <tr className="text-left text-[12px] text-muted">
          {props.columns.map((c, i) => (
            <th key={i} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {asList(props.rows).map((row, i) => (
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
));

const ButtonRow = createComponentImplementation({ name: "ButtonRow", schema: A.ButtonRow }, ({ props }) => {
  const locked = useContext(FormLocked);
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      {props.buttons.map((b, i) => (
        <button key={i} type="button" className={`btn text-[13px] ${b.variant === "primary" ? "btn-primary" : ""}`} disabled={locked} onClick={() => b.action()}>
          {b.label}
        </button>
      ))}
    </div>
  );
});

const FormMeter = createComponentImplementation({ name: "Meter", schema: A.Meter }, ({ props }) => (
  <div className="flex w-full flex-col gap-1.5">
    <div className="flex items-baseline justify-between gap-2">
      <span className={label}>{props.label}</span>
      <span className="text-[12px] text-muted">
        {asText(props.value)} / {asText(props.max)}
      </span>
    </div>
    <Meter label={props.label} value={Number(props.value) || 0} max={Number(props.max) || 0} />
  </div>
));

const Chart = createComponentImplementation({ name: "Chart", schema: A.Chart }, ({ props }) => (
  <div className="flex w-full flex-col gap-1.5">
    <span className={label}>{props.label}</span>
    <Sparkline label={props.label} data={asList(props.points).map(Number)} width={240} height={48} />
  </div>
));

export const FORM_CATALOG_ID = catalogJson.catalogId;

export const formCatalog = new Catalog<ReactCatalogComponent>(FORM_CATALOG_ID, "1.0", [
  Column,
  Text,
  TextField,
  FormSelect,
  CheckList,
  Table,
  ButtonRow,
  FormMeter,
  Chart,
]);
