import type { MessageTag } from "./messageTags";
import type { FreeModelsState } from "./freeModels";
import type { TaskScore } from "./scorers";
import type {
  AgentInstruction,
  BoundingBox,
  ConsoleErrorEntry,
  DecisionKind,
  DecisionPayload,
  DecisionStatus,
  ElementSelection,
  FeedbackRoute,
  MeetingAgendaItem,
  MeetingKind,
  MeetingMinutes,
  MeetingSession,
  MeetingStatus,
  MeetingTurn,
  MeetingUrgency,
  OpinionSide,
  PackEntry,
  PermissionPayload,
  PreviewMode,
  PreviewTarget,
  PreviewTargetStatus,
  ProposedDecision,
  ProposedTask,
  QuestionAnswer,
  QuestionOption,
  QuestionPayload,
  QuestionPrompt,
  SecondOpinionPayload,
  ToolServer,
  VisualDecision,
  VisualFeedback,
  VoiceProvider,
} from "./generated";

export type {
  AgentInstruction,
  BoundingBox,
  ConsoleErrorEntry,
  DecisionKind,
  DecisionPayload,
  DecisionStatus,
  ElementSelection,
  FeedbackRoute,
  MeetingAgendaItem,
  MeetingKind,
  MeetingMinutes,
  MeetingSession,
  MeetingStatus,
  MeetingTurn,
  MeetingUrgency,
  OpinionSide,
  PackEntry,
  PermissionPayload,
  PreviewMode,
  PreviewTarget,
  PreviewTargetStatus,
  ProposedDecision,
  ProposedTask,
  QuestionAnswer,
  QuestionOption,
  QuestionPayload,
  QuestionPrompt,
  SecondOpinionPayload,
  VisualDecision,
  VisualFeedback,
  VoiceProvider,
};

export interface GateRecord {
  at: number;
  gateId: string;
  state: "passed" | "waived" | "failed";
  by: string;
  note: string | null;
}

export interface AnswerDecisionInput {
  status?: "resolved" | "dismissed";
  note?: string | null;
  answers?: QuestionAnswer[];
  chosenSide?: string | null;
  resolution?: string | null;
  meetingAction?: "join" | "snooze" | "decline" | null;
}

export interface StartMeetingInput {
  kind: MeetingKind;
  title: string;
  urgency?: MeetingUrgency;
  participantIds?: string[];
  agenda?: string[];
}

export interface SubmitVisualFeedbackInput {
  targetId: string | null;
  sourceKind: string;
  pageUrl: string;
  viewportWidth: number;
  viewportHeight: number;
  note: string;
  selection: ElementSelection | null;
  consoleErrors: ConsoleErrorEntry[];
  route: FeedbackRoute;
  imageDataUrl?: string;
}

/** The verifier's evidence for a task's PR at one commit: what it did, and the screenshots or recording. */
export interface TaskEvidence {
  sha: string;
  prNumber: number | null;
  by: string;
  at: string;
  steps: string[];
  /** Files under ~/.arima/<project>/evidence/<task>/<sha>/, served by HQ. */
  shots: { file: string; label: string }[];
}
import type { AgentEngine, Finding, Role, TeamTemplate, ToolRules } from "./model";

export type { Finding };
import type { StackConfig } from "./stack";
// Domain types shared by the data source, the store, the office and the HUD.

// ---------------------------------------------------------------- Config

/** sbx's machine-wide base network policy (`sbx policy init`). */
export type BasePolicy = "allow-all" | "balanced" | "deny-all" | "unknown";

/** Services sbx can inject keys for through its host proxy (the value never enters the VM). */
export const SERVICE_KEYS = ["anthropic", "openai", "github", "google", "groq", "mistral", "openrouter", "xai", "nebius", "copilot", "cursor", "devin", "droid"] as const;
export type ServiceKey = (typeof SERVICE_KEYS)[number];

