import { z } from "zod";

// The agent-forms catalog's props, mirroring the Rust table that writes src/data/form-catalog.json
// (scripts/form-catalog-test.ts keeps the two equal). HQ has already checked every form against that table.
const pathRef = z.object({ "@path": z.string() });
const dynString = z.union([z.string(), pathRef]);
const dynNumber = z.union([z.number(), pathRef]);
const dynRows = z.union([z.array(z.array(z.union([z.string(), z.number()]))), pathRef]);
const dynPoints = z.union([z.array(z.number()), pathRef]);
const dynKeyValues = z.union([z.array(z.object({ label: z.string(), value: z.string() })), pathRef]);
const option = z.object({ value: z.string(), label: z.string(), description: z.string().optional() });
const action = z.object({
  event: z.object({ name: z.string(), context: z.record(z.string(), z.unknown()).optional() }),
});

export const FORM_APIS = {
  Column: z.object({ children: z.array(z.string()) }),
  Text: z.object({ text: dynString, variant: z.enum(["body", "heading", "caption"]).optional() }),
  TextField: z.object({
    label: z.string(),
    value: pathRef,
    placeholder: z.string().optional(),
    multiline: z.boolean().optional(),
  }),
  Select: z.object({ label: z.string(), options: z.array(option), value: pathRef }),
  CheckList: z.object({
    label: z.string(),
    options: z.array(option),
    values: pathRef,
    multi: z.boolean().optional(),
  }),
  Table: z.object({ columns: z.array(z.string()), rows: dynRows }),
  ButtonRow: z.object({
    buttons: z.array(
      z.object({ label: z.string(), variant: z.enum(["primary", "default"]).optional(), action }),
    ),
  }),
  Meter: z.object({ label: z.string(), value: dynNumber, max: dynNumber }),
  Chart: z.object({ label: z.string(), points: dynPoints }),
  Markdown: z.object({ text: dynString }),
  KeyValue: z.object({ rows: dynKeyValues }),
  Code: z.object({ code: dynString, label: z.string().optional() }),
};

export type FormComponentName = keyof typeof FORM_APIS;
