// SPDX-License-Identifier: AGPL-3.0-or-later
// Projects made before templates (docs/core-model.md section 9). They open read-only: no new
// starts, assignments or edits. Agents already running keep running, and can be stopped,
// answered and watched. This is the only module that knows the old project types.

import { join } from "node:path";
import type { Finding, ToolRules } from "../src/data/model";
import type { FindingStatus, HqConfig, Severity } from "../src/data/types";
import { readDoc } from "./lib/docs";
import { repoDirOf } from "./paths";

/** What an old project type meant, as tool rules. */
export function legacyRules(type: unknown): ToolRules {
  return {
    findings: type === "security",
    plans: type === "ops",
    scopeRequired: type === "security",
    labMode: false,
    outbound: "none",
    egress: [],
  };
}

export const isReadOnly = (cfg: Pick<HqConfig, "template">) => !cfg.template;

/** Commands a read-only project still takes: they watch, answer or stop what is already running. */
export const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "sendTerminalInput",
  "resizeTerminal",
  "openShell",
  "closeShell",
  "openHostShell",
  "closeHostShell",
  "openWorkspace",
  "inspectWorkspace",
  "stopAgent",
  "sendMessage",
  "resolveActionItem",
  "resolveAccess",
  "answerApproval",
  "recheckSetup",
  "refreshSbx",
  "refreshMcp",
]);

/** The findings a pre-template project saved (findings.json row), in today's shape, for reading only. */
export function legacyFindings(repoRoot: string, projectId: string): Finding[] {
  type Old = { id: string; title: string; severity: Severity; target: string; description: string; evidence: string; remediation: string; status: FindingStatus; reporterId: string; taskId: string | null; at: string; updatedAt: string };
  const old = readDoc<Old[]>(join(repoDirOf(repoRoot), "findings.json")) ?? [];
  return old.map((o) => ({
    id: o.id, projectId, taskId: o.taskId, reporterId: o.reporterId, title: o.title,
    asset: { kind: /^https?:\/\//i.test(o.target) ? "url" : "host", value: o.target }, location: null,
    cvss: null, severity: o.severity, ssvc: null, cwe: [], attack: [], d3fend: [], wstg: null,
    description: o.description, impact: "", remediation: o.remediation, evidence: o.evidence ? [{ kind: "note", content: o.evidence }] : [],
    verified: false, verifiedBy: null, status: o.status, at: o.at, updatedAt: o.updatedAt,
  }));
}