/** VM size. null = HQ's default (SANDBOX_DEFAULT), not sbx's own (all host CPUs, half the RAM). Set at creation only. */
export interface SandboxResources {
  cpus: number | null;
  memoryGb: number | null;
}

/** Size of a new sandbox when the owner set none: enough for a CLI plus a build. sbx's own default takes half the RAM per sandbox. */
export const SANDBOX_DEFAULT = { cpus: 2, memoryGb: 2 } as const;

/** Per-agent sandbox settings HQ applies through sbx. Machine-wide ones live in SbxState. */
export interface SandboxSettings {
  resources: SandboxResources;
  allow: string[]; // extra allowed domains for this sandbox, e.g. "registry.npmjs.org"
  deny: string[]; // blocked domains for this sandbox (deny wins over allow)
}

/** sandbox = Docker Sandboxes (sbx microVM); container = plain Docker behind HQ's allowlist proxy (VMs); local = on the host. */
export type AgentMode = "sandbox" | "container" | "local";
export const isAgentMode = (v: unknown): v is AgentMode => v === "sandbox" || v === "container" || v === "local";
/** HQ starts only container-mode agents, so only they can be given tool servers. */
export const getsToolServers = (a: { mode: AgentMode }) => a.mode === "container";

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
    "gemini-4-neon-high",
    "gemini-4-neon-xhigh",
    "gemini-4-neon-medium",
    "gemini-4-argon-high",
    "gemini-4-argon-medium",
    "gemini-4-hydrogen-high",
    "gemini-pro-orchestrator-neon",
    "gemini-3.8-flash-high",
    "gemini-3.8-flash-medium",
    "claude-opus-5-5-high",
    "claude-opus-5-5-medium",
    "claude-sonnet-5-5-high",
    "claude-sonnet-5-5-medium",
    "gpt-oss-120b-medium",
  ],
  opencode: ["anthropic/claude-opus-4-6", "anthropic/claude-sonnet-4-6", "openai/gpt-5.4", "google/gemini-3.1-pro", "openrouter/deepseek/deepseek-r1", "ollama/qwen3-coder"],
  gemini: ["gemini-3.1-pro", "gemini-3-flash", "gemini-2.5-pro", "gemini-2.5-flash"],
  copilot: ["claude-opus-4.6", "claude-sonnet-4.6", "gpt-5.4", "gemini-3.1-pro"],
};

/**
 * An agent as the rest of HQ sees it. In a template project it is a seat (src/data/model.ts Seat) with
 * role, isLead, cli, model, skills and roleMd filled in from its role at load; only the seat is saved.
 * Projects made before templates have no roleId and keep these fields as they were saved (read-only).
 */
export interface AgentConfig {
  id: string; // "john"
  name: string; // "John"
  /** The template role this agent is a seat of. */
  roleId?: string;
  role: string; // the role's title
  isLead: boolean;
  cli: AgentCli;
  model: string; // optional start model ("" = the CLI's default; users can switch with /model)
  mode: AgentMode;
  /** Set while running: the mode it switches to at its next start (never mid-task). */
  nextMode?: AgentMode | null;
  color: string; // hex, used for the robot, owner dots and chips
  skills: string[];
  roleMd: string; // contents of ROLE.md
  sandbox: SandboxSettings;
  workspacePath: string | null; // an existing folder to use; null = HQ-managed clone
  /** Which subscription this agent signs in with, for CLIs where you have more than one ("" / missing = your default one). */
  account?: string;
  /** MCP servers (names in sbx's registry) this agent's sandbox gets. */
  mcp?: string[];
  /** Claude Code in Sandbox or Container mode only: "stream" runs it headless (docs/design/stream-json.md). */
  engine?: AgentEngine;
}

/** Frozen v1 server only: a server in the sandbox runtime's registry. */
export interface McpServer {
  name: string;
  transport: string;
  status: string;
  nextStep: string | null;
}

