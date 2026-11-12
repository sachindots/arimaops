// SPDX-License-Identifier: AGPL-3.0-or-later
// Projects made before templates (docs/core-model.md section 9). They open read-only: no new
// starts, assignments or edits. Agents already running keep running, and can be stopped,
// answered and watched. This is the only module that knows the old project types.

import type { ToolRules } from "../src/data/model";
import type { HqConfig } from "../src/data/types";

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
