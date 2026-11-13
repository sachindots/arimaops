// SPDX-License-Identifier: AGPL-3.0-or-later
// The security launch templates (docs/templates.md section 4): Red (PTES), Purple (Red plus a detection check per
// finding) and Blue (NIST SP 800-61). Data only. All three need a scope before anyone but the lead starts (lab mode
// lifts it), agents submit a plan before changing a system, findings are scored CVSS 4.0 + SSVC, and the report needs
// a second opinion from another maker's model. Offensive skills (BugHunter) reach agents only once a scope is set.

import type { Role, Stage, TeamTemplate, ToolRules } from "./model";

const BH = "elementalsouls/Claude-BugHunter";
const TOB = "trailofbits/skills";

const RULES: ToolRules = { findings: true, plans: true, scopeRequired: true, labMode: false, outbound: "none", egress: [] };

const ENGAGEMENT = `## The engagement
- Only in-scope targets, ever. Out of scope always wins; when in doubt, ask the lead before touching anything.
- Before you change a system (a write, an exploit that alters state, a config change), submit_plan and wait for the owner.
- Every finding goes through report_finding with a CVSS 4.0 vector, SSVC, CWE, ATT&CK and evidence. Never fake evidence or overstate impact.
- Secrets you find are evidence: report where they are, never paste their values.`;

const role = (r: Omit<Role, "isLead" | "fallback" | "onDemand" | "seats"> & Partial<Pick<Role, "isLead" | "fallback" | "onDemand" | "seats">>): Role => ({
  isLead: false,
  fallback: null,
  onDemand: true,
  seats: 1,
  ...r,
});

const lead = (roleMd: string, skills: string[]): Role =>
  role({ id: "lead", title: "Lead", isLead: true, onDemand: false, roleMd, cli: "claude", model: "claude-opus-5-5", fallback: { cli: "codex", model: "gpt-6.1-sol" }, skills, color: "#ff1744" });

const secondOpinion = (): Role =>
  role({
    id: "second-opinion",
    title: "Second opinion",
    roleMd: `You give second opinions on findings and on the report. You are deliberately a different model from the one that wrote them.

## How you work
- Re-check each critical and high finding yourself: reproduce it from its evidence, within scope. Confirm it with update_finding verified, or say exactly why not.
- Read the report against the findings: severity matches the CVSS vector, nothing overstated, nothing missing, remediation that would actually work.
- Record the report's second-opinion gate with record_gate: passed, or failed with each problem.

${ENGAGEMENT}`,
    cli: "agy",
    model: "gemini-4-argon-high",
    skills: ["vuln-triage", `${TOB}@cvss-scoring`, `${TOB}@fp-check`],
    color: "#448aff",
  });

// ---------------------------------------------------------------- Red

const RED_LEAD = `You lead a red-team engagement (PTES). You plan, assign, review and keep the team inside scope. You don't attack anything yourself.

## The flow you run
- **Scope:** nothing starts until the owner sets the engagement scope (Settings → Project → Scope), or turns on lab mode for a CTF or practice range.
- Create each task in the phase it belongs to (create_task stageId: recon, threat, vuln, exploit, post, report), with the exact targets it may touch.
- **Recon → Threat model → Vulnerability analysis → Exploitation → Post-exploitation:** recon maps assets, you build the threat model with the recon findings, the exploit seats test and prove.
- **Report:** the reporter writes it from the findings (scored, with WSTG coverage for web targets). It passes when every critical and high finding is verified by a person or by a model from another maker, and the second opinion signs off.

${ENGAGEMENT}`;

const reconRole = (): Role =>
  role({
    id: "recon",
    title: "Recon",
    roleMd: `You map the attack surface: hosts, services, subdomains, technologies, exposed data, people-free (no personal data in findings or memory). Report assets and leads, not vulnerabilities you haven't tested.\n\n${ENGAGEMENT}`,
    cli: "agy",
    model: "gemini-4-argon-high",
    skills: ["osint-recon", `${BH}@recon-scope-triage`, `${BH}@web2-recon`, `${BH}@bb-methodology`],
    color: "#00e5ff",
  });

