// SPDX-License-Identifier: AGPL-3.0-or-later
// The Research launch template (docs/templates.md section 5): sources first (a PRISMA-style log), then claims that
// cite them, a fact-check by a different model from the researchers', and a report signed off by a third maker.
// Data only. The paper APIs (arXiv, OpenAlex, Crossref) are on every seat's egress allowlist; any other host still
// goes through the usual per-host access request.

import type { Role, TeamTemplate } from "./model";

const role = (r: Omit<Role, "isLead" | "fallback" | "onDemand" | "seats"> & Partial<Pick<Role, "isLead" | "fallback" | "onDemand" | "seats">>): Role => ({
  isLead: false,
  fallback: null,
  onDemand: true,
  seats: 1,
  ...r,
});

const SOURCES = `## Sources
- Log every search in deliverables/sources.md (the paper-search skill shows the format): Q entries for searches, S entries for sources kept, X entries for sources dropped and why.
- Every claim cites its sources as [S7]. A claim without a source is not a finding: mark it unknown, or find one.
- Prefer primary sources (the paper, the dataset, the standard) over summaries of them. Note the date and version of anything that changes.`;

export const RESEARCH_TEMPLATE: TeamTemplate = {
  id: "research",
  version: 1,
  name: "Research",
  description: "A research team: sources logged first (PRISMA-style), claims that cite them, a fact-check by a different model, and a report signed off by a third. arXiv, OpenAlex and Crossref built in.",
  roles: [
    role({
      id: "lead",
      title: "Lead",
      isLead: true,
      onDemand: false,
      roleMd: `You lead a research project. You turn the owner's question into sub-questions, assign them, and write the report from checked claims. You don't research yourself.

## The flow you run
- **Sources:** each researcher searches for one sub-question and logs it. Agree the inclusion criteria first (dates, kinds of source, languages) and write them at the top of sources.md.
- **Claims:** researchers write claims (deliverables/claims.md, C1., C2.…), each citing its sources.
- **Fact-check:** the fact-checker checks every claim against its cited sources. A task leaves only when the fact-checker accepts it.
- **Report:** you write deliverables/report.md from accepted claims only, with what is still unknown. The second opinion signs it off.

${SOURCES}`,
      cli: "claude",
      model: "claude-opus-5-5",
      fallback: { cli: "codex", model: "gpt-6.1-sol" },
      skills: ["deep-research", "technical-writing", "paper-search"],
      color: "#d29922",
    }),
    role({
      id: "researcher",
      title: "Researcher",
      roleMd: `You research one sub-question at a time: search, read, log, and write claims that cite what you read. Report what the sources say, with their limits (sample size, date, who funded it), not what you expected.\n\n${SOURCES}`,
      cli: "agy",
      model: "gemini-4-argon-high",
      skills: ["deep-research", "paper-search", "data-analysis"],
      seats: 2,
      color: "#818cf8",
    }),
    role({
      id: "fact-checker",
      title: "Fact-checker",
      roleMd: `You check claims. You are deliberately a different model from the researchers.

## How you work
- For each claim: open every cited source and confirm it says what the claim says, no stronger. Confirm the source is real (Crossref for DOIs).
- A claim without a source, or whose source doesn't support it, fails: say which and why.
- Accept a task with record_gate on its "checked" gate only when every claim in it passes; otherwise send it back with the list.

${SOURCES}`,
      cli: "claude",
      model: "claude-sonnet-5-5",
      skills: ["fact-checking", "paper-search"],
      color: "#3fb950",
    }),
    role({
      id: "second-opinion",
      title: "Second opinion",
      roleMd: `You give the report a second opinion, as a third model from the researchers' and the fact-checker's. Read it against the claims and sources: nothing overstated, nothing missing, unknowns stated, every citation real. Record the second-opinion gate with record_gate: passed, or failed with each problem.\n\n${SOURCES}`,
      cli: "codex",
      model: "gpt-6.1-sol",
      skills: ["fact-checking"],
      color: "#58a6ff",
    }),
  ],
  flow: {
    stages: [
      { id: "sources", name: "Sources", roleIds: ["lead", "researcher"], gates: [] },
      { id: "claims", name: "Claims", roleIds: ["researcher"], gates: [] },
      { id: "factcheck", name: "Fact-check", roleIds: ["fact-checker"], gates: [{ id: "checked", kind: "reviewer", roleId: "fact-checker" }] },
      {
        id: "report",
        name: "Report",
        roleIds: ["lead", "researcher", "second-opinion"],
        gates: [
          { id: "delivered", kind: "file-delivered" },
          { id: "second", kind: "second-opinion", when: "always" },
        ],
      },
    ],
  },
  starter: { boards: [{ id: "B1", title: "Question", status: "active", order: 0 }], tasks: [] },
  rules: {
    findings: false,
    plans: false,
    scopeRequired: false,
    labMode: false,
    outbound: "none",
    egress: ["export.arxiv.org", "arxiv.org", "api.openalex.org", "api.crossref.org", "doi.org"],
  },
  memoryTypes: ["Source", "Claim"],
};
