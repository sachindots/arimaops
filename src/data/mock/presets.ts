import type { Finding, Role, Stage, TeamTemplate } from "../model";
import type { AgentConfig, Board, HqConfig, SandboxSettings, Task } from "../types";

export interface Preset {
  id: string;
  label: string;
  config: HqConfig;
  boards: Board[];
  tasks: Task[];
  /** PRs already merged before the session starts (numbered 1..n). */
  mergedPrs: number;
  /** Titles the lead uses when it tops up the active board. */
  taskPool: string[];
  questions: string[];
  leadQuestions: string[];
  /** Security demos: findings already reported when the session starts. */
  findings?: Finding[];
}

function finding(id: string, reporterId: string, title: string, severity: Finding["severity"], asset: string, hoursAgo: number, extra: Partial<Finding> = {}): Finding {
  const at = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  return {
    id, projectId: "redcell-ops", taskId: null, reporterId, title, asset: { kind: "url", value: asset }, location: null, cvss: null, severity, ssvc: null,
    cwe: [], attack: [], d3fend: [], wstg: null, description: "", impact: "", remediation: "", evidence: [], verified: false, verifiedBy: null,
    status: "open", at, updatedAt: at, ...extra,
  };
}

const sandbox = (extra: Partial<SandboxSettings> = {}): SandboxSettings => ({
  resources: { cpus: null, memoryGb: null },
  allow: ["registry.npmjs.org"],
  deny: [],
  ...extra,
});

function agent(
  id: string,
  name: string,
  role: string,
  color: string,
  opts: Partial<AgentConfig> = {},
): AgentConfig {
  const isLead = opts.isLead ?? false;
  return {
    id,
    name,
    role,
    isLead,
    cli: "claude",
    model: isLead ? "Opus" : "Sonnet",
    mode: "sandbox",
    color,
    roleId: role.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    skills: [],
    roleMd: `You are the team's ${role}.`,
    sandbox: sandbox(isLead ? {} : { allow: ["registry.npmjs.org", "console.instacloud.com"] }),
    workspacePath: null,
    ...opts,
  };
}

/** Demo projects get a template made from their own team: one role per role title, as its first agent has it. */
function demoConfig({ secure = false, ...cfg }: Omit<HqConfig, "template" | "rules"> & { secure?: boolean }): HqConfig {
  const roles: Role[] = [];
  for (const a of cfg.team)
    if (!roles.some((r) => r.id === a.roleId))
      roles.push({ id: a.roleId!, title: a.role, isLead: a.isLead, roleMd: a.roleMd, cli: a.cli, model: a.model, fallback: null, skills: [], onDemand: false, seats: 0, color: a.color });
  for (const r of roles) r.seats = cfg.team.filter((a) => a.roleId === r.id).length;
  const lead = roles.find((r) => r.isLead)?.id ?? roles[0].id;
  const workers = roles.filter((r) => !r.isLead).map((r) => r.id);
  const crew = workers.length ? workers : [lead];
  const stages: Stage[] = secure
    ? [
        { id: "scope", name: "Scope", roleIds: [lead], gates: [{ id: "scoped", kind: "scope-set" }] },
        { id: "recon", name: "Recon", roleIds: crew, gates: [] },
        { id: "build", name: "Exploit", roleIds: crew, gates: [{ id: "verified", kind: "reviewer" }, { id: "second", kind: "second-opinion", when: "high-stakes" }] },
        { id: "review", name: "Report", roleIds: [lead], gates: [{ id: "report", kind: "findings-report" }] },
      ]
    : [
        { id: "spec", name: "Spec", roleIds: [lead], gates: [{ id: "spec-ok", kind: "spec-approved" }] },
        { id: "plan", name: "Plan", roleIds: [lead], gates: [{ id: "covered", kind: "analyze" }] },
        { id: "build", name: "Build", roleIds: crew, gates: [{ id: "tests", kind: "tests-ci" }] },
        { id: "review", name: "Review", roleIds: [...crew, lead], gates: [{ id: "reviewed", kind: "reviewer" }, { id: "evidence", kind: "evidence" }] },
        { id: "merge", name: "Merge", roleIds: [lead], gates: [{ id: "merged", kind: "pr-merged" }] },
      ];
  const rules = { findings: secure, plans: false, scopeRequired: secure, labMode: false, outbound: "none" as const, egress: [] };
  const template: TeamTemplate = { id: "demo", version: 1, name: "Demo team", description: "", roles, flow: { stages }, starter: { boards: [], tasks: [] }, rules, memoryTypes: [] };
  return { ...cfg, template, rules };
}

