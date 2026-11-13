import type { TemplateFile } from "./templateFile";
import type { StackConfig } from "./stack";
import type {
  AccessDecision,
  AgentCli,
  AccessRequest,
  ActionItem,
  Finding,
  FindingStatus,
  Severity,
  McpState,
  NewMcpServer,
  ActivityEvent,
  AgentMessage,
  AgentPatch,
  RolePatch,
  AgentStatus,
  Board,
  Environment,
  HqConfig,
  NewAgentInput,
  OfficeSnapshot,
  SbxState,
  RemoveAgentOptions,
  SetupCheckId,
  SetupState,
  WelcomeInput,
  WorkspaceInfo,
  ProjectConfig,
  PullRequest,
  SandboxSettings,
  Task,
  WorkflowPatch,
  AccountInput,
  AccountsState,
  MemoryInput,
  MemoryState,
  SpendState,
  AgentMode,
  GitHubAppState,
  SkillPackView,
  TemplateEntry,
  LessonsState,
} from "./types";

export type OfficeEvent =
  | { type: "snapshot"; snapshot: OfficeSnapshot }
  | { type: "setup.updated"; setup: SetupState }
  | { type: "sbx.updated"; sbx: SbxState }
  | { type: "workspace.info"; info: WorkspaceInfo }
  | { type: "config.updated"; config: HqConfig }
  | { type: "agent.updated"; agent: AgentStatus }
  | { type: "agent.removed"; agentId: string }
  | { type: "board.updated"; board: Board }
  | { type: "task.updated"; task: Task }
  | { type: "task.removed"; taskId: string }
  | { type: "pr.updated"; pr: PullRequest }
  | { type: "env.updated"; env: Environment }
  | { type: "env.removed"; name: string }
  | { type: "message"; message: AgentMessage }
  | { type: "activity"; event: ActivityEvent }
  | { type: "terminal.output"; agentId: string; data: string }
  | { type: "access.updated"; request: AccessRequest }
  | { type: "mcp.updated"; mcp: McpState }
  | { type: "accounts.updated"; accounts: AccountsState }
  | { type: "memory.updated"; memory: MemoryState }
  | { type: "spend.updated"; spend: SpendState }
  | { type: "githubApp.updated"; githubApp: GitHubAppState }
  | { type: "skillPacks.updated"; skillPacks: SkillPackView[] }
  | { type: "templates.updated"; templateLibrary: TemplateEntry[] }
  | { type: "lessons.updated"; lessons: LessonsState }
  /** Answer to exportTemplate: the file to download (only the device that asked saves it). */
  | { type: "template.file"; file: TemplateFile }
  | { type: "template.imported"; ok: boolean; message: string; id?: string }
  /** Memories to check: the daily digest, or at once when one may contradict a certified memory (`urgent`). For push only. */
  | { type: "memory.digest"; key: string; count: number; urgent: string | null }
  | { type: "action.updated"; item: ActionItem }
  | { type: "finding.updated"; finding: Finding }
  /** Remote step-up: a risky command from a tablet/phone needs a TOTP code. Handled inside wsSource. */
  | { type: "remote.stepup"; status: "required" | "ok" | "denied"; cmd?: string; args?: unknown[]; until?: number };

export type SimSpeed = 1 | 2 | 4;

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "unauthorized";

export interface DataPreset {
  id: string;
  label: string;
}

/** Controls that only exist on the mock source. The UI hides them when absent. */
export interface DevControls {
  presets: DataPreset[];
  loadPreset(id: string): void;
  setSpeed(multiplier: SimSpeed): void;
  /** Demo only: a random agent asks for a blocked domain. */
  simulateAccessRequest(): void;
}

export interface OfficeDataSource {
  connect(onEvent: (e: OfficeEvent) => void, onStatus?: (s: ConnectionStatus) => void): () => void; // returns disconnect

  sendTerminalInput(agentId: string, data: string): void;
  resizeTerminal(agentId: string, cols: number, rows: number): void;
  assignTask(taskId: string, agentId: string): void;
  /** Which CLI (and optionally model) a task must run on; null clears it. */
  setTaskRunsOn(taskId: string, cli: AgentCli | null, model: string | null): void;
  /** Triage a security finding. */
  updateFinding(id: string, patch: { status?: FindingStatus; severity?: Severity; verified?: boolean; cvss?: string }): void;
  /** You → an agent, delivered like any Team MCP message. */
  sendMessage(toId: string, text: string): void;

  // agent sessions
  startAgent(id: string): void;
  stopAgent(id: string): void;
  openWorkspace(id: string): void; // opens the agent's folder on the host
  /** Opens a plain shell in the agent's sandbox (or folder); output on terminal id `shell:<id>`. */
  openShell(id: string): void;
  closeShell(id: string): void;
  /** The Terminal panel: your own shell on this machine in `dir` (empty = the repo); terminal id `shell:@host`. */
  openHostShell(dir: string, fresh?: boolean): void;
  closeHostShell(): void;
  /** Makes a port inside the agent's sandbox reachable at localhost:<port> on this machine. */
  forwardPort(agentId: string, port: number): void;
  unforwardPort(agentId: string, port: number): void;
  /** Removes and recreates the agent's sandbox (e.g. to apply new CPU/memory). The folder is kept. */
  recreateSandbox(id: string): void;

