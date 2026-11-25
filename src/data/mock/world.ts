// In-memory state for the mock source. Every mutation goes through a helper
// that emits the matching OfficeEvent, so the store stays in sync.

import type { VisualDecision } from "../generated";
import type { OfficeEvent, SimSpeed } from "../source";
import { withMockForm } from "./mockDecisionForms";
import type {
  ActionItem,
  ActivityType,
  EgressState,
  SbxState,
  SessionInfo,
  SetupState,
  AgentConfig,
  AgentStatus,
  Board,
  Environment,
  HqConfig,
  OfficeSnapshot,
  PullRequest,
  Task,
} from "../types";
import type { JsonValue } from "../generated";
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
function mockEgress(): EgressState {
  const seen = (host: string, port: number, agents: string[], count: number) => ({ host, port, agents, count, firstSeen: now(), lastSeen: now() });
  return { mode: "observe", rules: [], wouldBlock: [seen("api.stripe.com", 443, ["nova"], 14), seen("auth.example.dev", 8443, ["nova", "vale"], 3)] };
}

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
      envFile: { path: `~/.arima/${slug(project)}/${a.id}.env`, exists: !a.isLead, keys: a.isLead ? [] : ["DATABASE_URL"] },
      syncError: null,
      // Demo: the first worker's sandbox blocked a few things (claude.ai connectors and a docs site).
      approvals: !a.isLead && team.filter((t) => !t.isLead)[0]?.id === a.id
        ? ["mcp.notion.com:443", "mcp.figma.com:443", "docs.arcjet.com:443"].map((host, i) => ({ id: `network:demo-${a.id}-${i}`, host, detail: "no matching allow rule (default deny)" }))
        : [],
    };
  }
  return { basePolicy: "balanced", egress: mockEgress(), globalKeys: ["anthropic", "github"], projectEnv: { path: `~/.arima/${slug(project)}/project.env`, exists: true, keys: ["GH_TOKEN"] }, agents, checkedAt: now() };
}

export function mockSession(project: string, agentId: string): SessionInfo {
  return { state: "running", detail: null, workspace: `~/.arima/${slug(project)}/${agentId}`, sandbox: { cpus: 8, memoryGb: 8 } };
}

