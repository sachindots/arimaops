// SPDX-License-Identifier: AGPL-3.0-or-later
// The built-in team templates (docs/core-model.md section 3). Data only: the Phase 4 launch
// templates are added here the same way. Bump a template's version whenever its content changes.

import type { Role, TeamTemplate } from "./model";
import { SECURITY_BLUE_TEMPLATE, SECURITY_PURPLE_TEMPLATE, SECURITY_RED_TEMPLATE } from "./securityTemplates";

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

/** Dev v1 (build → review): what Phase 1–3 projects were made from. Kept for them and for tests; no longer offered. */
export const DEV_TEMPLATE_V1: TeamTemplate = {
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

const SECOND_OPINION_MD = `You give second opinions. You are deliberately a different model from the one that wrote the change, so you catch what it can't see in its own work.

## How you work
- HQ or the lead sends you a task in review with its PR. Read the diff, the task and its spec items, then run what you can.
- Look first for what the author's model tends to miss: wrong assumptions about inputs, missing auth or validation checks, error paths, races, and anything the tests don't exercise.
- Record your verdict with record_gate on the task's second-opinion gate: "passed" with what you checked, or "failed" with each problem, a concrete case that breaks it and the smallest fix.
- Don't rewrite the change yourself. Don't repeat the reviewer's points; add what they didn't cover.

## How you talk
Short and specific: file, line, the input that breaks it, the fix.`;

const SPEC_LEAD_MD = `${LEAD_MD}

## The flow you run
- **Spec:** before any code, write the board's spec with write_spec, one numbered requirement per line (S1., S2.…). The owner approves it once for the whole board in Action items.
- **Plan:** cut the spec into small tasks, each naming the spec items it covers (specItems). The analyze gate lets tasks into Build only when every item has a task.
- **Build:** assign tasks to the developer role; HQ picks the seat and starts it. A task leaves Build when its PR changes a test and CI is green.
- **Review:** the reviewer and you review the PR. High-stakes tasks (auth, money, secrets, migrations, CI; or ones you mark highStakes) also get a second opinion from the Gemini seat; HQ asks it when such a task goes into review.
- **Merge:** you merge in the order you set, or the owner does if they keep that.`;

/**
 * Dev v2 (docs/templates.md section 3): spec → plan → build → review → merge. The library copy; projects made from
 * v1 keep theirs until re-synced on purpose.
 */
export const DEV_TEMPLATE: TeamTemplate = {
  id: "dev",
  version: 2,
  name: "Dev team",
  description: "Spec-driven: the lead writes the spec and you approve it, tasks cover every spec item, each task is one branch and one PR with tests and green CI, reviewed (plus a second opinion from another model on high-stakes work), then merged.",
  roles: [
    lead({ roleMd: SPEC_LEAD_MD }),
    {
      ...DEV_TEMPLATE_V1.roles[1],
      skills: [...DEV_TEMPLATE_V1.roles[1].skills, "trailofbits/skills@property-based-testing"],
    },
    {
      ...DEV_TEMPLATE_V1.roles[2],
      skills: [
        ...DEV_TEMPLATE_V1.roles[2].skills,
        "cloudflare/security-audit-skill@security-audit",
        "trailofbits/skills@differential-review",
        "trailofbits/skills@sharp-edges",
        "trailofbits/skills@supply-chain-risk-auditor",
      ],
    },
    {
      id: "second-opinion",
      title: "Second opinion",
      isLead: false,
      roleMd: SECOND_OPINION_MD,
      cli: "agy",
      model: "gemini-4-argon-high",
      fallback: null,
      skills: ["pstack-thermo-review", "trailofbits/skills@differential-review"],
      onDemand: true,
      seats: 1,
      color: "#448aff",
    },
  ],
  flow: {
    stages: [
      { id: "spec", name: "Spec", roleIds: ["lead"], gates: [{ id: "spec-ok", kind: "spec-approved" }] },
      { id: "plan", name: "Plan", roleIds: ["lead"], gates: [{ id: "covered", kind: "analyze" }] },
      { id: "build", name: "Build", roleIds: ["developer"], gates: [{ id: "tests", kind: "tests-ci" }] },
      {
        id: "review",
        name: "Review",
        roleIds: ["reviewer", "lead", "second-opinion"],
        gates: [
          { id: "reviewed", kind: "reviewer" },
          { id: "second", kind: "second-opinion", when: "high-stakes" },
        ],
      },
      { id: "merge", name: "Merge", roleIds: ["lead"], gates: [{ id: "merged", kind: "pr-merged" }] },
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

export const BUILTIN_TEMPLATES: readonly TeamTemplate[] = [DEV_TEMPLATE, SECURITY_RED_TEMPLATE, SECURITY_PURPLE_TEMPLATE, SECURITY_BLUE_TEMPLATE, BLANK_TEMPLATE];
