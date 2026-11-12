// SPDX-License-Identifier: AGPL-3.0-or-later
// The open-core seam (docs/core-model.md section 10). Paid features live in ee/, which exports a
// plain map of features; the core loads it by dynamic import only when the folder is there, and
// never imports it otherwise. A feature starts only for a valid licence that lists it.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LicenseCheck, LicensePayload } from "./license";

export interface FeatureContext {
  license: LicensePayload;
  log: (msg: string) => void;
}

export type FeatureSetup = (ctx: FeatureContext) => void | Promise<void>;

/** What ee/ exports. */
export interface EeModule {
  features: Record<string, FeatureSetup>;
}

/** ee/'s features, or none when this install has no ee/ (built: dist-server/ee.mjs; from source: ee/index.ts). */
export async function loadEe(here = dirname(fileURLToPath(import.meta.url))): Promise<Record<string, FeatureSetup>> {
  const entry = [join(here, "ee.mjs"), join(here, "..", "ee", "index.ts")].find((f) => existsSync(f));
  if (!entry) return {};
  const mod = (await import(pathToFileURL(entry).href)) as Partial<EeModule>;
  return mod.features ?? {};
}

export interface FeatureReport {
  started: string[];
  skipped: { name: string; why: string }[];
}

/** Starts each feature the licence allows; the rest are skipped with the reason. A feature that fails doesn't stop the others. */
export async function startFeatures(features: Record<string, FeatureSetup>, check: LicenseCheck, log: (msg: string) => void): Promise<FeatureReport> {
  const report: FeatureReport = { started: [], skipped: [] };
  for (const [name, setup] of Object.entries(features)) {
    if (!check.ok) {
      report.skipped.push({ name, why: check.why });
      continue;
    }
    if (!check.license.features.includes(name)) {
      report.skipped.push({ name, why: `The licence for ${check.license.licensee} doesn't include ${name}.` });
      continue;
    }
    try {
      await setup({ license: check.license, log });
      report.started.push(name);
    } catch (err) {
      report.skipped.push({ name, why: `Failed to start: ${err instanceof Error ? err.message : err}` });
    }
  }
  return report;
}