function doneTasks(boardId: string, titles: [string, string][], startPr: number): Task[] {
  return titles.map(([title, ownerId], i) => ({
    id: `${boardId}-T${String(i + 1).padStart(2, "0")}`,
    boardId,
    title,
    ownerId,
    status: "done",
    needs: [],
    prNumber: startPr + i,
  }));
}

// ---------------------------------------------------------------- Askwell (3 agents)

const askwell: Preset = {
  id: "askwell",
  label: "Askwell · 3 agents",
  config: demoConfig({
    project: { id: "askwell", name: "Askwell", repo: "acme/askwell", path: "~/developer/askwell", hqPort: 7420 },
    team: [
      agent("michael", "Cipher", "Lead", "#f85149", { isLead: true, cli: "agy", model: "gemini-3.1-pro" }),
      agent("dwight", "Ghost", "Developer", "#3fb950", { cli: "claude" }),
      agent("jim", "Vortex", "Frontend", "#818cf8", { cli: "agy", model: "gemini-3-flash" }),
    ],
    workflow: {
      mode: "github-pr",
      review: { enabled: true, tool: "coderabbit", command: "" },
      merge: { by: "human" },
      deploy: { enabled: true, tool: "instacloud", command: "", perAgentEnvironments: true },
    },
  }),
  boards: [
    { id: "P0", title: "Phase 0 — Setup", status: "done", order: 0 },
    { id: "P1", title: "Phase 1 — Foundation", status: "done", order: 1 },
    { id: "P2", title: "Phase 2 — Projects + widget", status: "done", order: 2 },
    { id: "P3", title: "Phase 3 — Knowledge + chat", status: "active", order: 3 },
    { id: "P4", title: "Phase 4 — Conversations + analytics", status: "planned", order: 4 },
    { id: "P5", title: "Phase 5 — Billing + customize", status: "planned", order: 5 },
    { id: "P6", title: "Phase 6 — Harden + launch", status: "planned", order: 6 },
  ],
  tasks: [
    ...doneTasks("P0", [["Repo + CI", "dwight"], ["Shared contract", "jim"]], 1),
    ...doneTasks("P1", [["Auth with Clerk", "dwight"], ["Database schema", "jim"], ["App shell", "dwight"]], 3),
    ...doneTasks("P2", [["Projects CRUD", "jim"], ["Widget script tag", "dwight"], ["Widget bubble UI", "jim"], ["Embed settings", "dwight"], ["PostHog events", "jim"]], 6),
    { id: "P3-T01", boardId: "P3", title: "Knowledge upload", ownerId: "jim", status: "todo", needs: [], prNumber: null },
    { id: "P3-T02", boardId: "P3", title: "Chat route", ownerId: "dwight", status: "todo", needs: [], prNumber: null },
    { id: "P3-T03", boardId: "P3", title: "PDF text extraction", ownerId: "jim", status: "todo", needs: [], prNumber: null },
    { id: "P3-T04", boardId: "P3", title: "Rate limit", ownerId: "dwight", status: "todo", needs: [], prNumber: null },
    { id: "P3-T05", boardId: "P3", title: "Connect panel to chat", ownerId: "dwight", status: "todo", needs: ["P3-T02"], prNumber: null },
    { id: "P4-T01", boardId: "P4", title: "Conversation list", ownerId: null, status: "todo", needs: [], prNumber: null },
    { id: "P4-T02", boardId: "P4", title: "Cost per reply chart", ownerId: null, status: "todo", needs: [], prNumber: null },
  ],
  mergedPrs: 12,
  taskPool: [
    "Answer feedback", "Retry failed embeds", "Answer caching", "Source previews", "Streaming answers",
    "Citations UI", "Multi-file upload", "Embeddings backfill", "Health checks", "Prompt templates",
  ],
  questions: [
    "Max PDF size: 10 MB or 20 MB?",
    "Use pgvector or a hosted vector DB?",
    "OK to add a dependency: pdf-parse?",
    "Stream tokens over SSE or WebSockets?",
    "Run the migration on my DB branch?",
  ],
  leadQuestions: ["Approve the Phase 4 breakdown?", "Merge #{pr} before the other open PRs?"],
};

// ---------------------------------------------------------------- Cybersec & OSINT Cell (5 agents, Deliverables mode)