const exploitRole = (): Role =>
  role({
    id: "exploit",
    title: "Exploit",
    roleMd: `You find and prove vulnerabilities in scope. The smallest proof that shows impact; no damage, no persistence beyond what the task allows, clean up after.\n\n${ENGAGEMENT}`,
    cli: "claude",
    model: "claude-sonnet-5-5",
    fallback: { cli: "codex", model: "gpt-6.1-sol" },
    skills: ["red-team-poc", "vuln-triage", `${BH}@hunt-dispatch`, `${BH}@triage-validation`, `${BH}@evidence-hygiene`],
    seats: 2,
    color: "#ff9100",
  });

const reporterRole = (): Role =>
  role({
    id: "reporter",
    title: "Reporter",
    roleMd: `You write the engagement report from the findings: executive summary, scope, method, each finding with its CVSS 4.0 vector and SSVC decision, evidence and remediation, and WSTG coverage for web targets. Plain words, no overstatement.\n\n${ENGAGEMENT}`,
    cli: "claude",
    model: "claude-sonnet-5-5",
    skills: ["technical-writing", `${BH}@report-writing`, `${BH}@redteam-report-template`, `${TOB}@cvss-scoring`],
    color: "#b388ff",
  });

const redStages = (): Stage[] => [
  { id: "scope", name: "Scope", roleIds: ["lead"], gates: [{ id: "scoped", kind: "scope-set" }] },
  { id: "recon", name: "Recon", roleIds: ["recon"], gates: [] },
  { id: "threat", name: "Threat model", roleIds: ["lead", "recon"], gates: [] },
  { id: "vuln", name: "Vulnerability analysis", roleIds: ["exploit"], gates: [] },
  { id: "exploit", name: "Exploitation", roleIds: ["exploit"], gates: [] },
  { id: "post", name: "Post-exploitation", roleIds: ["exploit"], gates: [] },
  {
    id: "report",
    name: "Report",
    roleIds: ["reporter", "lead", "second-opinion"],
    gates: [
      { id: "report", kind: "findings-report" },
      { id: "second", kind: "second-opinion", when: "always" },
    ],
  },
];

export const SECURITY_RED_TEMPLATE: TeamTemplate = {
  id: "security-red",
  version: 1,
  name: "Security · Red",
  description: "A red-team engagement (PTES): scope first, then recon, threat model, vulnerability analysis, exploitation, post-exploitation and a scored report checked by a second model. In scope only; a plan before any change.",
  roles: [lead(RED_LEAD, ["threat-modeling", `${BH}@bb-methodology`, `${BH}@redteam-report-template`]), reconRole(), exploitRole(), reporterRole(), secondOpinion()],
  flow: { stages: redStages() },
  starter: { boards: [{ id: "B1", title: "Engagement", status: "active", order: 0 }], tasks: [] },
  rules: RULES,
  memoryTypes: ["Asset", "Finding", "Technique"],
};

// ---------------------------------------------------------------- Purple

const DEFENDER_SKILLS = ["soc-incident-response", "cloudflare/security-audit-skill@security-audit", `${TOB}@audit-context-building`, `${TOB}@semgrep`, `${TOB}@semgrep-rule-creator`, `${TOB}@variant-analysis`];

const defenderRole = (): Role =>
  role({
    id: "defender",
    title: "Defender",
    roleMd: `You turn each finding into defence. For every finding of an exploitation task: map it to ATT&CK and D3FEND (update_finding attack / d3fend), check whether today's detection would have caught it (an Atomic Red Team test where one exists), and write the detection or fix that would. Then accept the task with record_gate on its "detected" gate, saying what catches it now.\n\n${ENGAGEMENT}`,
    cli: "claude",
    model: "claude-sonnet-5-5",
    skills: DEFENDER_SKILLS,
    color: "#00c853",
  });

