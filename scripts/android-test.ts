// Run: npx tsx scripts/android-test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const classes = mkdtempSync(join(tmpdir(), "arima-android-"));
try {
  execFileSync("javac", ["-d", classes, "android/app/src/main/java/com/arimaops/app/ServerUrl.java", "android/test/com/arimaops/app/ServerUrlTest.java"], { stdio: "inherit" });
  execFileSync("java", ["-ea", "-cp", classes, "com.arimaops.app.ServerUrlTest"], { stdio: "inherit" });
} finally {
  rmSync(classes, { recursive: true, force: true });
}

Object.defineProperty(globalThis, "window", { value: { matchMedia: () => ({ matches: true, addEventListener() {} }) } });
const { useUi } = await import("../src/store/ui");
const { closeTopPanel } = await import("../src/lib/native");
useUi.setState({ setupOpen: true, settings: { tab: "team" }, drawer: { kind: "prs" } });
assert.equal(closeTopPanel(), true);
assert.equal(useUi.getState().setupOpen, false);
assert.ok(useUi.getState().settings);
assert.ok(useUi.getState().drawer);
assert.equal(closeTopPanel(), true);
assert.equal(useUi.getState().settings, null);
assert.ok(useUi.getState().drawer);
assert.equal(closeTopPanel(), true);
assert.equal(useUi.getState().drawer, null);
assert.equal(closeTopPanel(), false);
console.log("Android Back closes setup, settings, drawer, then falls through");