/** Frozen v1 server only. The UI reads {@link ToolServerState}. */
export interface McpState {
  servers: McpServer[];
  attached: Record<string, string[]>;
  error: string | null;
  checkedAt: string;
}

/** This project's tool servers, and other projects' hand-added ones it can copy. */
export interface ToolServerState {
  servers: ToolServer[];
  /** Per agent: the servers it gets at its next start. */
  attached: Record<string, string[]>;
  others: { projectId: string; project: string; name: string }[];
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

export interface ProjectConfig {
  /** Fixed once created: names sandboxes, tmux sessions and ~/.arima/<id>. Renaming the project never changes it. */
  id: string; // "askwell"
  name: string; // "Askwell"
  repo: string; // "acme/askwell"
  path: string; // "~/developer/askwell"
  hqPort: number; // port sandboxes use to reach HQ via host.docker.internal
  exportPlan?: boolean; // also write the plan to docs/plan.md
  /** The lead may list other projects on this machine and create or update their tasks. Off unless the owner turns it on. */
  crossProject?: boolean;
  /** How this team works together (owns which area, how to disagree, when to bother the owner). In every agent's role file. */
  charter?: string;
  /** The morning (09:00) and evening (18:00) note to the owner. On unless set to false. */
  standup?: boolean;
  /** The template's scheduled rituals (default on). */
  rituals?: boolean;
  officeName?: string; // the sign on the office wall; empty = the brand sign (DEFAULT_OFFICE_NAME)
  /** Security engagements: what agents may touch. */
  scope?: Scope;
  /** Spend caps in USD on API-key accounts (docs/agent-engine.md section 8); missing = $5 a day, $50 a month. */
  spendCaps?: { dailyUsd: number; monthlyUsd: number };
  /** Lesson promotion to the template (docs/templates.md section 8); missing = on, except security engagements. */
  promoteLessons?: boolean;
}

/** A lesson a project offered to its template: general, no project id. Approved ones go into the next projects' briefs. */
export interface TemplateLesson {
  id: string;
  templateId: string;
  type: string;
  text: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
}

/** Settings → Memory: this project's template and its lessons. */
export interface LessonsState {
  templateId: string | null;
  /** Promotion allowed for this project (off by default for security engagements). */
  enabled: boolean;
  approved: TemplateLesson[];
  pending: number;
  running: boolean;
  /** The last promotion run's outcome, in words. */
  last: string | null;
  /** Template changes drafted from repeated failures (docs/factory.md section 5). */
}

/** The machine's GitHub App (docs/agent-engine.md section 6); null app = none created yet. */
export interface GitHubAppState {
  app: { id: number; slug: string; htmlUrl: string; owner: string; installUrl: string } | null;
  /** The path GitHub posts to; made public with Tailscale Funnel (deploy/github-webhook.sh). */
  webhookPath: string;
  lastDeliveryAt: string | null;
}

/** A template in this HQ's library. problems: why a project can't use it yet (packs waiting for the owner). */
export interface TemplateEntry {
  template: TeamTemplate;
  builtin: boolean;
  problems: string[];
}

/** A skill pack on this machine (docs/templates.md section 2). */
export interface SkillPackView {
  source: string;
  commit: string;
  licence: string | null;
  credit: string | null;
  use: "any" | "scoped-offensive" | "github-action";
  skills: number;
  status: "vetted" | "pending" | "approved" | "rejected";
  blocked: string[];
  warnings: number;
}

/** A project's spend against its caps, on API-key accounts only (subscriptions have no bill). */
export interface SpendState {
  day: { usd: number; cap: number };
  month: { usd: number; cap: number };
  /** Over a cap: workers stopped, no new starts or model runs until the period rolls over or the cap is raised. */
  paused: "day" | "month" | null;
  /** Events on models without a price row (GPT, Gemini): counted as $0. */
  unpriced: number;
  /** Roles with a daily budget: today's spend and whether its seats are stopped. */
  roles?: { roleId: string; title: string; usd: number; cap: number; paused: boolean }[];
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

export interface HqConfig {
  project: ProjectConfig;
  team: AgentConfig[];
  /** The project's own copy of its template; null for a project made before templates (read-only). Not saved in config.json. */
  template: TeamTemplate | null;
  /** The template's tool rules, or what a pre-template project's type implied. Not saved in config.json. */
  rules: ToolRules;
  /** Derived from the flow (step 5 replaces it with gates). */
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
  /** HQ's proxy saw the agent try it (the agent didn't ask): it doesn't hold the agent, and a deny isn't sent to it. */
  observed?: boolean;
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
  /** Where the task is in its template's flow; missing in projects made before templates. */
  stageId?: string;
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
  /** Tokens recorded against it while it was its owner's current task (usage events). */
  usage?: Tokens | null;
  /** The board spec's items this task covers ("S1", "S4"); the analyze gate checks every item has one. */
  specItems?: string[];
  /** The lead marked it high-stakes (sensitive files make it so too): a second opinion is required. */
  highStakes?: boolean;
  /** The project's template when the task was made (docs/factory.md section 2); empty on older tasks. */
  templateId?: string;
  templateVersion?: number;
  /** Its scorers' verdicts once it finished (docs/factory.md section 4). */
  scores?: TaskScore[];
  /** Its id in the benchmark suite (~/.arima-bench/suite), once added (docs/factory.md section 6). */
  benchmark?: string;
  /** Screenshots of the running app for its PR, taken by the verifier (docs/factory.md section 7). */
  evidence?: TaskEvidence;
  /** When it entered its current status (ISO), from the task's status events; missing on projects without them. */
  movedAt?: string;
  /** The goal it moves forward (server/goals.ts). */
  goalId?: string | null;
  /** Recorded gate passes or waivers for this task. */
  gateRecords?: GateRecord[];
}

/** An outcome the owner wants, with the tasks that roll up to it. done/total/usd are worked out by HQ. */
export interface Goal {
  id: string; // "G1"
  title: string;
  /** The number that shows it, its target and where it is now: free text ("MRR", "$5k", "$3.2k"). */
  metric?: string;
  target?: string;
  current?: string;
  status: "active" | "done" | "dropped";
  done: number;
  total: number;
  /** Estimated spend on its tasks (priced models only). */
  usd: number;
}
/** A remote MCP server HQ calls for the agents (server/connections.ts). Never carries the key. */
export interface ToolConnection {
  name: string;
  url: string;
  /** Roles whose agents may use it; none = nobody. */
  roles: string[];
  /** Tools the owner ticked as read-only: the only ones agents can call. */
  read: string[];
  /** The tool HQ calls when the owner clicks Send on a proposed send; agents never call it. */
  send: string | null;
  /** The server's tools at the last check. */
  tools: { name: string; description: string }[];
  probedAt: string | null;
  hasKey: boolean;
}

export interface ConnectionInput {
  name: string;
  url?: string;
  roles?: string[];
  read?: string[];
  send?: string | null;
  /** Stored in HQ's vault; "" removes it, left out keeps it. */
  apiKey?: string;
}

export type GoalPatch = Partial<Pick<Goal, "title" | "metric" | "target" | "current" | "status">>;

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
  /** The PR adds or changes a test file (unknown until GitHub sends the PR's files). */
  testsChanged?: boolean;
  /** The paths it changes, as GitHub last reported them (first 100). */
  files?: string[];
  /** The PR's head commit, as GitHub last reported it. */
  headSha?: string;
  /** Every check on the head commit finished green; false with no checks at all. */
  ciGreen?: boolean;
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
  /** A question to the whole team: sent to the lead, who gathers from teammates and answers once. */
  team?: boolean;
  /** What the message is (src/data/messageTags.ts). A question goes to the lead if unanswered; two disagreements on one task go to the lead. */
  kind?: MessageTag;
  /** The sender's task when it was sent. */
  taskId?: string;
}

export type ActivityType =
  | "task.assigned"
  | "task.started"
  | "task.created"
  | "task.scored"
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
  | "verifier-image"
  | "egress-lock"
  | "hq-reach"
  | "scope-firewall"
  | "github-container"
  | `login-${AgentCli}`
  | `login-${AgentCli}@${string}`;
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
  envFile: { path: string; exists: boolean; keys?: string[] };
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

/** A project's agent network mode: off (no proxy), observe (everything allowed; what enforce would block is listed), enforce. */
export type EgressMode = "off" | "observe" | "enforce";

/** A host the project's agents reached that enforce mode would block. */
export interface EgressBlock {
  host: string;
  port: number;
  agents: string[];
  count: number;
  firstSeen: string;
  lastSeen: string;
  /** Packs the agents that reached it use: a host none of their grants declares. */
  packs?: string[];
}

export interface EgressState {
  mode: EgressMode;
  /** Hosts allowed for this project ("host" or "host:port"). */
  rules: string[];
  wouldBlock: EgressBlock[];
}

/** What sbx actually has on this machine (read back, not saved settings). */
export interface SbxState {
  basePolicy: BasePolicy;
  /** The frozen v1 server's upstream proxy; the Rust HQ sends `egress` instead. */
  proxy?: string | null;
  /** Absent from the v1 server. */
  egress?: EgressState;
  globalKeys: string[]; // service keys available to every sandbox
  projectEnv?: { path: string; exists: boolean; keys: string[] };
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
  /** The frozen v1 server sends {@link McpState}; the Rust HQ sends {@link ToolServerState}. */
  mcp?: ToolServerState | McpState;
  /** Machine-wide sign-ins agents can use (API keys, cloud). Never contains secret values. */
  accounts?: AccountsState;
  memory?: MemoryState;
  /** What every agent on this machine knows about the company (Settings → Project). */
  company?: string;
  goals?: Goal[];
  /** Owner and operators: the machine's tool connections (no keys). */
  connections?: ToolConnection[];
  spend?: SpendState;
  githubApp?: GitHubAppState;
  skillPacks?: SkillPackView[];
  /** This project's packs by id (Rust HQ): approved entries, pending installs, and updates waiting for review. */
  packs?: Record<string, PackEntry>;
  /** Free models from models.dev, re-read daily (src/data/freeModels.ts). */
  freeModels?: FreeModelsState;
  /** This HQ's template library (built-in and saved or imported), for the welcome. */
  templateLibrary?: TemplateEntry[];
  /** What this server can do. A missing flag means yes (older servers and the demo); the Rust HQ sends false for what it does not have yet. */
  features?: { shell?: boolean; sandboxTab?: boolean };
  lessons?: LessonsState;
  actionItems?: ActionItem[];
  findings?: Finding[];
  visualDecisions?: VisualDecision[];
  meetings?: MeetingSession[];
  meetingTurns?: Record<string, MeetingTurn[]>;
  previewTargets?: PreviewTarget[];
  visualFeedback?: VisualFeedback[];
}

/** A memory waiting for the user's check. `conflict`: a certified memory of the same type about the same thing. */
export interface PendingMemory {
  id: string;
  type: string;
  text: string;
  about: string[];
  conflict?: { id: string; text: string } | null;
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
  /** plan = an ops task's plan waiting for Approve (done) / Reject (dismissed) before the agent executes.
   *  memory = new memories from one task, waiting to be certified or rejected (from "hq").
   *  approval = the lead passed a person gate while the owner was away: Keep (done) or Undo (dismissed). */
  kind?: "request" | "plan" | "memory" | "approval" | "spend" | "overflow" | "skills" | "spec" | "gate" | "lesson" | "send" | "info";
  /** kind send: what HQ sends through the owner's connection when the owner clicks Send (Dismiss: nothing is sent). */
  send?: { connection: string; tool: string; args: Record<string, unknown>; sentAt?: string; error?: string };
  /** kind lesson: a lesson waiting to join the template (Approve = approved, Reject = rejected). */
  lesson?: { id: string; templateId: string; type: string };
  /** kind gate: a task waiting on the owner's approval gate (outbound send, containment, merge). Approve = passed, Send back = failed. */
  gate?: { taskId: string; gateId: string; reason: string };
  /** kind spec: the board spec version waiting for the owner (Approve = done, Send back = dismissed). */
  spec?: { boardId: string; version: number };
  /** kind skills: the skill pack (owner/repo) waiting for the owner's approval of its scan. */
  pack?: string;
  /** kind overflow: the seat, its task and the fallback it would move to (Move = done, Wait = dismissed). */
  overflow?: { agentId: string; taskId: string; cli: AgentCli; model: string };
  /** kind approval: the gate the lead passed and the stage it belongs to. */
  approval?: { gateId: string; stageId: string };
  /** kind memory: the memories still to decide. */
  memories?: PendingMemory[];
  note: string | null; // the user's note when closing it
  at: string;
  closedAt: string | null;
}

// ---------------------------------------------------------------- Inputs

export interface NewAgentInput {
  name: string;
  roleId: string;
  mode: AgentMode;
}

/** First-run choices from the welcome screen. */
export interface WelcomeInput {
  projectName: string;
  officeName?: string;
  templateId: string;
  reviewTool: ReviewTool;
  reviewEnabled: boolean;
  /** Optional: what the project is built with. */
  stack?: StackConfig;
}

/** Changes to one seat. CLI, model, skills and role text belong to the role (RolePatch). */
export type AgentPatch = Partial<Pick<AgentConfig, "name" | "roleId" | "mode" | "color" | "workspacePath" | "account" | "engine">>;

/** Changes to one role of the project's template; every seat of the role picks them up at its next start. */
export type RolePatch = Partial<Pick<Role, "title" | "cli" | "model" | "fallback" | "skills" | "roleMd" | "onDemand" | "color">> & {
  /** null clears it. */
  capUsd?: number | null;
  outbound?: Role["outbound"] | null;
};

export interface WorkflowPatch {
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
  /** Made before templates: read-only. */
  readOnly: boolean;
  /** Its template's name; null when read-only. */
  templateName: string | null;
  /** Security work (findings and scope): the office gets its SOC room. */
  secure: boolean;
  workflowMode: WorkflowMode;
  officeName?: string;
  lastUpdatedAt: string;
  team: { id: string; name: string; roleId?: string; role: string; isLead: boolean; cli: AgentCli; model: string }[];
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
  /** Loaded projects: API-key spend today and this month against its caps. */
  spend?: SpendState;
  /** Open Inbox items plus agents waiting on you. */
  waiting?: number;
  goals?: Goal[];
}


/** Accounts on this machine and where the vault's master key comes from (null: no vault yet). */
export interface AccountsState {
  list: import("./providers").AccountView[];
  masterSource: "env" | "keychain" | "file" | null;
  /** Set when the vault exists but can't be opened (wrong or missing master key). */
  error?: string;
}

/** Settings → Memory: extraction, keep-out names and HQ's backups. */
export interface MemoryState {
  /** Claude Haiku reads finished tasks into memories (spends usage on `account`). */
  extraction: { enabled: boolean; account: string };
  /** Names this project keeps out of memory. */
  keepOut: string[];
  /** HQ's nightly whole-database backups, newest first (dates). */
  backups: string[];
}

/** What the Accounts form sends; the secret is optional when updating. */
export interface AccountInput {
  id: string;
  provider: import("./providers").Provider;
  label?: string;
  fields?: Record<string, string>;
  secret?: string;
}
