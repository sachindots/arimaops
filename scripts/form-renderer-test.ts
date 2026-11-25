import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SafeMarkdown } from "../src/ui/decisions/SafeMarkdown";
import { FormSurfaceView } from "../src/ui/decisions/formCatalog";
import {
  extractCreateSurface,
  getPointer,
  parsePointer,
  resolveActionContext,
  resolveValue,
  setPointer,
} from "../src/ui/decisions/formPointers";

assert.deepEqual(parsePointer("/a/b~1c/d~0e"), ["a", "b/c", "d~e"]);
assert.equal(parsePointer("relative/path"), null);
assert.equal(parsePointer("/__proto__/polluted"), null);
assert.equal(parsePointer("/nested/constructor"), null);

const initial = { intro: "Hello", bucket: "", region: "eu-west", used: 38 };
const updated = setPointer(initial, "/bucket", "team-docs");
assert.equal(getPointer(updated, "/bucket"), "team-docs");
assert.equal(
  JSON.stringify(updated),
  '{"intro":"Hello","bucket":"team-docs","region":"eu-west","used":38}',
  "setPointer preserves key insertion order",
);

const missingTarget = setPointer(initial, "/nested/item", "v1");
assert.equal(getPointer(missingTarget, "/nested/item"), "v1");
assert.equal(resolveValue({ "@path": "/bucket" }, updated), "team-docs");

const ctx = resolveActionContext({ bucket: { "@path": "/bucket" }, empty: { "@path": "/missing" }, tag: "v1" }, updated);
assert.deepEqual(ctx, { bucket: "team-docs", empty: null, tag: "v1" });

const env = extractCreateSurface({
  version: "1.0",
  createSurface: {
    surfaceId: "dec-1",
    catalogId: "arimaops:forms/1",
    components: [{ id: "root", component: "Column", children: [] }],
    dataModel: { k: "v" },
  },
});
assert.equal(env?.surfaceId, "dec-1");
assert.deepEqual(env?.dataModel, { k: "v" });

const mdHtml = renderToStaticMarkup(createElement(SafeMarkdown, { markdown: "Hello <script>alert(1)</script> **world**" }));
assert.ok(!mdHtml.includes("<script>"), "SafeMarkdown must not emit raw <script> tags");
assert.ok(mdHtml.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "script text is HTML-escaped");
assert.ok(mdHtml.includes("<strong"), "bold spans render");

const surfaceHtml = renderToStaticMarkup(
  createElement(FormSurfaceView, {
    components: [
      { id: "root", component: "Column", children: ["md", "kv", "cmd", "go"] },
      { id: "md", component: "Markdown", text: "<script>alert(1)</script> **safe**" },
      { id: "kv", component: "KeyValue", rows: [{ label: "Tool", value: "bash" }] },
      { id: "cmd", component: "Code", label: "Command", code: "ls -la" },
      { id: "go", component: "ButtonRow", buttons: [{ label: "Approve", variant: "primary", action: { event: { name: "approve" } } }] },
    ],
    data: {},
    locked: false,
    onBindChange: () => {},
    onButtonAction: () => {},
  }),
);
assert.ok(!surfaceHtml.includes("<script>"), "Markdown component inside FormSurfaceView keeps script inert");
assert.ok(surfaceHtml.includes("Tool") && surfaceHtml.includes("bash"), "KeyValue component renders rows");
assert.ok(surfaceHtml.includes("Command") && surfaceHtml.includes("ls -la"), "Code component renders block");

console.log("✓ A2UI v1.0 own renderer & catalog checks passed");
