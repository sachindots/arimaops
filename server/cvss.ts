// SPDX-License-Identifier: AGPL-3.0-or-later
// CVSS 4.0 scores with FIRST's lookup tables (ae-cvss-calculator, Apache-2.0). HQ computes the
// score itself from the vector, so an agent can't claim one.

import * as lib from "ae-cvss-calculator";
import type { Severity } from "../src/data/types";

// A CommonJS package: ES-module loaders put its exports under default, CommonJS loaders don't.
const { Cvss4P0 } = ((lib as { default?: typeof lib }).default ?? lib) as typeof lib;

const PREFIX = "CVSS:4.0/";

/** The vector as the library writes it and its score. Throws on anything but a complete CVSS 4.0 base vector. */
export function scoreCvss4(raw: string): { vector: string; score: number } {
  const v = raw.trim();
  if (!v.startsWith(PREFIX)) throw new Error(`Use a CVSS 4.0 vector starting with ${PREFIX} (got "${v.slice(0, 40)}").`);
  let c: InstanceType<typeof Cvss4P0>;
  try {
    c = new Cvss4P0(v);
  } catch (e) {
    throw new Error(`Not a valid CVSS 4.0 vector: ${e instanceof Error ? e.message : e}.`);
  }
  if (!c.isBaseFullyDefined()) throw new Error("The CVSS 4.0 vector needs every base metric: AV, AC, AT, PR, UI, VC, VI, VA, SC, SI, SA.");
  return { vector: v, score: c.calculateScores().overall };
}

/** FIRST's qualitative rating; "None" (0.0) is HQ's "info". */
export function severityOf(score: number): Severity {
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  if (score >= 0.1) return "low";
  return "info";
}
