// The agent-forms catalog in the UI matches the one HQ checks forms against (src/data/form-catalog.json, written by
// `pnpm gen:types` from the Rust table): same components, same properties, same required ones.
// Run: npx tsx scripts/form-catalog-test.ts
import assert from "node:assert/strict";
import catalog from "../src/data/form-catalog.json" with { type: "json" };
import { FORM_APIS } from "../src/ui/decisions/formApis";

type Entry = { properties: Record<string, unknown>; required: string[] };
const components = catalog.components as Record<string, Entry>;

assert.deepEqual(Object.keys(FORM_APIS).sort(), Object.keys(components).sort(), "same components");
for (const [name, schema] of Object.entries(FORM_APIS)) {
  const entry = components[name];
  const props = Object.keys(schema.shape).sort();
  assert.deepEqual(props, Object.keys(entry.properties).filter((p) => p !== "component").sort(), `${name}: same properties`);
  const required = props.filter((p) => !schema.shape[p as keyof typeof schema.shape].isOptional());
  assert.deepEqual(required, entry.required.filter((p) => p !== "component").sort(), `${name}: same required properties`);
}
console.log(`✓ ${Object.keys(FORM_APIS).length} components match src/data/form-catalog.json`);
