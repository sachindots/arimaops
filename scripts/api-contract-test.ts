// Contract check: every REST `/api/...` path called by UI code under `src/` (outside `src/data/mock/`)
// must have a matching `.route(...)` handler in the Rust HQ HTTP router.
// Run: npx tsx scripts/api-contract-test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "mock" && dir.endsWith(path.join("src", "data"))) continue;
      walkTs(full, out);
    } else if ((entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

function normalizePath(raw: string): string[] {
  const clean = (raw.split("?")[0] ?? raw).replace(/\$\{(?:qs|query)[^}]*$/, "");
  const expanded =
    clean.endsWith("${path}") || clean.endsWith("${suffix}")
      ? [clean.replace(/\$\{(?:path|suffix)\}$/, ""), clean.replace(/\$\{(?:path|suffix)\}$/, "/{param}")]
      : [clean];
  return expanded.map((p) => {
    const withParams = p
      .replace(/\$\{[^}]+\}/g, "{param}")
      .replace(/\{[^}]+\}/g, "{param}")
      .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "{param}");
    const compact = withParams.replace(/\/+/g, "/").replace(/\/+$/, "");
    return compact || "/";
  });
}

function extractUiApiPaths(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const pattern = /(['"`])(\/api\/[^'"`\n]*)/g;
  for (const file of walkTs(path.join(REPO, "src"))) {
    const rel = path.relative(REPO, file);
    const cleaned = stripComments(fs.readFileSync(file, "utf8"));
    for (const m of cleaned.matchAll(pattern)) {
      const lit = m[2];
      if (!lit) continue;
      for (const norm of normalizePath(lit)) {
        const list = found.get(norm) ?? [];
        if (!list.includes(rel)) list.push(rel);
        found.set(norm, list);
      }
    }
  }
  return found;
}

function extractRustRoutes(): Set<string> {
  const routesSrc = fs.readFileSync(
    path.join(REPO, "server-rs", "crates", "arima-server", "src", "routes.rs"),
    "utf8",
  );
  const routes = new Set<string>();
  const pattern = /\.route\(\s*"(\/api\/[^"]+)"/g;
  for (const m of routesSrc.matchAll(pattern)) {
    for (const norm of normalizePath(m[1])) {
      routes.add(norm);
    }
  }
  return routes;
}

const uiPaths = extractUiApiPaths();
const rustRoutes = extractRustRoutes();
assert.ok(uiPaths.size > 10, `expected UI to call >10 /api/ paths, found ${uiPaths.size}`);
assert.ok(rustRoutes.size > 20, `expected Rust routes.rs to register >20 /api/ routes, found ${rustRoutes.size}`);

const missing: string[] = [];
for (const [apiPath, files] of [...uiPaths.entries()].sort()) {
  if (!rustRoutes.has(apiPath)) {
    missing.push(`${apiPath} (called in ${files.join(", ")})`);
  }
}

assert.deepEqual(
  missing,
  [],
  `UI calls REST /api/ routes not implemented in routes.rs:\n  - ${missing.join("\n  - ")}`,
);

console.log(`✓ All ${uiPaths.size} UI REST /api/ paths match Rust routes.rs (${rustRoutes.size} routes)`);