/** Demo tasks sit in a stage of the demo flow by their status, so the flow canvas has live counts. */
function demoStage(config: HqConfig, status: Task["status"]): string | undefined {
  const ids = config.template?.flow.stages.map((x) => x.id) ?? [];
  const want = { todo: ids[1] ?? ids[0], "in-progress": "build", blocked: "build", "in-review": "review", done: ids.at(-1) }[status];
  return want && ids.includes(want) ? want : ids[0];
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
    for (const t of tasks) t.stageId ??= demoStage(config, t.status);
    const workers = config.team.filter((a) => !a.isLead);
    // Attach a clean inline SVG evidence screenshot to the first task with a PR so the
    // Verifier Evidence -> Annotate Freeze & Draw modal works interactively in ?mock=1.
    const evidenceTask = tasks.find((t) => t.prNumber !== null) ?? tasks[0];
    if (evidenceTask && !evidenceTask.evidence) {
      const demoSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500"><rect width="800" height="500" fill="#0c1322"/><rect x="0" y="0" width="800" height="56" fill="#131d31"/><circle cx="28" cy="28" r="6" fill="#06b6d4"/><text x="46" y="33" fill="#f1f5f9" font-family="Inter,sans-serif" font-size="16" font-weight="600">${config.project.name} · Verification Capture</text><rect x="40" y="88" width="720" height="168" rx="12" fill="#131d31" stroke="#334155"/><text x="64" y="128" fill="#f1f5f9" font-family="Inter,sans-serif" font-size="18" font-weight="600">Knowledge Upload Dropzone (Streamed 25 MB)</text><text x="64" y="158" fill="#94a3b8" font-family="Inter,sans-serif" font-size="14">Drop PDF or Markdown files here · GFM tables preserved across chunk boundaries</text><rect x="64" y="184" width="210" height="40" rx="8" fill="#06b6d4"/><text x="90" y="209" fill="#04131a" font-family="Inter,sans-serif" font-size="14" font-weight="600">Upload &amp; Chunk Document</text><rect x="40" y="284" width="720" height="160" rx="12" fill="#131d31" stroke="#334155"/><text x="64" y="324" fill="#10b981" font-family="Inter,sans-serif" font-size="14" font-weight="600">Edge Sliding-Window Active · 288 / 300 requests remaining</text><text x="64" y="356" fill="#94a3b8" font-family="Inter,sans-serif" font-size="13">Viewport: 1280×800 · 0 console errors · All visual checks passed</text></svg>`;
      evidenceTask.evidence = {
        sha: "a4f92c1e7b03",
        prNumber: evidenceTask.prNumber,
        by: workers[1]?.id ?? workers[0]?.id ?? "hq",
        at: new Date(Date.now() - 18 * 60_000).toISOString(),
        steps: [
          "Loaded /knowledge/upload at 1280×800 in isolated preview proxy",
          "Uploaded 18 MB sample PDF and verified streaming progress & chunk summary",
          "Confirmed 0 console errors and intact Markdown table rendering",
        ],
        shots: [
          {
            file: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(demoSvg)}`,
            label: "Desktop 1280×800 — Upload & Rate Limit Status",
          },
        ],
      };
    }
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
      // Demo: the team's messages, as tagged short notes (and one older chatty one, tidied when shown).
      messages: (() => {
        const lead = config.team.find((a) => a.isLead);
        const [w1, w2] = workers;
        if (!lead || !w1) return [];
        const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
        return [
          { id: "m-demo4", at: at(2), fromId: w1.id, toId: lead.id, text: "PR #14 is up for P3-T01. Upload handles PDF and Markdown; `pnpm test upload` passes.", kind: "done" as const, taskId: "P3-T01" },
          { id: "m-demo3", at: at(9), fromId: (w2 ?? w1).id, toId: lead.id, text: "Need SUPABASE_URL in my App variables to run the chat route locally.", kind: "blocked" as const, taskId: "P3-T02" },
          { id: "m-demo2", at: at(14), fromId: lead.id, toId: w1.id, text: "Should uploads over 20 MB fail fast, or go to the background queue?", kind: "question" as const, taskId: "P3-T01" },
          { id: "m-demo1", at: at(31), fromId: w1.id, toId: lead.id, text: "Hi Cipher, great question! I looked into the knowledge upload and here is what I found.\nThe parser lives in src/knowledge/parse.ts and handles PDF via pdfjs.\nMarkdown goes through the same chunker.\nLarge files are read fully into memory, which may be a problem above 50 MB.\nI suggest streaming them:\n```ts\nfor await (const chunk of stream) chunker.push(chunk);\n```\nLet me know if you'd like me to make that change!\n\nBest,\nVortex", taskId: "P3-T01" },
        ];
      })(),
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
        last: null,
      },
      goals: [
        { id: "G1", title: "Launch the knowledge base", metric: "Help articles live", target: "40", current: "26", status: "active" as const, done: 3, total: 7, usd: 4.12 },
        { id: "G2", title: "Cut first-reply time", metric: "Median reply", target: "2 min", current: "3.5 min", status: "active" as const, done: 1, total: 4, usd: 1.08 },
      ],
      freeModels: {
        checkedAt: now(),
        error: null,
        models: [
          { id: "opencode/glm-5.3-flash-free", source: "opencode" as const, name: "GLM-5.3-Flash Free", family: "glm-flash", context: 200000, reasoning: true, released: "2026-08-26" },
          { id: "opencode/deepseek-v4.1-flash-free", source: "opencode" as const, name: "DeepSeek V4.1 Flash Free", family: "deepseek", context: 128000, reasoning: true, released: "2026-09-10" },
          { id: "opencode/big-pickle", source: "opencode" as const, name: "Big Pickle", family: "", context: 200000, reasoning: false, released: "2026-06-01" },
          { id: "nvidia/deepseek-ai/deepseek-v4.1-flash", source: "nvidia" as const, name: "DeepSeek V4.1 Flash", family: "deepseek", context: 128000, reasoning: true, released: "2026-09-10" },
        ],
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
        extraction: { enabled: true, account: "default" },
        keepOut: ["Ravi Kumar"],
        backups: [0, 1, 2].map((d) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10)),
      },
      mcp: {
        servers: [
          { name: "supabase-dev", transport: { kind: "http", url: "https://mcp.supabase.com/mcp" }, hasKey: true, source: { kind: "manual" }, toolsSha256: null, blocked: null, check: { ok: true, error: null, at: new Date().toISOString() } },
          { name: "stripe", transport: { kind: "http", url: "https://mcp.stripe.com" }, hasKey: false, source: { kind: "manual" }, toolsSha256: null, blocked: null, check: null },
          { name: "trigger", transport: { kind: "http", url: "https://mcp.trigger.dev/mcp" }, hasKey: false, source: { kind: "manual" }, toolsSha256: null, blocked: null, check: { ok: false, error: "trigger answered 503 Service Unavailable.", at: new Date().toISOString() } },
        ],
        attached: {},
        others: [{ projectId: "proj-site", project: "Marketing site", name: "posthog" }],
        toolsAsCode: false,
        error: null,
        checkedAt: now(),
      },
      visualDecisions: (() => {
        const lead = config.team.find((a) => a.isLead) ?? config.team[0];
        const w1 = workers[0] ?? lead;
        const w2 = workers[1] ?? w1;
        const t1 = tasks[0]?.id ?? "P3-T01";
        const t2 = tasks[1]?.id ?? "P3-T02";
        const pid = config.project.id;
        const list: VisualDecision[] = [
          {
            id: "vd-question-1",
            projectId: pid,
            fromId: lead?.id ?? "hq",
            taskId: t1,
            title: "Knowledge ingestion architecture & file-size limits",
            details: "Before finalizing the ingestion pipeline, confirm the streaming upload cap and extraction options.",
            waiting: true,
            ownerOnly: false,
            status: "open" as const,
            form: null,
            answer: null,
            createdAt: now(),
            closedAt: null,
            note: null,
            payload: {
              kind: "question" as const,
              questions: [
                {
                  id: "q-upload-limit",
                  prompt: "What should the maximum single-file upload limit be for PDF and Markdown documents?",
                  multiSelect: false,
                  allowOther: true,
                  options: [
                    {
                      id: "opt-25mb",
                      label: "25 MB (streamed chunks)",
                      description: "Stream directly through the chunker with bounded 4 MB memory buffers.",
                      recommended: true,
                    },
                    {
                      id: "opt-10mb",
                      label: "10 MB (strict synchronous)",
                      description: "Reject larger files at the edge before parsing.",
                      recommended: false,
                    },
                    {
                      id: "opt-100mb",
                      label: "100 MB (background worker queue)",
                      description: "Spool to object storage and process asynchronously.",
                      recommended: false,
                    },
                  ],
                },
                {
                  id: "q-extract-features",
                  prompt: "Which extraction features should be enabled for this board?",
                  multiSelect: true,
                  allowOther: false,
                  options: [
                    {
                      id: "opt-md-tables",
                      label: "Markdown table preservation",
                      description: "Keep GFM table headers intact across chunk boundaries.",
                      recommended: true,
                    },
                    {
                      id: "opt-code-fences",
                      label: "Syntax-aware code blocks",
                      description: "Never split inside fenced code blocks.",
                      recommended: true,
                    },
                    {
                      id: "opt-ocr-scan",
                      label: "Scanned PDF OCR fallback",
                      description: "Run OCR on image-only pages (adds 1.2s per page).",
                      recommended: false,
                    },
                  ],
                },
              ],
              answers: [],
            },
          },
          {
            id: "vd-second-opinion-1",
            projectId: pid,
            fromId: lead?.id ?? "hq",
            taskId: t2,
            title: "Second Opinion: Edge rate-limiting vs per-route token bucket",
            details: "High-stakes gate review: two models compared rate-limiting architectures for the public chat endpoint.",
            waiting: true,
            ownerOnly: true,
            status: "open" as const,
            form: null,
            answer: null,
            createdAt: now(),
            closedAt: null,
            note: null,
            payload: {
              kind: "second-opinion" as const,
              taskId: t2,
              gateId: "second-opinion",
              recommendation: "Option A (Edge Middleware Sliding Window) stops abusive traffic before hitting Postgres.",
              confidence: "High (92%)",
              canWaiveGate: true,
              chosenSide: null,
              optionA: {
                label: "Option A: Edge Middleware Sliding Window",
                authorId: w1?.id ?? "hq",
                summary: "Enforce IP + session sliding-window limits in middleware before database lookup.",
                rationaleMarkdown:
                  "### Why Option A\n- Rejects unauthenticated floods in **< 0.4 ms**.\n- Zero database connection pool pressure during traffic spikes.\n- Uses atomic in-memory counters with automatic TTL eviction.",
                risks: ["Shared corporate NAT IPs could hit the anonymous tier limit faster."],
              },
              optionB: {
                label: "Option B: Per-Route Postgres Token Bucket",
                authorId: w2?.id ?? "hq",
                summary: "Store per-user token buckets in Postgres and check inside each route handler.",
                rationaleMarkdown:
                  "### Why Option B\n- Custom per-workspace quota weights stored alongside user billing rows.\n- Exact transactional consistency across multi-node deployments.",
                risks: [
                  "Every blocked flood request still consumes a Postgres connection and write lock.",
                  "Adds 6-12 ms latency to every chat turn.",
                ],
              },
            },
          },
          {
            id: "vd-permission-1",
            projectId: pid,
            fromId: w1?.id ?? "hq",
            taskId: t1,
            title: "Allow database migration command in workspace?",
            details: "Requested via arima-shim permission bridge while running integration tests.",
            waiting: true,
            ownerOnly: false,
            status: "open" as const,
            form: null,
            answer: null,
            createdAt: now(),
            closedAt: null,
            note: null,
            payload: {
              kind: "permission" as const,
              toolName: "bash",
              commandOrPath: "pnpm db:migrate --apply 004_knowledge_chunks.sql",
              reason: "Apply the vector chunk index migration to the local dev SQLite database before running upload tests.",
              scopeHint: `workspace: ~/.arima/${slug(config.project.name)}/${w1?.id ?? "agent"}`,
              resolution: null,
            },
          },
          {
            id: "vd-meeting-req-1",
            projectId: pid,
            fromId: lead?.id ?? "hq",
            taskId: null,
            title: "Morning Standup & Blocker Sync",
            details: "Review P3-T01 upload streaming, resolve the P3-T02 rate-limit gate, and commit sprint tasks.",
            waiting: true,
            ownerOnly: false,
            status: "open" as const,
            form: null,
            answer: null,
            createdAt: now(),
            closedAt: null,
            note: null,
            payload: {
              kind: "meeting-request" as const,
              meetingId: "mtg-standup-1",
              meetingKind: "standup" as const,
              urgency: "normal" as const,
              participantIds: config.team.map((a) => a.id),
              agendaPreview: [
                "P3-T01 PDF & Markdown streaming upload progress",
                "P3-T02 Rate-limit Second Opinion gate resolution",
                "Live Preview verification on :3000",
              ],
            },
          },
          {
            id: "vd-form-1",
            projectId: pid,
            fromId: lead?.id ?? "hq",
            taskId: t1,
            title: "Set up the upload bucket",
            details: "I need a few details before I create the storage bucket for document uploads.",
            waiting: true,
            ownerOnly: false,
            status: "open" as const,
            form: null,
            answer: null,
            createdAt: now(),
            closedAt: null,
            note: null,
            payload: {
              kind: "form" as const,
              answer: null,
              form: {
                components: [
                  { id: "root", component: "Column", children: ["intro", "bucket", "region", "features", "plans", "quota", "uploads", "go"] },
                  { id: "intro", component: "Text", text: { "@path": "/intro" } },
                  { id: "bucket", component: "TextField", label: "Bucket name", value: { "@path": "/bucket" }, placeholder: "acme-uploads" },
                  { id: "region", component: "Select", label: "Region", value: { "@path": "/region" }, options: [{ value: "eu-west", label: "Europe (Ireland)" }, { value: "us-east", label: "US East (Virginia)" }] },
                  { id: "features", component: "CheckList", label: "Extras", multi: true, values: { "@path": "/features" }, options: [{ value: "versioning", label: "Versioning", description: "Keep old copies of overwritten files." }, { value: "encryption", label: "Encryption at rest" }] },
                  { id: "plans", component: "Table", columns: ["Storage class", "Price per GB", "First byte"], rows: [["Standard", "$0.023", "ms"], ["Infrequent access", "$0.0125", "ms"], ["Archive", "$0.004", "hours"]] },
                  { id: "quota", component: "Meter", label: "Storage used", value: { "@path": "/used" }, max: 100 },
                  { id: "uploads", component: "Chart", label: "Uploads per day", points: [4, 7, 5, 9, 12, 10, 15] },
                  { id: "go", component: "ButtonRow", buttons: [{ label: "Create bucket", variant: "primary", action: { event: { name: "create", context: { bucket: { "@path": "/bucket" } } } } }, { label: "Not yet", action: { event: { name: "later" } } }] },
                ] as JsonValue[],
                data: { intro: "Uploads go to one bucket per project.", bucket: "", region: "eu-west", features: [], used: 38 },
              },
            },
          },
        ];
        return list.map((d) => withMockForm(d, config.team));
      })(),
      meetings: (() => {
        const lead = config.team.find((a) => a.isLead) ?? config.team[0];
        const w1 = workers[0] ?? lead;
        const w2 = workers[1] ?? w1;
        return [
          {
            id: "mtg-standup-1",
            projectId: config.project.id,
            kind: "standup" as const,
            status: "live" as const,
            urgency: "normal" as const,
            title: "Morning Standup & Blocker Sync",
            moderatorId: lead?.id ?? "hq",
            participantIds: config.team.map((a) => a.id),
            requestedBy: lead?.id ?? "hq",
            voiceEnabled: false,
            voiceProvider: "browser-web-speech" as const,
            createdAt: new Date(Date.now() - 12 * 60_000).toISOString(),
            startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
            closedAt: null,
            agenda: [
              {
                id: "ag-1",
                title: "P3-T01 PDF & Markdown streaming upload",
                status: "done",
                ownerId: w1?.id ?? null,
                recommendationDecisionId: "vd-question-1",
              },
              {
                id: "ag-2",
                title: "P3-T02 Rate-limit architecture A/B review",
                status: "active",
                ownerId: w2?.id ?? null,
                recommendationDecisionId: "vd-second-opinion-1",
              },
              {
                id: "ag-3",
                title: "Live Preview & sprint goal alignment",
                status: "pending",
                ownerId: lead?.id ?? null,
                recommendationDecisionId: null,
              },
            ],
            minutes: {
              summaryMarkdown:
                "### Standup Summary\n- **Upload Pipeline (P3-T01):** Streamed 25 MB chunker is ready with GFM table preservation.\n- **Rate Limiting (P3-T02):** Team recommends Option A (Edge Middleware Sliding Window) to keep Postgres off the hot path.\n- **Next Steps:** Verify the knowledge upload UI in Live Preview and merge PR #14.",
              decisions: [
                {
                  id: "pd-1",
                  title: "Enforce rate limits in edge middleware before auth",
                  rationale: "Protects Postgres connection pool from anonymous floods and keeps p99 latency under 1 ms.",
                  saveToMemory: true,
                },
                {
                  id: "pd-2",
                  title: "Cap single-file uploads at 25 MB with 4 MB streaming buffers",
                  rationale: "Balances large technical PDF support with predictable container memory usage.",
                  saveToMemory: true,
                },
              ],
              proposedTasks: [
                {
                  id: "pt-1",
                  title: "Add sliding-window rate limiter middleware + unit tests",
                  boardId: preset.boards[0]?.id ?? "B1",
                  assigneeId: w1?.id ?? null,
                  stageId: "build",
                  description: "Implement edge sliding-window limiter with 60 req/min anonymous and 300 req/min authenticated tiers.",
                  approved: true,
                },
                {
                  id: "pt-2",
                  title: "Verify knowledge upload progress bar in Live Preview",
                  boardId: preset.boards[0]?.id ?? "B1",
                  assigneeId: w2?.id ?? null,
                  stageId: "review",
                  description: "Run visual check on the upload dropzone and attach evidence screenshots.",
                  approved: true,
                },
              ],
              agentInstructions: [
                {
                  agentId: w1?.id ?? "hq",
                  instruction: "Proceed with 25 MB streaming chunks and preserve Markdown tables across chunk boundaries.",
                  approved: true,
                },
                {
                  agentId: w2?.id ?? "hq",
                  instruction: "Implement Option A (Edge Middleware Sliding Window) for P3-T02 and close the second-opinion gate.",
                  approved: true,
                },
              ],
              committedAt: null,
            },
          },
        ];
      })(),
      meetingTurns: (() => {
        const lead = config.team.find((a) => a.isLead) ?? config.team[0];
        const w1 = workers[0] ?? lead;
        const w2 = workers[1] ?? w1;
        const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
        return {
          "mtg-standup-1": [
            {
              id: "mt-1",
              meetingId: "mtg-standup-1",
              speakerId: lead?.id ?? "hq",
              speakerRole: lead?.role ?? "Lead",
              kind: "moderator-open",
              bodyMarkdown:
                "Good morning! I called this standup to lock in the **25 MB streaming upload cap** on `P3-T01` and resolve the **Second Opinion rate-limit gate** on `P3-T02`.",
              decisionId: null,
              spokenText: "Good morning! Let's lock in the 25 megabyte upload cap and resolve the rate-limit second opinion gate.",
              createdAt: at(10),
            },
            {
              id: "mt-2",
              meetingId: "mtg-standup-1",
              speakerId: w1?.id ?? "hq",
              speakerRole: w1?.role ?? "Developer",
              kind: "update",
              bodyMarkdown:
                "Streaming PDF and Markdown chunker is passing local tests. I recommend **25 MB with GFM table preservation** below so we don't spike container RAM.",
              decisionId: "vd-question-1",
              spokenText: "Streaming PDF and Markdown chunker is passing tests. I recommend 25 megabytes with table preservation.",
              createdAt: at(8),
            },
            {
              id: "mt-3",
              meetingId: "mtg-standup-1",
              speakerId: w2?.id ?? "hq",
              speakerRole: w2?.role ?? "Developer",
              kind: "disagreement",
              bodyMarkdown:
                "For `P3-T02`, we compared **Option A (Edge Middleware Sliding Window)** against **Option B (Postgres Token Bucket)**. Option A avoids DB connection exhaustion during floods.",
              decisionId: "vd-second-opinion-1",
              spokenText: "For P3-T02, we compared Edge Middleware against Postgres Token Bucket. Option A avoids database connection exhaustion.",
              createdAt: at(5),
            },
            {
              id: "mt-4",
              meetingId: "mtg-standup-1",
              speakerId: lead?.id ?? "hq",
              speakerRole: lead?.role ?? "Lead",
              kind: "summary",
              bodyMarkdown:
                "Once you pick the options above (or click **Commit Minutes**), I'll create the follow-up tasks, save both architectural decisions to certified Team Memory, and unblock the team.",
              decisionId: null,
              spokenText: "Once you pick the options or commit the minutes, I will save the decisions to memory and unblock the team.",
              createdAt: at(2),
            },
          ],
        };
      })(),
      previewTargets: (() => {
        const w1 = workers[0] ?? config.team[0];
        const w2 = workers[1] ?? w1;
        return [
          {
            id: "pt-web-1",
            projectId: config.project.id,
            agentId: w1?.id ?? null,
            label: `${config.project.name} App (:3000)`,
            mode: "sandbox" as const,
            port: 3000,
            previewUrl: "http://localhost:3000/knowledge/upload",
            status: "live" as const,
          },
          {
            id: "pt-docs-2",
            projectId: config.project.id,
            agentId: w2?.id ?? null,
            label: "Docs & API Playground (:4173)",
            mode: "container" as const,
            port: 4173,
            previewUrl: "http://localhost:4173/docs/rate-limits",
            status: "live" as const,
          },
        ];
      })(),
      visualFeedback: [],
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
    if (!t) return;
    const stageId = patch.status && !patch.stageId ? demoStage(this.snap.config, patch.status) : undefined;
    this.putTask({ ...t, ...patch, ...(stageId ? { stageId } : {}) });
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
  message(fromId: string, toId: string, text: string, team = false) {
    const msg = { id: this.id("m"), at: now(), fromId, toId, text, ...(team ? { team } : {}) };
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
