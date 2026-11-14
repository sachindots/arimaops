// In-memory state for the mock source. Every mutation goes through a helper
// that emits the matching OfficeEvent, so the store stays in sync.

import type { OfficeEvent, SimSpeed } from "../source";
import type {
  ActionItem,
  ActivityType,
  SbxState,
  SessionInfo,
  SetupState,
  AgentConfig,
  AgentStatus,
  Board,
  Environment,
  OfficeSnapshot,
  PullRequest,
  Task,
} from "../types";
import { mulberry32 } from "../../lib/random";
import type { Preset } from "./presets";
import { message as messageLines, slug, type TermLine } from "./terminalScripts";

interface Timer {
  at: number;
  fn: () => void;
  owner: string | null;
}

interface TermQueue {
  lines: TermLine[];
  pos: number; // chars of the head line already written (typed lines)
}

const now = () => new Date().toISOString();

/** The mock machine has everything installed. */
export function mockSetup(): SetupState {
  const ok = (id: SetupState["checks"][number]["id"], label: string, detail: string, neededFor: SetupState["checks"][number]["neededFor"]) =>
    ({ id, label, status: "ok" as const, detail, neededFor, fix: null });
  return {
    machine: { cpus: 8, memoryGb: 16 },
    checks: [
      ok("os", "Supported machine", "Linux · KVM ready (mock)", "sandbox"),
      ok("sbx", "Docker Sandboxes (sbx)", "v0.50.0 (mock)", "sandbox"),
      ok("sbx-login", "Signed in to Docker", "signed in (mock)", "sandbox"),
      ok("sbx-policy", "Sandbox network policy", "Balanced (mock)", "sandbox"),
      ok("tmux", "tmux", "3.5a (mock)", "all"),
      ok("agy", "Antigravity CLI (agy)", "v2.0 (mock)", "local"),
      ok("claude", "Claude Code", "installed (mock)", "local"),
      ok("codex", "Codex", "installed (mock)", "local"),
      ok("opencode", "OpenCode CLI", "installed (mock)", "local"),
      ok("gemini", "Gemini CLI", "installed (mock)", "local"),
      ok("gh", "GitHub CLI", "signed in (mock)", "github"),
    ],
    sandboxReady: true,
    localReady: true,
    containerReady: true,
    checkedAt: now(),
  };
}

/** What the mock "sbx" reports: domain rules mirror the saved lists. */
export function mockSbx(team: AgentConfig[], project: string): SbxState {
  const agents: SbxState["agents"] = {};
  for (const a of team) {
    let n = 0;
    const rule = (decision: "allow" | "deny", r: string, source: "hq" | "kit" = "hq") => ({ id: `${a.id}-${++n}`, decision, resources: [r], source });
    agents[a.id] = {
      rules: [
        rule("allow", "api.anthropic.com", "kit"),
        ...a.sandbox.allow.map((r) => rule("allow", r)),
        ...a.sandbox.deny.map((r) => rule("deny", r)),
      ],
      keys: a.isLead ? [] : ["openai"],
      envFile: { path: `~/.arima/${slug(project)}/${a.id}.env`, exists: !a.isLead },
      syncError: null,
      // Demo: the first worker's sandbox blocked a few things (claude.ai connectors and a docs site).
      approvals: !a.isLead && team.filter((t) => !t.isLead)[0]?.id === a.id
        ? ["mcp.notion.com:443", "mcp.figma.com:443", "docs.arcjet.com:443"].map((host, i) => ({ id: `network:demo-${a.id}-${i}`, host, detail: "no matching allow rule (default deny)" }))
        : [],
    };
  }
  return { basePolicy: "balanced", proxy: null, globalKeys: ["anthropic", "github"], agents, checkedAt: now() };
}

export function mockSession(project: string, agentId: string): SessionInfo {
  return { state: "running", detail: null, workspace: `~/.arima/${slug(project)}/${agentId}`, sandbox: { cpus: 8, memoryGb: 8 } };
}

export class World {
  snap: OfficeSnapshot;
  preset: Preset;
  simTime = 0;
  speed: SimSpeed = 1;
  rand = mulberry32(7);
  nextPr: number;
  private seq = 0;
  private timers: Timer[] = [];
  private term = new Map<string, TermQueue>();
  private emitFn: ((e: OfficeEvent) => void) | null = null;

  constructor(preset: Preset) {
    this.preset = preset;
    this.snap = World.initialSnapshot(preset);
    this.nextPr = preset.mergedPrs + 1;
  }

