import type { StackConfig } from "./stack";
// Domain types shared by the data source, the store, the office and the HUD.

// ---------------------------------------------------------------- Config

/** sbx's machine-wide base network policy (`sbx policy init`). */
export type BasePolicy = "allow-all" | "balanced" | "deny-all" | "unknown";

/** Services sbx can inject keys for through its host proxy (the value never enters the VM). */
export const SERVICE_KEYS = ["anthropic", "openai", "github", "google", "groq", "mistral", "openrouter", "xai", "nebius", "copilot", "cursor", "devin", "droid"] as const;
export type ServiceKey = (typeof SERVICE_KEYS)[number];

/** VM size. null = let sbx decide (all host CPUs; 50% of RAM, 0.5–32 GB). Set at creation only. */
export interface SandboxResources {
  cpus: number | null;
  memoryGb: number | null;
}

/** Per-agent sandbox settings HQ applies through sbx. Machine-wide ones live in SbxState. */
export interface SandboxSettings {
  resources: SandboxResources;
  allow: string[]; // extra allowed domains for this sandbox, e.g. "registry.npmjs.org"
  deny: string[]; // blocked domains for this sandbox (deny wins over allow)
}

/** sandbox = Docker Sandboxes (sbx microVM); container = plain Docker behind HQ's allowlist proxy (VMs); local = on the host. */
export type AgentMode = "sandbox" | "container" | "local";
export const isAgentMode = (v: unknown): v is AgentMode => v === "sandbox" || v === "container" || v === "local";

/** Which coding or autonomous agent CLI runs in the sandbox or locally. */
export const AGENT_CLIS = ["claude", "codex", "agy", "opencode", "gemini", "copilot"] as const;
export type AgentCli = (typeof AGENT_CLIS)[number];

export const isAgentCli = (v: unknown): v is AgentCli => typeof v === "string" && (AGENT_CLIS as readonly string[]).includes(v);

export const CLI_LABEL: Record<AgentCli, string> = {
  claude: "Claude Code",
  codex: "Codex",
  agy: "Antigravity (agy)",
  opencode: "OpenCode",
  gemini: "Gemini CLI",
  copilot: "GitHub Copilot",
};

/** CLIs not yet run end to end with a real team; shown as experimental in pickers. */
export const EXPERIMENTAL_CLIS: ReadonlySet<AgentCli> = new Set<AgentCli>(["opencode", "gemini", "copilot"]);
export const cliPickerLabel = (c: AgentCli) => `${CLI_LABEL[c]}${EXPERIMENTAL_CLIS.has(c) ? " (experimental)" : ""}`;

export const CLI_MODELS: Record<AgentCli, string[]> = {
  claude: ["claude-opus-5-5", "claude-sonnet-5-5", "opus", "sonnet", "haiku", "claude-opus-4-6", "claude-sonnet-4-6"],
  codex: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-terra", "gpt-5.6-sol"],
  agy: [
    "gemini-4-argon-high",
    "gemini-4-argon-medium",
    "gemini-3.8-flash-high",
    "claude-opus-5-5-high",
    "claude-sonnet-5-5-high",
    "gpt-oss-120b-medium",
  ],
  opencode: ["anthropic/claude-opus-4-6", "anthropic/claude-sonnet-4-6", "openai/gpt-5.4", "google/gemini-3.1-pro", "openrouter/deepseek/deepseek-r1", "ollama/qwen3-coder"],
  gemini: ["gemini-3.1-pro", "gemini-3-flash", "gemini-2.5-pro", "gemini-2.5-flash"],
  copilot: ["claude-opus-4.6", "claude-sonnet-4.6", "gpt-5.4", "gemini-3.1-pro"],
};

export const DEPARTMENT_IDS = ["exec", "eng", "design", "qa-ops", "marketing", "red-team"] as const;
export type DepartmentId = (typeof DEPARTMENT_IDS)[number];

export const isDepartmentId = (v: unknown): v is DepartmentId =>
  typeof v === "string" && (DEPARTMENT_IDS as readonly string[]).includes(v);