  // setup checklist
  recheckSetup(): void;
  /** Runs a check's fix command in a visible terminal (output on terminal id `setup:<checkId>`). */
  runSetupFix(id: SetupCheckId): void;

  addAgent(input: NewAgentInput): void;
  updateAgent(id: string, patch: AgentPatch): void;
  /** Changes a role of the project's template: every seat of it, at its next start. */
  updateRole(roleId: string, patch: RolePatch): void;
  /** Stops the agent and removes it from the team; optionally deletes its sandbox and HQ-made folder. Ignored for the lead. */
  removeAgent(id: string, opts?: RemoveAgentOptions): void;
  /** Asks what removing would delete; answered with a `workspace.info` event. */
  inspectWorkspace(id: string): void;
  updateSandbox(agentId: string, patch: Partial<SandboxSettings>): void;
  /** A service key for one agent's sandbox, or every sandbox (agentId null). The value goes to sbx via stdin; HQ never keeps it. */
  setSecret(agentId: string | null, service: string, value: string): void;
  removeSecret(agentId: string | null, service: string): void;
  /** Machine-wide upstream proxy for sandbox traffic (null clears it). */
  setProxy(url: string | null): void;
  /** Creates the agent's env file if needed and opens it in the default editor. */
  openEnvFile(agentId: string): void;
  /** Closes an action item; HQ tells the agent (done: with your note; dismissed: continue without it). */
  resolveActionItem(id: string, decision: "done" | "dismissed", note?: string): void;

  // Accounts (machine-wide): API keys and cloud credentials, stored encrypted on the server
  saveAccount(input: AccountInput): void;
  removeAccount(id: string): void;
  saveMemory(input: MemoryInput): void;
  restoreMemory(date: string): void;
  setMemoryExtraction(input: { enabled: boolean; account: string }): void;
  /** Owner only: lifts the scope requirement for CTFs and practice ranges. */
  setLabMode(on: boolean): void;
  /** The project's template as a file; answered with a `template.file` event. */
  exportTemplate(): void;
  /** Imports a template file's text into this HQ's library; answered with `template.imported`. */
  importTemplate(text: string): void;
  /** Offers this project's certified lessons to its template (Haiku rewrite, then the owner approves each). */
  promoteLessons(): void;
  /** Allows or stops lesson promotion for this project. */
  setLessonPromotion(on: boolean): void;
  /** Takes an approved lesson out of the template. */
  removeLesson(id: string): void;
  proposeImprovements(): void;
  addToSuite(taskId: string): void;
  /** Owner only: per-project caps in USD on API-key accounts. */
  setSpendCaps(caps: { dailyUsd: number; monthlyUsd: number }): void;
  /** Owner only: trades GitHub's manifest code for the App's credentials. */
  finishGithubApp(code: string): void;
  /** Every seat to one mode: stopped seats now, running ones at their next start. */
  setTeamMode(mode: AgentMode): void;
  decideMemories(itemId: string, decisions: Record<string, "certify" | "reject">): void;
  keepOutOfMemory(name: string): void;

  // MCP servers (Docker Sandboxes' registry)
  refreshMcp(): void;
  addMcp(input: NewMcpServer): void;
  /** Runs `sbx mcp auth <name>` in a visible terminal (id `setup:mcp-auth-<name>`). */
  authMcp(name: string): void;
  /** Unregisters a server from sbx (affects every sandbox on this machine). */
  removeMcp(name: string): void;
  /** Which servers an agent gets. New ones are attached right away if it's running. */
  setAgentMcp(agentId: string, names: string[]): void;
  /** Answers requests an agent's sandbox blocked (sbx's approval queue). "all" with dismiss clears them all. */
  answerApproval(agentId: string, approvalId: string, decision: "allow" | "dismiss"): void;
  /** Re-reads policy rules, keys and proxy from sbx. */
  refreshSbx(): void;
  updateWorkflow(patch: WorkflowPatch): void;
  updateProject(patch: Partial<ProjectConfig>): void;
  createBoard(title: string): void;
  updateBoard(id: string, patch: Partial<Pick<Board, "title" | "status">>): void;

  /** The project's stack (null clears it). */
  updateStack(stack: StackConfig | null): void;
  /** Answers an agent's request_access: allow for that agent, for every agent, or deny. */
  resolveAccess(requestId: string, decision: AccessDecision): void;

  /** Finishes first-run setup: saves the project's team and review tool. */
  completeWelcome(input: WelcomeInput): void;

  dev?: DevControls;
}
