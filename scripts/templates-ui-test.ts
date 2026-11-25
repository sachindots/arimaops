// Validates built-in team templates shipped to the UI and embedded in arima-server.
// Run: npx tsx scripts/templates-ui-test.ts
import assert from "node:assert/strict";
import { templateErrors } from "../src/data/model";
import { BUILTIN_TEMPLATES } from "../src/data/templates";

assert.ok(BUILTIN_TEMPLATES.length > 0, "expected built-in team templates");
for (const tpl of BUILTIN_TEMPLATES) {
  const errs = templateErrors(tpl);
  assert.deepEqual(errs, [], `built-in "${tpl.id}" invalid: ${errs.join(" | ")}`);
}

console.log(`✓ All ${BUILTIN_TEMPLATES.length} built-in team templates are valid`);