const redCell: Preset = {
  id: "red-cell",
  label: "RedCell · 5 agents (Cybersec)",
  config: demoConfig({
    project: {
      id: "redcell-ops", name: "RedCell Ops", repo: "arimaops/redcell-ops", path: "~/missions/redcell-ops", hqPort: 7420,
      scope: { inScope: ["*.staging.example.com", "api.example.com", "10.20.0.0/16"], outOfScope: ["pay.example.com"], rules: "Weekdays 09:00–18:00 IST. No DoS, max 5 req/s. Contact: the owner." },
    },
    secure: true,
    team: [
      agent("cipher", "Cipher", "Lead", "#f85149", { isLead: true, cli: "agy", model: "gemini-3.1-pro" }),
      agent("ghost", "Ghost", "OSINT Analyst", "#3fb950", { cli: "agy", model: "gemini-3-flash" }),
      agent("vortex", "Vortex", "Red Teamer", "#818cf8", { cli: "claude", model: "Sonnet" }),
      agent("nyx", "Nyx", "Security", "#a371f7", { cli: "codex", model: "gpt-5.4" }),
      agent("pulse", "Pulse", "SOC Analyst", "#db61a2", { cli: "opencode", model: "anthropic/claude-sonnet-4-6" }),
    ],
    workflow: {
      mode: "deliverables",
      review: { enabled: false, tool: "human", command: "" },
      merge: { by: "lead" },
      deploy: { enabled: false, tool: "custom", command: "", perAgentEnvironments: false },
    },
  }),
  boards: [
    { id: "REC", title: "Phase 1 — Recon & Attack Surface", status: "active", order: 0 },
    { id: "AUD", title: "Phase 2 — Exploit Validation & Triage", status: "active", order: 1 },
    { id: "DET", title: "Phase 3 — Detection & Hardening", status: "planned", order: 2 },
  ],
  tasks: [
    { id: "REC-T01", boardId: "REC", title: "Subdomain & API footprint dossier", ownerId: "ghost", status: "done", needs: [], prNumber: null, deliverablePath: "deliverables/REC-T01-footprint.md" },
    { id: "REC-T02", boardId: "REC", title: "STRIDE threat model for auth gateway", ownerId: "nyx", status: "todo", needs: [], prNumber: null },
    { id: "AUD-T01", boardId: "AUD", title: "JWT token confusion & SSRF PoC", ownerId: "vortex", status: "todo", needs: ["REC-T01"], prNumber: null },
    { id: "AUD-T02", boardId: "AUD", title: "Webhook signature bypass audit", ownerId: "nyx", status: "todo", needs: [], prNumber: null },
    { id: "DET-T01", boardId: "DET", title: "Sigma rules for credential stuffing", ownerId: "pulse", status: "todo", needs: [], prNumber: null },
  ],
  mergedPrs: 1,
  taskPool: [
    "Dependency CVE triage", "CSP & CORS header audit", "Sandbox egress policy review",
    "YARA rule for anomalous payloads", "Executive security briefing", "IAM privilege matrix",
  ],
  questions: [
    "Include staging subdomains in passive recon scope?",
    "Classify the SSRF vector as CRITICAL or HIGH?",
    "Target Sigma output for Elastic or Splunk?",
  ],
  leadQuestions: ["Approve the Phase 3 hardening runbook?", "Sign off on the executive threat brief?"],
  findings: [
    finding("F-001", "vortex", "SSRF in webhook preview fetches internal metadata", "critical", "https://api.example.com/v1/webhooks/preview", 5, {
      cvss: { vector: "CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:H/VA:N/SC:H/SI:L/SA:N", score: 9.3 }, cwe: ["CWE-918"], attack: ["T1190"], status: "confirmed", verified: true, verifiedBy: "cipher",
      description: "The preview endpoint fetches any URL the caller gives, including 169.254.169.254.", impact: "Cloud credentials of the API role can be read.", remediation: "Allow-list outbound hosts; block link-local and private ranges.",
      evidence: [{ kind: "request", content: "POST /v1/webhooks/preview\n{\"url\": \"http://169.254.169.254/latest/meta-data/iam/\"}" }],
    }),
    finding("F-002", "vortex", "JWT accepts alg=none on the legacy auth route", "high", "https://api.example.com/v0/session", 3, { cvss: { vector: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:L/VA:N/SC:N/SI:N/SA:N", score: 8.7 }, cwe: ["CWE-347"] }),
    finding("F-003", "nyx", "Webhook signatures compared with a non-constant-time check", "medium", "https://api.example.com/v1/webhooks", 26, { cwe: ["CWE-208"] }),
    finding("F-004", "ghost", "Staging admin panel exposed without SSO", "medium", "https://admin.staging.example.com", 30, { status: "confirmed" }),
    finding("F-005", "pulse", "Verbose stack traces on 500 responses", "low", "https://api.staging.example.com", 48),
    finding("F-006", "ghost", "Server banner reveals nginx version", "info", "https://www.staging.example.com", 50, { status: "false-positive" }),
  ],
};

// ---------------------------------------------------------------- Big team (7 agents)

const bigTeam: Preset = {
  id: "big-team",
  label: "Shipyard · 7 agents",
  config: demoConfig({
    project: { id: "shipyard", name: "Shipyard", repo: "acme/shipyard", path: "~/developer/shipyard", hqPort: 7420 },
    team: [
      agent("maya", "Cipher", "Lead", "#f85149", { isLead: true, cli: "agy", model: "gemini-3.1-pro" }),
      agent("dwight", "Ghost", "Developer", "#3fb950", { cli: "claude" }),
      agent("jim", "Vortex", "Architect", "#818cf8", { cli: "agy", model: "gemini-3.1-pro" }),
      agent("kenji", "Nyx", "Developer", "#a371f7", { cli: "codex", model: "gpt-5.4" }),
      agent("priya", "Pulse", "QA", "#db61a2", { cli: "opencode", model: "anthropic/claude-sonnet-4-6" }),
      agent("leo", "Zero", "Frontend", "#4fb3c4", { cli: "gemini", model: "gemini-3-flash" }),
      agent("sam", "Hex", "Docs", "#5271ff", { cli: "copilot", model: "claude-sonnet-4.6" }),
    ],
    workflow: {
      mode: "github-pr",
      review: { enabled: true, tool: "greptile", command: "" },
      merge: { by: "lead" },
      deploy: { enabled: true, tool: "vercel", command: "", perAgentEnvironments: false },
    },
  }),
  boards: [
    { id: "WEB", title: "Web app", status: "active", order: 0 },
    { id: "API", title: "API", status: "active", order: 1 },
    { id: "OPS", title: "Infra + release", status: "planned", order: 2 },
  ],
  tasks: [
    ...doneTasks("WEB", [["Marketing page", "leo"], ["Sign-in", "dwight"]], 1),
    { id: "WEB-T03", boardId: "WEB", title: "Fleet dashboard", ownerId: "jim", status: "todo", needs: [], prNumber: null },
    { id: "WEB-T04", boardId: "WEB", title: "Vessel detail page", ownerId: "leo", status: "todo", needs: [], prNumber: null },
    { id: "WEB-T05", boardId: "WEB", title: "E2E: booking flow", ownerId: "priya", status: "todo", needs: [], prNumber: null },
    { id: "WEB-T06", boardId: "WEB", title: "Getting started guide", ownerId: "sam", status: "todo", needs: [], prNumber: null },
    { id: "API-T01", boardId: "API", title: "Bookings endpoint", ownerId: "kenji", status: "todo", needs: [], prNumber: null },
    { id: "API-T02", boardId: "API", title: "Webhooks", ownerId: "dwight", status: "todo", needs: [], prNumber: null },
    { id: "API-T03", boardId: "API", title: "Rate limiting", ownerId: null, status: "todo", needs: [], prNumber: null },
  ],
  mergedPrs: 2,
  taskPool: [
    "Port schedule view", "Invoice export", "Crew roster", "Search filters", "Audit log", "API docs",
    "Accessibility pass", "Load test", "Error pages", "Onboarding emails",
  ],
  questions: [
    "Paginate with cursors or offsets?",
    "Is dark mode in scope for this page?",
    "Snapshot tests or visual diff?",
    "Document the beta endpoints too?",
  ],
  leadQuestions: ["Move Rate limiting to the OPS board?"],
};

// ---------------------------------------------------------------- Duo (2 agents, no deploy)

const duo: Preset = {
  id: "duo",
  label: "Notely · 2 agents",
  config: demoConfig({
    project: { id: "notely", name: "Notely", repo: "you/notely", path: "~/code/notely", hqPort: 7420 },
    team: [
      agent("ada", "Cipher", "Lead", "#f85149", { isLead: true, cli: "agy", model: "gemini-3.1-pro" }),
      agent("max", "Ghost", "Developer", "#3fb950", { cli: "claude" }),
    ],
    workflow: {
      mode: "github-pr",
      review: { enabled: true, tool: "human", command: "" },
      merge: { by: "human" },
      deploy: { enabled: false, tool: "custom", command: "", perAgentEnvironments: false },
    },
  }),
  boards: [{ id: "MVP", title: "MVP", status: "active", order: 0 }],
  tasks: [
    { id: "MVP-T01", boardId: "MVP", title: "Markdown editor", ownerId: "max", status: "todo", needs: [], prNumber: null },
    { id: "MVP-T02", boardId: "MVP", title: "Local storage sync", ownerId: "max", status: "todo", needs: ["MVP-T01"], prNumber: null },
  ],
  mergedPrs: 0,
  taskPool: ["Tags", "Search", "Export to PDF", "Keyboard shortcuts", "Themes"],
  questions: ["Store notes in IndexedDB or localStorage?"],
  leadQuestions: ["Ship the MVP with search, or cut it?"],
};

export const presets: Preset[] = [askwell, redCell, bigTeam, duo];
export const defaultPresetId = askwell.id;
