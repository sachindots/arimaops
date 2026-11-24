import { z } from "zod3";
import { CommonSchemas as S } from "@a2ui/web_core/v1_0";

// The agent-forms catalog's props, mirroring the Rust table that writes src/data/form-catalog.json
// (scripts/form-catalog-test.ts keeps the two equal). HQ has already checked every form against that table.
const option = z.object({ value: z.string(), label: z.string(), description: z.string().optional() });

export const FORM_APIS = {
  Column: z.object({ children: S.ChildList }),
  Text: z.object({ text: S.DynamicString, variant: z.enum(["body", "heading", "caption"]).optional() }),
  TextField: z.object({ label: z.string(), value: S.DynamicString, placeholder: z.string().optional(), multiline: z.boolean().optional() }),
  Select: z.object({ label: z.string(), options: z.array(option), value: S.DynamicString }),
  CheckList: z.object({ label: z.string(), options: z.array(option), values: S.DynamicStringList, multi: z.boolean().optional() }),
  Table: z.object({ columns: z.array(z.string()), rows: S.DynamicValue }),
  ButtonRow: z.object({
    buttons: z.array(z.object({ label: z.string(), variant: z.enum(["primary", "default"]).optional(), action: S.Action })),
  }),
  Meter: z.object({ label: z.string(), value: S.DynamicNumber, max: S.DynamicNumber }),
  Chart: z.object({ label: z.string(), points: S.DynamicValue }),
};

export type FormComponentName = keyof typeof FORM_APIS;