export interface AgentConfig {
  id: string; // "john"
  name: string; // "John"
  role: string; // "Lead" | "CTO" | "Senior Dev" | "Junior Dev" | "UI/UX Designer" | "Red Teamer" | anything
  department?: DepartmentId; // department pod ("exec", "eng", "design", "qa-ops", "marketing", "red-team")
  isLead: boolean;
  cli: AgentCli;
  model: string; // optional start model ("" = the CLI's default; users can switch with /model)
  mode: AgentMode;
  color: string; // hex, used for the robot, owner dots and chips
  skills: string[];
  roleMd: string; // contents of ROLE.md
  sandbox: SandboxSettings;
  workspacePath: string | null; // an existing folder to use; null = HQ-managed clone
  /** Which subscription this agent signs in with, for CLIs where you have more than one ("" / missing = your default one). */
  account?: string;
  /** MCP servers (names in sbx's registry) this agent's sandbox gets. */
  mcp?: string[];
}

/** An MCP server registered with Docker Sandboxes (`sbx mcp ls`). */
export interface McpServer {
  name: string;
  transport: string; // "remote http" | "local stdio" | …
  status: string; // "ready" | "needs-auth" | …
  nextStep: string | null; // e.g. "sbx mcp auth arcjet"
}

export interface McpState {
  servers: McpServer[];
  /** Per agent: servers attached to its sandbox right now (sbx can't detach one; recreating the sandbox does). */
  attached: Record<string, string[]>;
  error: string | null;
  checkedAt: string;
}

export interface NewMcpServer {
  name: string;
  url?: string;
  /** Local stdio server: a program on this Mac. */
  command?: string;
  args?: string[];
  /** Optional API key: sent as "Authorization: Bearer <key>", stored by sbx (never by HQ). */
  apiKey?: string;
}

export type ReviewTool = "coderabbit" | "greptile" | "copilot" | "human" | "custom";
export type DeployTool = "instacloud" | "vercel" | "custom";
export type WorkflowMode = "github-pr" | "deliverables";

export interface WorkflowConfig {
  /** "github-pr" = 1 task = 1 branch = 1 PR; "deliverables" = universal non-PR task & artifact workflow for any domain. */
  mode?: WorkflowMode;
  review: { enabled: boolean; tool: ReviewTool; command: string };
  merge: { by: "human" | "lead" };
  deploy: { enabled: boolean; tool: DeployTool; command: string; perAgentEnvironments: boolean };
  /** Token saving. clearBetweenTasks (default on): a worker starts each task in a fresh conversation. */
  lean?: { clearBetweenTasks: boolean };
}

/** What kind of work the project is; decides its workflow (software: PRs; the others come in later phases). */
export type ProjectType = "software" | "security" | "research" | "ops";
export const PROJECT_TYPES: { id: ProjectType; label: string }[] = [
  { id: "software", label: "Software" },
  { id: "security", label: "Security engagement" },
  { id: "research", label: "Research / docs" },
  { id: "ops", label: "Ops / infra" },
];
export const isProjectType = (v: unknown): v is ProjectType => PROJECT_TYPES.some((t) => t.id === v);

export interface ProjectConfig {
  /** Fixed once created: names sandboxes, tmux sessions and ~/.arima/<id>. Renaming the project never changes it. */
  id: string; // "askwell"
  name: string; // "Askwell"
  repo: string; // "jsmastery-pro/askwell"
  path: string; // "~/developer/askwell"
  hqPort: number; // port sandboxes use to reach HQ via host.docker.internal
  exportPlan?: boolean; // also write the plan to docs/plan.md
  officeName?: string; // the sign on the office wall; empty = ".HQ"
  type: ProjectType;
  /** Security engagements: what agents may touch. */
  scope?: Scope;
}

/** Engagement scope: domains ("example.com", "*.example.com"), IPs or IPv4 CIDRs. Out of scope always wins. */
export interface Scope {
  inScope: string[];
  outOfScope: string[];
  /** Rules of engagement, given to every agent (hours, rate limits, no DoS, contacts…). */
  rules: string;
}

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];
export type FindingStatus = "open" | "confirmed" | "fixed" | "accepted" | "false-positive";
export const FINDING_STATUSES: FindingStatus[] = ["open", "confirmed", "fixed", "accepted", "false-positive"];

/** A security finding an agent reported (Team MCP report_finding). */
export interface Finding {
  id: string; // "F-003"
  title: string;
  severity: Severity;
  target: string; // in-scope host, IP or URL
  description: string;
  evidence: string; // requests/responses, commands and output (no secrets)
  remediation: string;
  status: FindingStatus;
  reporterId: string;
  taskId: string | null;
  at: string;
  updatedAt: string;
}