export const SECURITY_PURPLE_TEMPLATE: TeamTemplate = {
  ...SECURITY_RED_TEMPLATE,
  id: "security-purple",
  name: "Security · Purple",
  description: "Red's engagement plus defence: after exploitation, a defender maps each finding to ATT&CK and D3FEND and checks or writes the detection that catches it, before the report.",
  roles: [
    lead(`${RED_LEAD}\n\n## Purple\nAfter Exploitation each task goes to Detect: the defender maps its findings to ATT&CK ↔ D3FEND and checks the detection. A task leaves Detect only when the defender accepts it.`, ["threat-modeling", `${BH}@bb-methodology`, `${BH}@redteam-report-template`]),
    reconRole(),
    exploitRole(),
    defenderRole(),
    reporterRole(),
    secondOpinion(),
  ],
  flow: {
    stages: (() => {
      const s = redStages();
      const at = s.findIndex((x) => x.id === "exploit") + 1;
      s.splice(at, 0, { id: "detect", name: "Detect", roleIds: ["defender"], gates: [{ id: "detected", kind: "reviewer", roleId: "defender" }] });
      return s;
    })(),
  },
  memoryTypes: ["Asset", "Finding", "Technique", "Detection"],
};

// ---------------------------------------------------------------- Blue

const BLUE_LEAD = `You lead an incident response (NIST SP 800-61). You coordinate, decide and keep the record; you don't touch systems yourself.

## The flow you run
- **Prepare:** confirm the scope (the systems this response may touch), contacts and evidence handling. Nothing starts without a scope.
- **Detect & analyse:** the analysts establish what happened, when, how and how far, with evidence and a timeline. Findings are scored like any other.
- **Contain:** the responder proposes containment as a plan; the owner approves before anything is isolated, blocked or shut down. You can't approve this for them.
- **Eradicate & recover:** remove the cause, restore service, confirm it's clean.
- **Lessons learned:** what failed, what to change, written up from the findings and checked by a second model.

${ENGAGEMENT}`;

export const SECURITY_BLUE_TEMPLATE: TeamTemplate = {
  id: "security-blue",
  version: 1,
  name: "Security · Blue",
  description: "Incident response (NIST SP 800-61): prepare, detect and analyse, contain (only with your approval), eradicate and recover, lessons learned. A plan before every change.",
  roles: [
    lead(BLUE_LEAD, ["soc-incident-response", "threat-modeling"]),
    role({
      id: "analyst",
      title: "Analyst",
      roleMd: `You investigate: logs, alerts, binaries and code, to establish what happened with evidence. Build the timeline, find the root cause and every affected asset; report each as a finding.\n\n${ENGAGEMENT}`,
      cli: "claude",
      model: "claude-sonnet-5-5",
      fallback: { cli: "codex", model: "gpt-6.1-sol" },
      skills: [...DEFENDER_SKILLS, `${TOB}@entry-point-analyzer`, `${TOB}@fp-check`, `${TOB}@cvss-scoring`],
      seats: 2,
      color: "#00e5ff",
    }),
    role({
      id: "responder",
      title: "Responder",
      roleMd: `You contain, eradicate and recover. Every action on a system starts as a plan (submit_plan) and waits for the owner; containment always does. Record what you changed, so it can be undone.\n\n${ENGAGEMENT}`,
      cli: "claude",
      model: "claude-sonnet-5-5",
      skills: ["soc-incident-response"],
      color: "#ff9100",
    }),
    secondOpinion(),
  ],
  flow: {
    stages: [
      { id: "prepare", name: "Prepare", roleIds: ["lead"], gates: [{ id: "scoped", kind: "scope-set" }] },
      { id: "analyse", name: "Detect & analyse", roleIds: ["analyst"], gates: [] },
      { id: "contain", name: "Contain", roleIds: ["responder"], gates: [{ id: "contain-ok", kind: "owner-approval", reason: "containment" }] },
      { id: "recover", name: "Eradicate & recover", roleIds: ["responder"], gates: [] },
      {
        id: "lessons",
        name: "Lessons learned",
        roleIds: ["lead", "analyst", "second-opinion"],
        gates: [
          { id: "report", kind: "findings-report" },
          { id: "second", kind: "second-opinion", when: "always" },
        ],
      },
    ],
  },
  starter: { boards: [{ id: "B1", title: "Incident", status: "active", order: 0 }], tasks: [] },
  rules: RULES,
  memoryTypes: ["Incident", "Asset"],
};
