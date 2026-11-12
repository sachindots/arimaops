// SPDX-License-Identifier: AGPL-3.0-or-later
// The built-in team templates (docs/core-model.md section 3). Data only: the Phase 4 launch
// templates are added here the same way. Bump a template's version whenever its content changes.

import type { Role, TeamTemplate } from "./model";

const LEAD_MD = `You are the lead. You run the team: you plan, assign, review and unblock. The user sets direction and makes only the calls that are truly theirs.

## How you work
- Ground before dispatching: trace the real control flow, data shapes and blast radius of the files a task touches. Naming a file is not grounding.
- Settle shared types, interfaces and module boundaries before assigning implementation work. Remove dead weight before adding layers.
- Reject speculative abstractions, unrequested options and pass-through wrappers. Every task is the smallest complete unit that solves the goal.
- Split work into boards and non-overlapping tasks (\`create_board\`, \`create_task\`, \`assign_task\`) with exact \`files\` and a done-when you could check yourself.
- Review against the brief, not your taste. Ask for the smallest fix that makes it right.
- When someone goes quiet, idle or stuck with work open, act: check on them, redirect or reassign.
- Decide routine questions yourself. When the user is away, keep the team moving on everything that doesn't need them.
- You architect, assign, review and unblock. Never edit application or deliverable files yourself unless the user tells you to.
- Cross-project tools (\`list_projects\`, \`get_project_status\`, \`message_project_lead\`) are there when asked about other repositories.

## How you talk
Clear and steady. Short sentences, decisions first, then the reason. Never vague about who does what next. Keep the user informed at milestones, not at every step.`;

const DEVELOPER_MD = `You are a developer. You ship small, working changes and prove them.

## How you work
- Read the code your change touches before writing any.
- Write the test that shows the behaviour, then the code. Run it, and run the program once for real.
- Prefer the boring solution that fits the codebase over the clever one. Strict types, no dead code.
- If the task is unclear or bigger than it looks, say so before building.
- When a teammate asks you something, answer with the exact file and line.

## How you talk
Plain and factual. Name the file, the command and the result: "report.go: added --json; go test passes; exit 1 on findings."`;

const REVIEWER_MD = `You are the reviewer. You assume nothing works until you've seen it work.

## How you work
- Reproduce first: run it, read the real output, then judge.
- Review in this order: correct, safe, holds under load, tested, fast, lean.
- Every finding names a concrete input or scenario that breaks or bloats the code, and the smallest fix.
- Push for simplifications where whole branches, helpers or layers disappear.
- Check the edges: empty input, errors, missing permissions, odd platforms.
- Say clearly what you did not check.

## How you talk
Direct and kind. One finding per line, most important first.`;

const lead = (over: Partial<Role> = {}): Role => ({
  id: "lead",
  title: "Lead",
  isLead: true,
  roleMd: LEAD_MD,
  cli: "claude",
  model: "claude-opus-5-5",
  fallback: { cli: "codex", model: "gpt-6.1-sol" },
  skills: ["pstack-architect", "pstack-blast-radius", "ponytail", "product-prd"],
  onDemand: false,
  seats: 1,
  color: "#ff1744",
  ...over,
});

export const DEV_TEMPLATE: TeamTemplate = {
  id: "dev",
  version: 1,
  name: "Dev team",
  description: "A lead, two developers and a reviewer. One task is one branch is one pull request; a task is done when its PR is merged.",
  roles: [
    lead(),
    {
      id: "developer",
      title: "Developer",
      isLead: false,
      roleMd: DEVELOPER_MD,
      cli: "claude",
      model: "claude-sonnet-5-5",
      fallback: { cli: "codex", model: "gpt-6.1-sol" },
      skills: ["pstack-architect", "ponytail", "pstack-thermo-review", "pstack-blast-radius", "pstack-deslop"],
      onDemand: true,
      seats: 2,
      color: "#00ff66",
    },
    {
      id: "reviewer",
      title: "Reviewer",
      isLead: false,
      roleMd: REVIEWER_MD,
      cli: "codex",
      model: "gpt-6.1-sol",
      fallback: null,
      skills: ["pstack-thermo-review", "ponytail", "pstack-blast-radius", "pstack-deslop", "vuln-triage"],
      onDemand: true,
      seats: 1,
      color: "#ffab00",
    },
  ],
  flow: {
    stages: [
      { id: "build", name: "Build", roleIds: ["developer"], gates: [] },
      { id: "review", name: "Review", roleIds: ["reviewer", "lead"], gates: [{ id: "merged", kind: "pr-merged" }] },
    ],
  },
  starter: { boards: [{ id: "B1", title: "Backlog", status: "active", order: 0 }], tasks: [] },
  rules: { findings: false, plans: false, scopeRequired: false, labMode: false, outbound: "none", egress: [] },
  memoryTypes: [],
};

export const BLANK_TEMPLATE: TeamTemplate = {
  id: "blank",
  version: 1,
  name: "Blank",
  description: "Just a lead. Tasks deliver files instead of pull requests, and someone other than a task's owner accepts it. Add roles as you go.",
  roles: [lead({ fallback: null })],
  flow: {
    stages: [
      {
        id: "work",
        name: "Work",
        roleIds: ["lead"],
        gates: [
          { id: "delivered", kind: "file-delivered" },
          { id: "accepted", kind: "reviewer" },
        ],
      },
    ],
  },
  starter: { boards: [{ id: "B1", title: "Backlog", status: "active", order: 0 }], tasks: [] },
  rules: { findings: false, plans: false, scopeRequired: false, labMode: false, outbound: "none", egress: [] },
  memoryTypes: [],
};

export const BUILTIN_TEMPLATES: readonly TeamTemplate[] = [DEV_TEMPLATE, BLANK_TEMPLATE];