export interface HqConfig {
  project: ProjectConfig;
  team: AgentConfig[];
  workflow: WorkflowConfig;
  /** Optional: what the project is built with (plan 009). */
  stack?: StackConfig;
}

/** An agent asked to reach a domain its sandbox blocks (Team MCP `request_access`). */
export interface AccessRequest {
  id: string;
  agentId: string;
  domain: string;
  reason: string;
  at: string;
  status: "pending" | "allowed" | "denied";
}

export type AccessDecision = "agent" | "everyone" | "deny";

// ---------------------------------------------------------------- Live state

export type AgentState = "idle" | "working" | "needs-input" | "in-review" | "review-passed";

/** The agent's process: its tmux session running `sbx run` (Sandbox) or `claude` (Local). */
export type SessionState = "stopped" | "starting" | "running" | "failed";

export interface SessionInfo {
  state: SessionState;
  detail: string | null; // why it failed, or what it is doing
  workspace: string | null; // absolute folder path on the host
  sandbox: { cpus: number; memoryGb: number } | null; // what the existing sandbox actually has
}

export interface AgentStatus {
  agentId: string;
  state: AgentState;
  currentTaskId: string | null;
  stateSince: string; // ISO time
  note: string | null; // e.g. "Asking: max PDF size 10 MB or 20 MB?"
  session: SessionInfo;
  /** Its subscription hit a usage limit; don't assign work until this time (ISO). */
  limitedUntil?: string | null;
  /** Tokens its CLI has used in this agent's folder, from the CLI's own logs (null: HQ can't read that CLI's logs). */
  usage?: Tokens | null;
}

export interface Tokens {
  input: number; // fresh input, incl. cache writes
  cached: number; // input read from the prompt cache
  output: number;
}

export type BoardStatus = "active" | "planned" | "done";

export interface Board {
  id: string; // "P3"
  title: string; // "Phase 3 — Knowledge + chat"
  status: BoardStatus;
  order: number;
}

export type TaskStatus = "todo" | "in-progress" | "in-review" | "done" | "blocked";

export interface Task {
  id: string; // "P3-T02"
  boardId: string;
  title: string;
  ownerId: string | null;
  status: TaskStatus;
  needs: string[]; // task IDs
  prNumber: number | null;
  description?: string; // what to build
  files?: string[]; // the only files this task may edit
  doneWhen?: string; // acceptance criteria
  note?: string | null; // e.g. why it's blocked
  deliverablePath?: string | null; // optional output file/artifact in deliverables mode
  /** Runs on: only an agent with this CLI may take the task (null = any). */
  cli?: AgentCli | null;
  /** Preferred model for the task (applied when the agent next starts). */
  model?: string | null;
  /** Tokens its owner used between starting and finishing it. */
  usage?: Tokens | null;
}

export type ReviewState = "pending" | "reviewing" | "changes-requested" | "passed";

export interface PullRequest {
  number: number;
  title: string; // "[P3-T02] Chat route"
  taskId: string;
  authorId: string;
  review: ReviewState;
  openComments: number;
  mergeable: boolean;
  merged: boolean;
  openedAt: string;
  url?: string; // link to GitHub
  branch?: string;
  closed?: boolean; // closed without merging — hidden from the board
  conflict?: boolean; // has merge conflicts with the base branch
  reviewNote?: string | null; // e.g. "CodeRabbit: review rate limited"
}

export type EnvironmentStatus = "live" | "deploying" | "sleeping";

export interface Environment {
  name: string; // "main" | agent id
  agentId: string | null;
  url: string;
  status: EnvironmentStatus;
  lastDeployAt: string;
}

/** The human at the keyboard, as a message sender. */
export const HUMAN_ID = "you";

/** One message carried by the Team MCP between two agents (or from you). */
export interface AgentMessage {
  id: string;
  at: string;
  fromId: string; // agent id, or HUMAN_ID
  toId: string;
  text: string;
  delivered?: "typed" | "on-stop" | "queued" | "dropped"; // how HQ handed it over; dropped = a start that no longer applied
}

