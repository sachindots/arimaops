// SPDX-License-Identifier: AGPL-3.0-or-later
// The Marketing and Sales launch templates (docs/templates.md section 6). Data only. Both are drafts only
// (rules.outbound): agents write, the owner sends by hand. That's enforced outside the role text: mail, social and
// CRM hosts are denied (src/data/outbound.ts), such MCP servers aren't attached, and the last gate is the owner's
// outbound approval, which the lead can never pass on the owner's behalf.

import type { Role, TeamTemplate, ToolRules } from "./model";

const role = (r: Omit<Role, "isLead" | "fallback" | "onDemand" | "seats"> & Partial<Pick<Role, "isLead" | "fallback" | "onDemand" | "seats">>): Role => ({
  isLead: false,
  fallback: null,
  onDemand: true,
  seats: 1,
  ...r,
});

const RULES: ToolRules = { findings: false, plans: false, scopeRequired: false, labMode: false, outbound: "drafts-only", egress: [] };

const DRAFTS_ONLY = `## Drafts only
- You never send, post, schedule or publish. Mail, social and CRM services are blocked in this project; don't look for a way around it.
- Deliver drafts as files (deliverables/…), marked "DRAFT: not sent". The owner reads, edits and sends them by hand.
- No invented facts, testimonials, numbers or urgency. Every claim has a source.`;

const lead = (roleMd: string, skills: string[]): Role =>
  role({ id: "lead", title: "Lead", isLead: true, onDemand: false, roleMd, cli: "claude", model: "claude-opus-5-5", fallback: { cli: "codex", model: "gpt-6.1-sol" }, skills, color: "#ffd600" });

// ---------------------------------------------------------------- Marketing

export const MARKETING_TEMPLATE: TeamTemplate = {
  id: "marketing",
  version: 1,
  name: "Marketing",
  description: "Campaigns from a Jobs-to-be-Done brief: copywriters draft, an editor from another maker checks each draft against the brief, and you approve and send. Drafts only, enforced.",
  roles: [
    lead(
      `You lead marketing work. You write the brief, assign the drafts and keep them on message. You don't write the copy yourself.

## The flow you run
- **Brief:** for each campaign, write deliverables/brief.md with the jtbd-brief skill. Ask the owner what you can't find out.
- **Drafts:** copywriters draft each piece; the editor checks it against the brief and accepts it.
- **Owner approval:** the owner reads the accepted drafts and sends them. Only the owner can pass this gate.

${DRAFTS_ONLY}`,
      ["jtbd-brief", "executive-briefing"],
    ),
    role({
      id: "copywriter",
      title: "Copywriter",
      roleMd: `You draft emails, posts and pages from the brief, with variants to choose from.\n\n${DRAFTS_ONLY}`,
      cli: "claude",
      model: "claude-sonnet-5-5",
      fallback: { cli: "codex", model: "gpt-6.1-sol" },
      skills: ["copywriting", "jtbd-brief"],
      seats: 2,
      color: "#ff4081",
    }),
    role({
      id: "editor",
      title: "Editor",
      roleMd: `You check drafts against the brief. You are deliberately a different model from the copywriters.

## How you work
- Does it carry the brief's one message to its audience, answer the anxieties, and stay inside "Not saying"?
- Is every claim backed by a source? Anything invented, overstated or off-brand fails.
- Accept with record_gate on the task's "edited" gate, or send it back with each problem.

${DRAFTS_ONLY}`,
      cli: "agy",
      model: "gemini-4-argon-high",
      skills: ["copywriting", "fact-checking"],
      color: "#00e5ff",
    }),
  ],
  flow: {
    stages: [
      { id: "brief", name: "JTBD brief", roleIds: ["lead"], gates: [] },
      {
        id: "drafts",
        name: "Drafts",
        roleIds: ["copywriter"],
        gates: [
          { id: "delivered", kind: "file-delivered" },
          { id: "edited", kind: "reviewer", roleId: "editor" },
        ],
      },
      { id: "approval", name: "Owner approval", roleIds: ["lead"], gates: [{ id: "send-ok", kind: "owner-approval", reason: "outbound" }] },
    ],
  },
  starter: { boards: [{ id: "B1", title: "Campaigns", status: "active", order: 0 }], tasks: [] },
  rules: RULES,
  memoryTypes: ["Audience", "Campaign"],
};

// ---------------------------------------------------------------- Sales

export const SALES_TEMPLATE: TeamTemplate = {
  id: "sales",
  version: 1,
  name: "Sales",
  description: "Accounts qualified with MEDDICC from public sources, then outreach drafts the lead checks, then you approve and send. Drafts only, enforced.",
  roles: [
    lead(
      `You lead sales work. You pick the accounts, review the qualification and the outreach. You don't research or write the outreach yourself.

## The flow you run
- **Qualification:** researchers qualify each account with MEDDICC from public, professional sources. An account with no identified pain isn't ready: say so.
- **Outreach drafts:** the writer drafts outreach that speaks to that account's pain. You check each draft against its qualification and accept it.
- **Owner approval:** the owner reads the drafts and sends them. Only the owner can pass this gate.

${DRAFTS_ONLY}`,
      ["meddicc-qualification", "executive-briefing"],
    ),
    role({
      id: "researcher",
      title: "Account researcher",
      roleMd: `You qualify accounts with MEDDICC, one file per account, from public, professional sources only. No personal data beyond name, role and work context.\n\n${DRAFTS_ONLY}`,
      cli: "agy",
      model: "gemini-4-argon-high",
      skills: ["meddicc-qualification", "deep-research"],
      seats: 2,
      color: "#00e5ff",
    }),
    role({
      id: "writer",
      title: "Outreach writer",
      roleMd: `You draft outreach for qualified accounts: short, specific to the account's pain and metrics, one clear ask. Never mass templates with the name swapped.\n\n${DRAFTS_ONLY}`,
      cli: "claude",
      model: "claude-sonnet-5-5",
      fallback: { cli: "codex", model: "gpt-6.1-sol" },
      skills: ["copywriting", "meddicc-qualification"],
      color: "#ff9100",
    }),
  ],
  flow: {
    stages: [
      { id: "qualify", name: "MEDDICC qualification", roleIds: ["lead", "researcher"], gates: [] },
      {
        id: "outreach",
        name: "Outreach drafts",
        roleIds: ["writer"],
        gates: [
          { id: "delivered", kind: "file-delivered" },
          { id: "checked", kind: "reviewer", roleId: "lead" },
        ],
      },
      { id: "approval", name: "Owner approval", roleIds: ["lead"], gates: [{ id: "send-ok", kind: "owner-approval", reason: "outbound" }] },
    ],
  },
  starter: { boards: [{ id: "B1", title: "Accounts", status: "active", order: 0 }], tasks: [] },
  rules: RULES,
  memoryTypes: ["Lead", "Account"],
};
