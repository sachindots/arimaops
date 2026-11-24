// PackReviewBody shows inline diffs only for primary changes and renders collapsed summaries for other shipped files.
// Run: npx tsx scripts/pack-review-test.ts
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DecisionPayload } from "../src/data/generated";

Object.assign(globalThis, {
  location: { href: "http://localhost/", search: "", pathname: "/", origin: "http://localhost" },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
});

const { formatBytes, lineDiff, PackReviewBody } = await import("../src/ui/decisions/PackReviewBody");

type PackReview = Extract<DecisionPayload, { kind: "pack-review" }>;

// 1. formatBytes
assert.equal(formatBytes(0), "0 B");
assert.equal(formatBytes(512), "512 B");
assert.equal(formatBytes(1536), "1.5 KB");
assert.equal(formatBytes(25 * 1024), "25 KB");

// 2. lineDiff
assert.deepEqual(lineDiff("a\nb", "a\nc"), [
  { op: " ", text: "a" },
  { op: "+", text: "c" },
  { op: "-", text: "b" },
]);

// 3. PackReviewBody renders primary files inline and other shipped files as collapsed rows (path, size, scan result).
const payload: PackReview = {
  pack: "google/egm:egm",
  from: null,
  to: "abcdef1234567890abcdef1234567890abcdef12",
  fromTree: null,
  toTree: "1111111111111111111111111111111111111111111111111111111111111111",
  changed: [
    { kind: "file", name: "skills/egm-review/SKILL.md", before: null, after: "# Review\nRead ../../resources/rules.md" },
    { kind: "file", name: "resources/rules.md", before: null, after: "Keep it simple." },
  ],
  otherFiles: [
    { path: "docs/guide.md", change: "added", bytes: 4200, scan: "clean", findings: 0 },
    { path: "site/index.html", change: "changed", bytes: 18432, scan: "warn", findings: 2 },
    { path: ".github/workflows/ci.yml", change: "added", bytes: 640, scan: "block", findings: 1 },
  ],
  agents: [
    {
      path: "agents/zoom_out.md",
      name: "egm-zoom-out",
      description: "Simplicity reviewer for recent diffs.",
      droppedFields: ["tools", "hooks"],
      sha256: "2222222222222222222222222222222222222222222222222222222222222222",
    },
    {
      path: "agents/helper.md",
      name: "helper",
      description: "Checks style details.",
      droppedFields: [],
      sha256: "3333333333333333333333333333333333333333333333333333333333333333",
    },
  ],
  egress: [],
  secrets: [],
  ignored: [],
  findings: ["block .github/workflows/ci.yml:1 blocked"],
  roles: [],
};

const html = renderToStaticMarkup(
  React.createElement(PackReviewBody, {
    decisionId: "dec-pack-1",
    projectId: "proj-1",
    payload,
    roles: [],
  }),
);

assert.ok(html.includes("skills/egm-review/SKILL.md"), "primary skill file shown");
assert.ok(html.includes("Keep it simple."), "primary resource diff shown inline");
assert.ok(html.includes("Other shipped files (3)"), "collapsed section header with count");
assert.ok(html.includes("docs/guide.md") && html.includes("4.1 KB") && html.includes("clean"), "collapsed clean row");
assert.ok(html.includes("site/index.html") && html.includes("18 KB") && html.includes("2 warn"), "collapsed warn row");
assert.ok(html.includes(".github/workflows/ci.yml") && html.includes("640 B") && html.includes("1 block"), "collapsed block row");
assert.ok(html.includes('aria-expanded="false"'), "other files start collapsed");
assert.ok(html.includes("Sub-agents (2)"), "sub-agents section header with count");
assert.ok(html.includes("registered: name, description, instructions"), "whitelist disclosure shown");
assert.ok(html.includes("egm-zoom-out") && html.includes("Simplicity reviewer for recent diffs."), "agent name and description shown");
assert.ok(html.includes("dropped: tools, hooks"), "dropped frontmatter fields listed");
assert.ok(html.includes("helper") && !html.includes("helperdropped"), "clean agent without extra dropped line");

console.log("✓ PackReviewBody unit tests passed");