export type ActivityType =
  | "task.assigned"
  | "task.started"
  | "task.created"
  | "agent.needs-input"
  | "agent.answered"
  | "message"
  | "pr.opened"
  | "review.started"
  | "review.passed"
  | "review.changes"
  | "pr.merged"
  | "deploy"
  | "session"
  | "config"
  | "scope.refused";

export interface ActivityEvent {
  id: string;
  at: string;
  type: ActivityType;
  agentId: string | null;
  text: string;
}

/** What removing an agent would delete. Answer to `inspectWorkspace`. */
export interface WorkspaceInfo {
  agentId: string;
  path: string;
  managed: boolean; // HQ made this folder (only these can be deleted from HQ)
  exists: boolean;
  changedFiles: number; // uncommitted changes
  unpushedCommits: number; // commits on local branches that aren't on any remote
  sandboxName: string | null;
  sandboxExists: boolean;
}

export interface RemoveAgentOptions {
  deleteSandbox: boolean;
  deleteFolder: boolean;
}

// ---------------------------------------------------------------- Setup

export type SetupCheckId =
  | "os"
  | "sbx"
  | "sbx-login"
  | "sbx-policy"
  | "tmux"
  | "gh"
  | "gh-remote"
  | "github-secret"
  | "claude"
  | "codex"
  | "openai-secret"
  | "agy"
  | "opencode"
  | "gemini"
  | "copilot"
  | "google-secret"
  | "docker"
  | "agent-image"
  | "egress-lock"
  | "hq-reach"
  | "scope-firewall"
  | `login-${AgentCli}`;
export type SetupStatus = "ok" | "missing" | "unsupported" | "warning";

export interface SetupFix {
  command: string; // shown with a Copy button
  runnable: boolean; // HQ may run it in a visible terminal ("Run in terminal")
  docs: string | null;
}

export interface SetupCheck {
  id: SetupCheckId;
  label: string;
  status: SetupStatus;
  detail: string; // version found, or what is wrong
  neededFor: "sandbox" | "container" | "local" | "all" | "github";
  fix: SetupFix | null;
}

/** A network rule in effect for a sandbox, as sbx reports it. */
export interface SbxRule {
  id: string;
  decision: "allow" | "deny";
  resources: string[];
  source: "hq" | "kit" | "org" | "cli"; // cli = added with the sbx CLI, outside HQ
}

export interface SbxAgentState {
  rules: SbxRule[]; // empty until the sandbox exists
  keys: string[]; // service keys scoped to this sandbox
  envFile: { path: string; exists: boolean };
  syncError: string | null;
  /** Requests the sandbox blocked, waiting in sbx's approval queue (`sbx policy approval ls`). */
  approvals: SbxApproval[];
  /** Sandbox ports reachable from this machine (`sbx ports`), e.g. for a CLI's sign-in callback. */
  ports?: SbxPort[];
}

/** Terminal id of the Terminal panel: your own shell on this machine, not in a sandbox. */
export const HOST_TERMINAL = "shell:@host";

export interface SbxPort {
  sandbox: number;
  host: number;
}

export interface SbxApproval {
  id: string; // sbx's approval id
  host: string; // "mcp.notion.com:443"
  /** sbx's title as is, e.g. "GET api.example.com:443/v1/data" (shown, so different requests can be told apart). */
  title?: string;
  detail: string;
  /** False when sbx's entry is narrower than host:port (e.g. one HTTP method and path). */
  hostWide?: boolean;
  /** "TCP" or "UDP" from sbx's detail. HQ's allow rules are TCP, so others are answered through sbx. */
  protocol?: string;
}

/** What sbx actually has on this machine (read back, not saved settings). */
export interface SbxState {
  basePolicy: BasePolicy;
  proxy: string | null;
  globalKeys: string[]; // service keys available to every sandbox
  agents: Record<string, SbxAgentState>;
  checkedAt: string;
}

export interface MachineInfo {
  cpus: number;
  memoryGb: number;
  /** False on Windows: agents run inside HQ and stop when it stops (no tmux). */
  persistentAgents?: boolean;
}

export interface SetupState {
  machine: MachineInfo;
  checks: SetupCheck[];
  sandboxReady: boolean; // every sandbox check passes
  localReady: boolean; // Local mode can run
  containerReady: boolean; // Container mode can run (Docker, image, network)
  checkedAt: string;
}