  static initialSnapshot(preset: Preset): OfficeSnapshot {
    const config = structuredClone(preset.config);
    const tasks = structuredClone(preset.tasks);
    const workers = config.team.filter((a) => !a.isLead);
    const pullRequests: PullRequest[] = tasks
      .filter((t) => t.prNumber !== null)
      .map((t) => ({
        number: t.prNumber as number,
        title: `[${t.id}] ${t.title}`,
        taskId: t.id,
        authorId: t.ownerId ?? workers[0]?.id ?? "",
        review: "passed",
        openComments: 0,
        mergeable: true,
        merged: true,
        openedAt: new Date(Date.now() - (preset.mergedPrs - (t.prNumber as number) + 1) * 3_600_000).toISOString(),
      }));
    return {
      setup: mockSetup(),
      sbx: mockSbx(config.team, config.project.name),
      config,
      agents: config.team.map((a) => ({
        agentId: a.id, state: "idle", currentTaskId: null, stateSince: now(), note: null,
        session: mockSession(config.project.name, a.id),
      })),
      boards: structuredClone(preset.boards),
      findings: structuredClone(preset.findings ?? []),
      tasks,
      pullRequests,
      environments: [],
      messages: [],
      activity: [],
      // Demo: a couple of requests from the first two workers.
      actionItems: preset.config.team
        .filter((a) => !a.isLead)
        .slice(0, 2)
        .map((a, n): ActionItem => ({
          id: `ai-demo-${n}`,
          fromId: a.id,
          taskId: null,
          title: n === 0 ? "Create a Supabase dev project and add its URL to my env file" : "Add the Clerk webhook secret to Vercel (Preview)",
          details:
            n === 0
              ? "1. Create a project at supabase.com (dev only).\n2. Settings → Sandbox → App variables for " + a.name + ":\n   NEXT_PUBLIC_SUPABASE_URL=<project URL>\n   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable key>\n3. Restart me."
              : "Vercel → Project → Settings → Environment Variables → add CLERK_WEBHOOK_SIGNING_SECRET for Preview.",
          waiting: n === 0,
          status: "open" as const,
          note: null,
          at: now(),
          closedAt: null,
        }))
        .concat([
          {
            id: "ai-demo-spec",
            fromId: preset.config.team.find((a) => a.isLead)?.id ?? "hq",
            taskId: null,
            title: "Approve the spec for Backlog (v2)?",
            details: "# Checkout\nS1. Card payments through Stripe Checkout.\nS2. An order email after payment.\nS3. Refunds from the admin page.\n\nApprove: every task on this board passes its spec gate until the spec changes. Send back: the lead rewrites it (add a note).",
            waiting: true,
            kind: "spec" as const,
            spec: { boardId: "B1", version: 2 },
            status: "open" as const,
            note: null,
            at: now(),
            closedAt: null,
          },
          {
            id: "ai-demo-gate",
            fromId: preset.config.team.find((a) => !a.isLead)?.id ?? "hq",
            taskId: "B1-T03",
            title: "Approve sending B1-T03: Launch email for the spring release?",
            details: "Deliverable: deliverables/drafts/launch-email.md\n\nNote: 3 subject lines, one body; the editor checked it against the brief.\n\nApprove: the drafts are ready and you'll send them yourself (agents can't send). Send back: the writer hears your note.",
            waiting: true,
            kind: "gate" as const,
            gate: { taskId: "B1-T03", gateId: "send-ok", reason: "outbound" },
            status: "open" as const,
            note: null,
            at: now(),
            closedAt: null,
          },
          {
            id: "ai-demo-skills",
            fromId: "hq",
            taskId: null,
            title: "Skills from clerk/skills wait for your check",
            details: "clerk/skills at commit 3f9c2a7d1e04: 8 skills, licence MIT.\nNothing blocked by the scanner.\n\nWorth a read before you approve:\n- skills/clerk-setup/SKILL.md:41: pipes a download into an interpreter\n\nApprove: agents get these skills at this commit only; a new commit needs a new approval. Reject: they're never installed.",
            waiting: false,
            kind: "skills" as const,
            pack: "clerk/skills",
            status: "open" as const,
            note: null,
            at: now(),
            closedAt: null,
          },
          {
            id: "ai-demo-overflow",
            fromId: preset.config.team.find((a) => !a.isLead)?.id ?? "hq",
            taskId: tasks[1]?.id ?? null,
            title: `${preset.config.team.find((a) => !a.isLead)?.name ?? "A worker"} hit the Claude Code limit until 15:00 on ${tasks[1]?.id ?? "T-2"}. Continue it on Codex (gpt-6.1-sol) now?`,
            details: `${tasks[1]?.title ?? "Rate limit the login"}\n\nMove: HQ stops it and starts it on Codex for this task only, with a handoff. Its role stays Claude Code.\nWait: nothing changes; it goes on at 15:00.`,
            waiting: true,
            kind: "overflow" as const,
            overflow: { agentId: preset.config.team.find((a) => !a.isLead)?.id ?? "hq", taskId: tasks[1]?.id ?? "T-2", cli: "codex" as const, model: "gpt-6.1-sol" },
            status: "open" as const,
            note: null,
            at: now(),
            closedAt: null,
          },
          {
            id: "ai-demo-approval",
            fromId: preset.config.team.find((a) => a.isLead)?.id ?? "hq",
            taskId: tasks[0]?.id ?? null,
            title: `${preset.config.team.find((a) => a.isLead)?.name ?? "The lead"} approved spec-ok on ${tasks[0]?.id ?? "T-1"} while you were away`,
            details: `${tasks[0]?.title ?? "Sign-in flow"}\n\nThe lead's note: the spec covers every item in the brief; rate limits are S4.\n\nKeep it, or Undo: the gate waits for you again and the task goes back to that stage.`,
            waiting: false,
            kind: "approval" as const,
            approval: { gateId: "spec-ok", stageId: "spec" },
            status: "open" as const,
            note: null,
            at: now(),
            closedAt: null,
          },
          {
            id: "ai-demo-memory",
            fromId: "hq",
            taskId: tasks.find((t) => t.status === "done")?.id ?? null,
            title: "3 memories to check",
            details: "",
            waiting: false,
            kind: "memory" as const,
            memories: [
              { id: "M-41", type: "DeadEnd", text: "Polling Clerk's session endpoint for sign-out missed revoked sessions; the webhook is the only reliable signal.", about: ["app/api/webhooks/clerk/route.ts"], conflict: null },
              { id: "M-42", type: "Decision", text: "Rate limits live in middleware.ts, before auth, so anonymous floods never reach the database.", about: ["middleware.ts"], conflict: { id: "M-17", text: "Rate limits run per route handler so each route sets its own budget." } },
              { id: "M-43", type: "Lesson", text: "Supabase row-level security must be enabled before seeding, or the seed script writes rows nobody can read back.", about: ["supabase/seed.sql"], conflict: null },
            ],
            status: "open" as const,
            note: null,
            at: now(),
            closedAt: null,
          },
        ]),
      lessons: {
        templateId: preset.config.template?.id ?? "dev",
        enabled: true,
        approved: [
          { id: "L-demo1", templateId: preset.config.template?.id ?? "dev", type: "Lesson", text: "Enable row-level security before seeding a Postgres database, or the seed writes rows nobody can read back.", status: "approved" as const, createdAt: now() },
          { id: "L-demo2", templateId: preset.config.template?.id ?? "dev", type: "Decision", text: "Rate limits run in middleware before auth, so anonymous floods never reach the database.", status: "approved" as const, createdAt: now() },
        ],
        pending: 0,
        running: false,
        improvements: { running: false, pending: 0, last: null },
        last: null,
      },
      skillPacks: [
        { source: "trailofbits/skills", commit: "e4dd0bb5b15535f7c5a0834187dffba6ac37e4ff", licence: "CC-BY-SA-4.0", credit: "Trail of Bits", use: "any" as const, skills: 98, status: "vetted" as const, blocked: [], warnings: 0 },
        { source: "cloudflare/security-audit-skill", commit: "c1c8a8c1471069fb0e188eeaff69b8e8db6564a8", licence: "MIT", credit: "Cloudflare", use: "any" as const, skills: 1, status: "vetted" as const, blocked: [], warnings: 0 },
        { source: "elementalsouls/Claude-BugHunter", commit: "4a2d93e887fa4dfdc91da78bd614418b5837b535", licence: "MIT", credit: "elementalsouls", use: "scoped-offensive" as const, skills: 83, status: "vetted" as const, blocked: [], warnings: 0 },
        { source: "anthropics/claude-code-security-review", commit: "0c6a49f1fa56a1d472575da86a94dbc1edb78eda", licence: "MIT", credit: "Anthropic", use: "github-action" as const, skills: 0, status: "vetted" as const, blocked: [], warnings: 0 },
        { source: "clerk/skills", commit: "3f9c2a7d1e0400000000000000000000000000aa", licence: "MIT", credit: null, use: "any" as const, skills: 8, status: "pending" as const, blocked: [], warnings: 1 },
      ],
      spend: { day: { usd: 4.12, cap: 5 }, month: { usd: 31.4, cap: 50 }, paused: null, unpriced: 3 },
      memory: {
        source: "env" as const,
        url: "bolt://127.0.0.1:7687",
        user: "neo4j",
        passwordSet: true,
        browserUrl: null,
        status: "online" as const,
        queued: 0,
        extraction: { enabled: true, account: "default" },
        keepOut: ["Ravi Kumar"],
        backups: [0, 1, 2].map((d) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10)),
      },
      mcp: {
        servers: [
          { name: "supabase-dev", transport: "remote http", status: "ready", nextStep: null },
          { name: "stripe", transport: "remote http", status: "needs-auth", nextStep: "sbx mcp auth stripe" },
          { name: "trigger", transport: "local stdio", status: "ready", nextStep: null },
        ],
        attached: {},
        error: null,
        checkedAt: now(),
      },
    };
  }

  setEmitter(fn: ((e: OfficeEvent) => void) | null) {
    this.emitFn = fn;
  }

  emit(e: OfficeEvent) {
    this.emitFn?.(e);
  }

  id(prefix: string) {
    this.seq += 1;
    return `${prefix}${this.seq}`;
  }

  // ------------------------------------------------------------ clock

  after(sec: number, fn: () => void, owner: string | null = null) {
    this.timers.push({ at: this.simTime + sec, fn, owner });
  }

  cancel(owner: string) {
    this.timers = this.timers.filter((t) => t.owner !== owner);
  }

  clearTimers() {
    this.timers = [];
    this.term.clear();
  }

  advance(dt: number) {
    this.simTime += dt;
    const due = this.timers.filter((t) => t.at <= this.simTime).sort((a, b) => a.at - b.at);
    if (!due.length) return;
    this.timers = this.timers.filter((t) => t.at > this.simTime);
    for (const t of due) t.fn();
  }

  // ------------------------------------------------------------ lookups

  cfg(id: string): AgentConfig | undefined {
    return this.snap.config.team.find((a) => a.id === id);
  }

  status(id: string): AgentStatus | undefined {
    return this.snap.agents.find((a) => a.agentId === id);
  }

  lead(): AgentConfig {
    return this.snap.config.team.find((a) => a.isLead) ?? this.snap.config.team[0];
  }

  workers(): AgentConfig[] {
    return this.snap.config.team.filter((a) => !a.isLead);
  }

  name(id: string | null): string {
    if (id === "you") return "You";
    return (id && this.cfg(id)?.name) || "Someone";
  }

  task(id: string): Task | undefined {
    return this.snap.tasks.find((t) => t.id === id);
  }

  pr(num: number): PullRequest | undefined {
    return this.snap.pullRequests.find((p) => p.number === num);
  }

  activeBoards(): Board[] {
    return this.snap.boards.filter((b) => b.status === "active").sort((a, b) => a.order - b.order);
  }

  reviewerLabel(): string {
    const r = this.snap.config.workflow.review;
    return { coderabbit: "CodeRabbit", greptile: "Greptile", copilot: "Copilot", human: "you", custom: "the review check" }[r.tool];
  }

  mergerLabel(): string {
    return this.snap.config.workflow.merge.by === "lead" ? this.lead().name : "you";
  }

  // ------------------------------------------------------------ mutations

  setStatus(id: string, patch: Partial<Omit<AgentStatus, "agentId">>) {
    const s = this.status(id);
    if (!s) return;
    const stateChanged = patch.state !== undefined && patch.state !== s.state;
    Object.assign(s, patch);
    if (stateChanged) s.stateSince = now();
    this.emit({ type: "agent.updated", agent: { ...s } });
  }

  putTask(task: Task) {
    const i = this.snap.tasks.findIndex((t) => t.id === task.id);
    if (i === -1) this.snap.tasks.push(task);
    else this.snap.tasks[i] = task;
    this.emit({ type: "task.updated", task: { ...task } });
  }

  patchTask(id: string, patch: Partial<Task>) {
    const t = this.task(id);
    if (t) this.putTask({ ...t, ...patch });
  }

  putPr(pr: PullRequest) {
    const i = this.snap.pullRequests.findIndex((p) => p.number === pr.number);
    if (i === -1) this.snap.pullRequests.push(pr);
    else this.snap.pullRequests[i] = pr;
    this.emit({ type: "pr.updated", pr: { ...pr } });
  }

  patchPr(num: number, patch: Partial<PullRequest>) {
    const p = this.pr(num);
    if (p) this.putPr({ ...p, ...patch });
  }

  putEnv(env: Environment) {
    const i = this.snap.environments.findIndex((e) => e.name === env.name);
    if (i === -1) this.snap.environments.push(env);
    else this.snap.environments[i] = env;
    this.emit({ type: "env.updated", env: { ...env } });
  }

  removeEnv(name: string) {
    this.snap.environments = this.snap.environments.filter((e) => e.name !== name);
    this.emit({ type: "env.removed", name });
  }

  envUrl(name: string): string {
    const p = slug(this.snap.config.project.name);
    const tool = this.snap.config.workflow.deploy.tool;
    if (tool === "instacloud") return `https://${name === "main" ? p : `${name}-${p}`}.instacloud.app`;
    if (tool === "vercel") return `https://${p}${name === "main" ? "" : `-git-${name}`}.vercel.app`;
    return `http://${name}.${p}.local`;
  }

  /** Makes the environment list match the workflow config. */
  syncEnvironments() {
    const d = this.snap.config.workflow.deploy;
    const want = d.enabled ? ["main", ...(d.perAgentEnvironments ? this.workers().map((a) => a.id) : [])] : [];
    for (const env of [...this.snap.environments]) if (!want.includes(env.name)) this.removeEnv(env.name);
    for (const name of want) {
      const existing = this.snap.environments.find((e) => e.name === name);
      const url = this.envUrl(name);
      if (!existing || existing.url !== url)
        this.putEnv({
          name,
          agentId: name === "main" ? null : name,
          url,
          status: existing?.status ?? "live",
          lastDeployAt: existing?.lastDeployAt ?? new Date(Date.now() - 40 * 60_000).toISOString(),
        });
    }
  }

  deploy(name: string) {
    const env = this.snap.environments.find((e) => e.name === name);
    if (!env) return;
    this.putEnv({ ...env, status: "deploying" });
    this.after(3, () => {
      const cur = this.snap.environments.find((e) => e.name === name);
      if (cur) this.putEnv({ ...cur, status: "live", lastDeployAt: now() });
    });
  }

  configChanged() {
    this.emit({ type: "config.updated", config: structuredClone(this.snap.config) });
  }

  activity(type: ActivityType, agentId: string | null, text: string) {
    const event = { id: this.id("a"), at: now(), type, agentId, text };
    this.snap.activity = [event, ...this.snap.activity].slice(0, 50);
    this.emit({ type: "activity", event });
  }

  /** A Team MCP message: shows in both terminals, the messages list and the feed. */
  message(fromId: string, toId: string, text: string) {
    const msg = { id: this.id("m"), at: now(), fromId, toId, text };
    this.snap.messages = [msg, ...this.snap.messages].slice(0, 100);
    this.emit({ type: "message", message: msg });
    this.activity("message", fromId === "you" ? null : fromId, `${this.name(fromId)} → ${this.name(toId)}: ${text}`);
    if (fromId !== "you") this.write(fromId, messageLines(this.name(fromId), this.name(toId), text, false));
    this.write(toId, messageLines(this.name(fromId), this.name(toId), text, true));
  }

  // ------------------------------------------------------------ terminal

  write(agentId: string, lines: TermLine[]) {
    const q = this.term.get(agentId) ?? { lines: [], pos: 0 };
    q.lines.push(...lines);
    this.term.set(agentId, q);
  }

  /** Streams queued terminal output. `chars` is the typing budget for this tick. */
  flushTerminals(chars: number) {
    for (const [agentId, q] of this.term) {
      let budget = chars;
      let out = "";
      while (q.lines.length && budget > 0) {
        const line = q.lines[0];
        if (!line.typed) {
          out += line.text + "\r\n";
          q.lines.shift();
          budget -= 4;
          continue;
        }
        let p = q.pos;
        while (p < line.text.length && budget > 0) {
          if (line.text[p] === "\x1b") {
            const end = line.text.indexOf("m", p);
            p = end === -1 ? line.text.length : end + 1;
          } else {
            p += 1;
            budget -= 1;
          }
        }
        out += line.text.slice(q.pos, p);
        q.pos = p;
        if (p >= line.text.length) {
          out += "\r\n";
          q.lines.shift();
          q.pos = 0;
        }
      }
      if (out) this.emit({ type: "terminal.output", agentId, data: out });
    }
  }
}
