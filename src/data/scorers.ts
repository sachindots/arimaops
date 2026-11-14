// SPDX-License-Identifier: AGPL-3.0-or-later
// Scorers (docs/factory.md section 4): checks run on every finished task. Rules are free and exact; model checks ask
// Haiku and run only with memory extraction on. A score never blocks a task (gates do that); it's a signal.

import type { TeamTemplate } from "./model";

export const SCORERS = {
  "files-outside-task": { kind: "rule", label: "Stayed in its files", about: "The PR or deliverable touched only the files the task names (when it names any)." },
  "tests-only-added": { kind: "rule", label: "Code and tests together", about: "A PR doesn't change tests without code, or code without tests." },
  "claim-without-citation": { kind: "rule", label: "Every claim cited", about: "Each claim line in a claims or report file cites a source as [S…]." },
  "unmarked-draft": { kind: "rule", label: "Drafts marked", about: 'Every draft says "DRAFT: not sent".' },
  "finding-without-evidence": { kind: "rule", label: "Findings have evidence", about: "Every finding carries a request, response, command, output or file, not only prose." },
  "summary-matches-work": { kind: "model", label: "Summary matches the work", about: "The handoff summary claims nothing the diff or deliverable doesn't show." },
  "redundant-tests": { kind: "model", label: "No redundant tests", about: "The tests added check something new, not the same thing twice." },
} as const;

export type ScorerId = keyof typeof SCORERS;
export const SCORER_IDS = Object.keys(SCORERS) as ScorerId[];
export const isScorerId = (x: unknown): x is ScorerId => typeof x === "string" && x in SCORERS;

/** One scorer's verdict on one task. */
export interface TaskScore {
  scorer: ScorerId;
  pass: boolean;
  reason: string;
  /** Model checks: dollars where priced. */
  costUsd: number | null;
}

/** The template's own list, or one that fits what the template does. */
export function scorersFor(t: TeamTemplate): ScorerId[] {
  if (t.scorers) return t.scorers.filter(isScorerId);
  const gates = t.flow.stages.flatMap((s) => s.gates.map((g) => g.kind));
  const pr = gates.includes("pr-merged");
  const research = t.memoryTypes.includes("Source") || t.memoryTypes.includes("Claim");
  return [
    "files-outside-task",
    ...(pr ? (["tests-only-added"] as const) : []),
    ...(research ? (["claim-without-citation"] as const) : []),
    ...(t.rules.outbound === "drafts-only" ? (["unmarked-draft"] as const) : []),
    ...(t.rules.findings ? (["finding-without-evidence"] as const) : []),
    "summary-matches-work",
    ...(pr ? (["redundant-tests"] as const) : []),
  ];
}