export interface OfficeSnapshot {
  /** True until the first-run welcome is finished for this repo (real HQ only). */
  welcome?: boolean;
  /** Your own skills found in ~/.arima/skills and the repo's .arima/skills (folders with a SKILL.md). */
  customSkills?: string[];
  setup: SetupState;
  sbx: SbxState;
  config: HqConfig;
  agents: AgentStatus[];
  boards: Board[];
  tasks: Task[];
  pullRequests: PullRequest[];
  environments: Environment[];
  messages: AgentMessage[]; // newest first, last 100
  activity: ActivityEvent[]; // newest first, last 50
  accessRequests?: AccessRequest[];
  mcp?: McpState;
  /** Machine-wide sign-ins agents can use (API keys, cloud). Never contains secret values. */
  accounts?: AccountsState;
  actionItems?: ActionItem[];
  findings?: Finding[];
}

/** Something an agent needs the user to do outside its sandbox (Team MCP `ask_user`). */
export interface ActionItem {
  id: string;
  fromId: string; // agent id
  taskId: string | null;
  title: string;
  details: string; // steps; never secret values
  waiting: boolean; // the agent can't continue without it
  status: "open" | "done" | "dismissed";
  /** plan = an ops task's plan waiting for Approve (done) / Reject (dismissed) before the agent executes. */
  kind?: "request" | "plan";
  note: string | null; // the user's note when closing it
  at: string;
  closedAt: string | null;
}

// ---------------------------------------------------------------- Inputs

export interface NewAgentInput {
  name: string;
  role: string;
  department?: DepartmentId;
  cli?: AgentCli;
  model?: string;
  mode: AgentMode;
  skills?: string[];
  roleMd?: string;
}

/** First-run choices from the welcome screen. */
export interface WelcomeInput {
  projectName: string;
  officeName?: string;
  lead: { name: string; role?: string; department?: DepartmentId; cli: AgentCli; model?: string };
  workers: { name: string; role: string; department?: DepartmentId; cli: AgentCli; model?: string }[];
  workflowMode?: WorkflowMode;
  reviewTool: ReviewTool;
  reviewEnabled: boolean;
  /** Optional: what the project is built with. */
  stack?: StackConfig;
}

export type AgentPatch = Partial<
  Pick<AgentConfig, "name" | "role" | "department" | "cli" | "model" | "mode" | "color" | "skills" | "roleMd" | "workspacePath" | "account">
>;

export interface WorkflowPatch {
  mode?: WorkflowMode;
  review?: Partial<WorkflowConfig["review"]>;
  merge?: Partial<WorkflowConfig["merge"]>;
  deploy?: Partial<WorkflowConfig["deploy"]>;
  lean?: { clearBetweenTasks?: boolean };
}

// ---------------------------------------------------------------- Multi-Project CTO Registry

export interface ProjectOverview {
  id: string;
  name: string;
  path: string;
  repo: string;
  hqPort: number;
  /** Loaded in this server (its agents report here). */
  online: boolean;
  /** Loaded but GitHub/sbx polling paused. */
  paused: boolean;
  /** Archived: agents stopped and not loaded. Restore it, or delete it for good. */
  archived: boolean;
  /** Always false from the server (it serves every project); the UI sets it for the project you're viewing. */
  isCurrent: boolean;
  type: ProjectType;
  workflowMode: WorkflowMode;
  officeName?: string;
  lastUpdatedAt: string;
  team: { id: string; name: string; role: string; department?: DepartmentId; isLead: boolean; cli: AgentCli; model: string }[];
  boards: Board[];
  tasks: Task[];
  counts: {
    todo: number;
    inProgress: number;
    inReview: number;
    done: number;
    blocked: number;
    total: number;
  };
}


/** Accounts on this machine and where the vault's master key comes from (null: no vault yet). */
export interface AccountsState {
  list: import("./providers").AccountView[];
  masterSource: "env" | "keychain" | "file" | null;
  /** Set when the vault exists but can't be opened (wrong or missing master key). */
  error?: string;
}

/** What the Accounts form sends; the secret is optional when updating. */
export interface AccountInput {
  id: string;
  provider: import("./providers").Provider;
  label?: string;
  fields?: Record<string, string>;
  secret?: string;
}
