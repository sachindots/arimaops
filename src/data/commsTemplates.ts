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
  role({ id: "lead", title: "Lead", isLead: true, onDemand: false, roleMd, cli: "claude", model: "claude-opus-5-5", fallback: { cli: "codex", model: "gpt-6.1-sol" }, skills, color: "#d29922" });

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
      color: "#818cf8",
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
      color: "#818cf8",
    }),
    role({
      id: "writer",
      title: "Outreach writer",
      roleMd: `You draft outreach for qualified accounts: short, specific to the account's pain and metrics, one clear ask. Never mass templates with the name swapped.\n\n${DRAFTS_ONLY}`,
      cli: "claude",
      model: "claude-sonnet-5-5",
      fallback: { cli: "codex", model: "gpt-6.1-sol" },
      skills: ["copywriting", "meddicc-qualification"],
      color: "#d29922",
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

// ---------------------------------------------------------------- Startup

const STARTUP_DRAFTS = `## Drafts only
- Your role can't send, post or write to a CRM: mail, social and CRM services are blocked for your seat. Don't look for a way around it.
- Deliver drafts as files (deliverables/…), marked "DRAFT: not sent". The owner reads, edits and sends them by hand.
- No invented facts, quotes, numbers or urgency. Every claim has a source.`;

/**
 * A small company's non-engineering team in one project: a chief of staff routes work by role, makers draft, the
 * lead reviews, and anything that goes outside the company or touches money waits for the owner. Marketing, sales
 * and support seats are drafts only per role; the designer and the analyst aren't (rules.outbound "none").
 * Engineering stays in a Dev project; the lead files work there (create_project_task when cross-project is on).
 */
export const STARTUP_TEMPLATE: TeamTemplate = {
  id: "startup",
  version: 1,
  name: "Startup",
  description: "A chief of staff and five makers (design, marketing, sales, support, ops and finance) working to your goals, with a Monday plan, a Friday retro and a monthly numbers review. Outbound roles only draft; you send.",
  roles: [
    lead(
      `You are the chief of staff. You turn the owner's goals into work, route each task to the role that fits, review what comes back, and keep the owner informed. You don't do the makers' work yourself.

## How you run the week
- **Triage:** every request becomes a task with a goal (goalId), an owner role and a clear done-when. Assign by role: design, marketing, sales, support, ops and finance.
- **Review:** check each deliverable against its done-when before accepting it. Ask a second maker when it touches their area.
- **The owner decides:** mark a task highStakes when it goes to anyone outside the company (a message, a post, a page, a reply to a customer) or changes money, prices or terms. Those wait for the owner's approval; the rest you accept yourself.
- **Engineering:** product and code work belongs in the engineering project. File it there, or ask the owner to.
- **Rituals:** HQ hands you the Monday plan, the Friday retro and the monthly numbers review. Keep each short and send the result to the owner with send_message to "you".`,
      ["executive-briefing", "jtbd-brief"],
    ),
    role({
      id: "designer",
      title: "Designer",
      roleMd: "You design pages, screens and visuals from the task's brief: deliver files (deliverables/…) and a short note on the choices you made and what you left out.",
      cli: "claude",
      model: "claude-sonnet-5-5",
      fallback: { cli: "codex", model: "gpt-6.1-sol" },
      skills: ["frontend-design"],
      color: "#38bdf8",
    }),
    role({
      id: "marketer",
      title: "Marketer",
      roleMd: `You write briefs, campaigns, posts and pages that speak to the jobs customers hire the product for, with variants to choose from.\n\n${STARTUP_DRAFTS}`,
      cli: "claude",
      model: "claude-sonnet-5-5",
      fallback: { cli: "codex", model: "gpt-6.1-sol" },
      skills: ["jtbd-brief", "copywriting"],
      color: "#ff4081",
      outbound: "drafts-only",
    }),
    role({
      id: "sales",
      title: "Business development",
      roleMd: `You qualify accounts with MEDDICC from public, professional sources (one file per account) and draft outreach that speaks to each account's pain. No personal data beyond name, role and work context.\n\n${STARTUP_DRAFTS}`,
      cli: "agy",
      model: "gemini-4-argon-high",
      skills: ["meddicc-qualification", "deep-research"],
      color: "#d29922",
      outbound: "drafts-only",
    }),
    role({
      id: "support",
      title: "Support",
      roleMd: `You read the support exports and tickets the owner puts in the repo, draft replies, and turn repeated problems into bug reports with steps to reproduce for the engineering project. Never copy customers' personal data into memory or reports beyond what a fix needs.\n\n${STARTUP_DRAFTS}`,
      cli: "claude",
      model: "claude-sonnet-5-5",
      fallback: { cli: "codex", model: "gpt-6.1-sol" },
      skills: ["copywriting"],
      color: "#3fb950",
      outbound: "drafts-only",
    }),
    role({
      id: "analyst",
      title: "Ops and finance analyst",
      roleMd: "You turn exports and reports (revenue, spend, usage, funnel) into numbers the owner can act on: what changed, why, and what to do. Show your working; mark every estimate as one. Record goal numbers for the lead to log with update_goal.",
      cli: "codex",
      model: "gpt-6.1-sol",
      fallback: { cli: "claude", model: "claude-sonnet-5-5" },
      skills: ["data-analysis", "executive-briefing"],
      color: "#a371f7",
    }),
  ],
  flow: {
    stages: [
      { id: "triage", name: "Triage", roleIds: ["lead"], gates: [] },
      {
        id: "do",
        name: "Do",
        roleIds: ["designer", "marketer", "sales", "support", "analyst"],
        gates: [
          { id: "delivered", kind: "file-delivered" },
          { id: "reviewed", kind: "reviewer", roleId: "lead" },
        ],
      },
      { id: "approval", name: "Owner approval", roleIds: ["lead"], gates: [{ id: "owner-ok", kind: "owner-approval", reason: "outbound", when: "high-stakes" }] },
    ],
  },
  starter: { boards: [{ id: "B1", title: "This quarter", status: "active", order: 0 }], tasks: [] },
  rules: { findings: false, plans: false, scopeRequired: false, labMode: false, outbound: "none", egress: [] },
  memoryTypes: ["Customer", "Campaign", "Account", "Metric"],
  rituals: [
    { id: "monday-plan", title: "Monday plan", day: 1, hour: 9, prompt: "Plan the week against the goals (list_goals): what moves each goal this week, who does it, and what you need from the owner. Create or update the tasks, then send the owner a plan of at most ten lines." },
    { id: "friday-retro", title: "Friday retro", day: 5, hour: 16, prompt: "Look back at the week: what shipped, what slipped and why, and one change to how the team works. Ask each maker who worked this week for one line first. Send the owner the result in at most ten lines." },
    { id: "numbers-review", title: "Numbers review", day: 1, monthly: true, hour: 11, prompt: "Ask the analyst for last month's numbers from the latest exports in the repo, record each goal's number with update_goal, and send the owner what changed and what to do about it." },
  ],
};
