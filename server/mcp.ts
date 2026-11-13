// The HQ Team MCP. Agents connect over Streamable HTTP (stateless) at /mcp,
// identified by the agent token + X-HQ-Agent header that HQ writes into their
// .mcp.json. The lead manages the plan; everyone can message everyone.

import type { IncomingMessage, ServerResponse } from "node:http";
import { spendPaused } from "./spendCaps";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Hub } from "./hub";
import { requestAccess } from "./access";
import type { Planner } from "./planner";
import { createCrossProjectTask, listProjectsOverview, updateCrossProjectTask } from "./projectsRegistry";
import { AGENT_CLIS, type AgentCli } from "../src/data/types";
import { ASSET_KINDS, CORE_MEMORY_TYPES, EVIDENCE_KINDS, type LedgerEntry, type Memory } from "../src/data/model";
import { LEAD_KINDS } from "./memory";
import { isReadOnly } from "./legacy";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (value: unknown): Result => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });
const fail = (msg: string): Result => ({ content: [{ type: "text", text: msg }], isError: true });

/** Wraps a tool body: thrown errors become tool errors the agent can read. */
function guard<A>(fn: (args: A) => Result | Promise<Result>) {
  return async (args: A): Promise<Result> => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  };
}

export function buildServer(hub: Hub, planner: Planner, me: string): McpServer {
  const server = new McpServer({ name: "hq", version: "0.1.0" });
  const myCfg = hub.cfg(me);
  const isLead = !!myCfg?.isLead;
  const leadOnly = () => {
    if (!isLead) throw new Error("Only the Lead or CTO can do this. Ask the lead with send_message.");
  };
  const taskView = (id: string) => {
    const t = planner.task(id);
    return t && { ...t, owner: t.ownerId ? hub.name(t.ownerId) : null };
  };

  server.registerTool(
    "list_workers",
    { description: "The team: each agent's id, name, role, whether they are running, and what they are doing now." },
    guard(() =>
      ok(
        hub.snap.config.team.map((a) => {
          const st = hub.status(a.id);
          return {
            id: a.id, name: a.name, role: a.role, lead: a.isLead, you: a.id === me, cli: a.cli, model: a.model || "default",
            limitedUntil: st?.limitedUntil && Date.parse(st.limitedUntil) > Date.now() ? st.limitedUntil : null,
            running: st?.session.state === "running", state: st?.state, task: st?.currentTaskId ?? null,
            free: st?.session.state === "running" && !a.isLead && !planner.currentTask(a.id),
          };
        }),
      ),
    ),
  );

  server.registerTool(
    "get_status",
    { description: "Live status of every agent (state, note, current task) plus the active boards with task counts." },
    guard(() =>
      ok({
        agents: hub.snap.agents.map((s) => ({ id: s.agentId, name: hub.name(s.agentId), state: s.state, note: s.note, task: s.currentTaskId, session: s.session.state })),
        boards: hub.snap.boards.map((b) => {
          const ts = hub.snap.tasks.filter((t) => t.boardId === b.id);
          const n = (st: string) => ts.filter((t) => t.status === st).length;
          return { id: b.id, title: b.title, status: b.status, todo: n("todo"), inProgress: n("in-progress"), inReview: n("in-review"), blocked: n("blocked"), done: n("done") };
        }),
      }),
    ),
  );

  server.registerTool(
    "list_tasks",
    {
      description: "Tasks, optionally filtered by board, status or owner.",
      inputSchema: {
        boardId: z.string().optional().describe("Board id, e.g. P3"),
        status: z.enum(["todo", "in-progress", "in-review", "done", "blocked"]).optional(),
        owner: z.string().optional().describe("Agent id or name"),
      },
    },
    guard(({ boardId, status, owner }: { boardId?: string; status?: string; owner?: string }) => {
      const ownerId = owner ? planner.agentId(owner) : undefined;
      const list = hub.snap.tasks.filter((t) => (!boardId || t.boardId === boardId) && (!status || t.status === status) && (!owner || t.ownerId === ownerId));
      return ok(list.map((t) => ({ id: t.id, board: t.boardId, title: t.title, status: t.status, owner: t.ownerId ? hub.name(t.ownerId) : null, needs: t.needs })));
    }),
  );

  server.registerTool(
    "create_board",
    { description: "Lead only. Create a board (a phase or an area of work).", inputSchema: { title: z.string(), active: z.boolean().optional().describe("Agents only pick tasks from active boards") } },
    guard(({ title, active }: { title: string; active?: boolean }) => {
      leadOnly();
      return ok(planner.createBoard(title, active ? "active" : "planned"));
    }),
  );

  server.registerTool(
    "create_task",
    {
      description: "Lead only. Add a task. Keep tasks small: one task = one branch = one PR.",
      inputSchema: {
        title: z.string(),
        boardId: z.string().optional().describe("Defaults to the first active board"),
        description: z.string().optional().describe("What to build and why"),
        files: z.array(z.string()).optional().describe("The only files/folders this task may edit"),
        doneWhen: z.string().optional().describe("Acceptance criteria"),
        needs: z.array(z.string()).optional().describe("Task ids that must be done first"),
        cli: z.enum(AGENT_CLIS).optional().describe("Runs on: only an agent with this CLI may take it (pick per task by strength and by who is under their usage limit)"),
        model: z.string().optional().describe("Preferred model for the task, e.g. opus or gpt-6.1-sol"),
        specItems: z.array(z.string()).optional().describe("The board spec's items this task covers, e.g. [\"S1\", \"S4\"]. The analyze gate needs every item covered."),
        highStakes: z.boolean().optional().describe("A wrong change here is costly (auth, money, data loss): requires a second opinion from another provider. Sensitive files make a task high-stakes anyway."),
        stageId: z.string().optional().describe("Start it in this flow stage (its phase, e.g. recon or exploit), if the gates before it are met. Default: the first stage."),
      },
    },
    guard((args: { title: string; boardId?: string; description?: string; files?: string[]; doneWhen?: string; needs?: string[]; cli?: AgentCli; model?: string; specItems?: string[]; highStakes?: boolean; stageId?: string }) => {
      leadOnly();
      return ok(planner.createTask(args, me));
    }),
  );

  server.registerTool(
    "update_task",
    {
      description: "Lead only. Edit a task's details or status.",
      inputSchema: {
        taskId: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        files: z.array(z.string()).optional(),
        doneWhen: z.string().optional(),
        needs: z.array(z.string()).optional(),
        status: z.enum(["todo", "in-progress", "in-review", "done", "blocked"]).optional(),
        cli: z.enum(AGENT_CLIS).nullable().optional().describe("Runs on (null clears it)"),
        model: z.string().nullable().optional(),
        note: z.string().max(300).optional().describe("Verification results against acceptance criteria"),
        deliverablePath: z.string().max(300).optional(),
        stageId: z.string().optional().describe("Move the task to this flow stage. Moving forward needs the gates of the stages it leaves."),
        specItems: z.array(z.string()).optional().describe("The spec items it covers (replaces the list)"),
        highStakes: z.boolean().optional(),
      },
    },
    guard(({ taskId, ...patch }: { taskId: string; title?: string; description?: string; files?: string[]; doneWhen?: string; needs?: string[]; status?: "todo" | "in-progress" | "in-review" | "done" | "blocked"; cli?: AgentCli | null; model?: string | null; note?: string; deliverablePath?: string; stageId?: string; specItems?: string[]; highStakes?: boolean }) => {
      leadOnly();
      return ok(planner.updateTask(taskId, patch, me));
    }),
  );

  server.registerTool(
    "write_spec",
    {
      description:
        "Lead only. Write or rewrite a board's spec in markdown. Number each requirement on its own line: `S1. …`, `S2. …`. Then give every item a task (create_task specItems): the analyze gate checks that. A new version resets the owner's spec approval for the board's open tasks.",
      inputSchema: { boardId: z.string().optional().describe("Defaults to the first active board"), text: z.string().max(20_000) },
    },
    guard(({ boardId, text }: { boardId?: string; text: string }) => {
      leadOnly();
      const spec = planner.writeSpec(boardId, text, me);
      const uncovered = spec.items.filter((i) => !hub.snap.tasks.some((t) => t.boardId === spec.boardId && t.specItems?.includes(i)));
      return ok(`Spec v${spec.version} for ${spec.boardId}: ${spec.items.length} items (${spec.items.join(", ") || "none: number them S1., S2."}).${uncovered.length ? ` Not covered by a task yet: ${uncovered.join(", ")}.` : " Every item has a task."}`);
    }),
  );

  server.registerTool(
    "assign_task",
    {
      description: "Lead only. Give a task to an agent, or to a role and HQ picks the seat (free first, skipping seats at their usage limit). The task's stage decides which roles may take it. HQ tells the agent to pull main and start it (right away if idle, otherwise when their current turn ends).",
      inputSchema: { taskId: z.string(), agent: z.string().describe("Agent id or name, or a role id (developer, reviewer...)") },
    },
    guard(({ taskId, agent }: { taskId: string; agent: string }) => {
      leadOnly();
      const t = planner.assign(taskId, agent, me);
      const waiting = planner.waitingOn(t);
      const paused = spendPaused(hub.slug);
      if (waiting.length) return ok(`Assigned ${t.id} to ${hub.name(t.ownerId)}. It waits on ${waiting.join(", ")}; HQ tells them to start once that's done.`);
      return ok(paused ? `Assigned ${t.id} to ${hub.name(t.ownerId)}. The project is paused at its ${paused === "day" ? "daily" : "monthly"} spend cap, so they start when it lifts.` : `Assigned ${t.id} to ${hub.name(t.ownerId)}. They have been told to start.`);
    }),
  );

  server.registerTool(
    "get_my_task",
    { description: "Your current task: title, description, the files you may edit, done-when, and what it needs. Marks it in progress." },
    guard(async () => {
      const t = planner.currentTask(me);
      if (!t) return ok("You have no task right now. Wait for the lead, or ask with send_message.");
      const blockedBy = planner.waitingOn(t);
      if (t.status === "todo" && !blockedBy.length) planner.setStatus(me, "in-progress");
      const isDeliverables = hub.snap.config.workflow.mode === "deliverables";
      const rules = isDeliverables
        ? `Work only on this task. Write your output to the listed files (or deliverables/${t.id}.md). Submit in-review with verification results in note and your output path in deliverablePath. When review is enabled, a different reviewer must accept it.`
        : "Work only on this task, on its own branch. Edit only the listed files. Title the PR `[" + t.id + "] " + t.title + "`. When the PR is open, call set_my_status with in-review and the PR number.";
      const start = "Start from `brief`: the task, the gates before it's done, the handoff notes it builds on, the lead's ledger, what the team remembers (don't repeat its dead ends) and repo facts (build/test commands, layout). Don't re-explore what it already tells you. Your set_my_status note becomes the next agent's handoff, so make it concrete. ";
      const stage = hub.snap.config.template?.flow.stages.find((s) => s.id === t.stageId);
      return ok({ ...taskView(t.id), stage: stage?.name ?? null, waitingOn: blockedBy, brief: (await planner.brief(me, t)).text, rules: start + rules });
    }),
  );

  server.registerTool(
    "record_gate",
    {
      description:
        "Record evidence for a flow gate of a task: a review you did, or a second opinion (it counts only from a provider other than the task owner's). HQ checks tests and CI, the analyze check and the findings report itself. You can't pass gates of your own task's review, and only the owner approves or waives (the lead may approve a spec for the owner after 2 h without a word from them). get_my_task lists the gates a task still needs.",
      inputSchema: {
        taskId: z.string(),
        gateId: z.string(),
        state: z.enum(["passed", "failed", "reset"]),
        note: z.string().max(300).optional().describe("What you checked and what you found"),
        url: z.string().max(300).optional().describe("Link to the proof: a PR, a CI run, a report"),
      },
    },
    guard(({ taskId, gateId, state, note, url }: { taskId: string; gateId: string; state: "passed" | "failed" | "reset"; note?: string; url?: string }) => {
      planner.recordGate(taskId, gateId, state, me, { note, url });
      return ok(`Recorded: ${gateId} of ${taskId} ${state}.`);
    }),
  );

  server.registerTool(
    "attach_evidence",
    {
      description:
        "Verifier: attach screenshots (or a short recording) of the running app for a task's PR, at the commit you checked out. HQ copies the files from your workspace (PNG, JPEG, WebP, WebM or MP4, at most 12, 15 MB each), keeps them on the HQ machine (never in the repo), shows them on the task and comments on the PR. The evidence gate passes when this commit is still the PR's head; a new push needs new evidence.",
      inputSchema: {
        taskId: z.string(),
        sha: z.string().describe("The full commit you checked out and ran (git rev-parse HEAD)"),
        steps: z.array(z.string().max(300)).max(20).describe("What you did and saw, one step per line: the page opened, what you clicked, what looked wrong"),
        files: z.array(z.object({ path: z.string().max(300).describe("Path in your workspace"), label: z.string().max(80).describe("What it shows: 'Settings, tablet'") })).min(1).max(12),
      },
    },
    guard(({ taskId, sha, steps, files }: { taskId: string; sha: string; steps: string[]; files: { path: string; label: string }[] }) => {
      const ev = planner.attachEvidence(me, { taskId, sha: sha.trim().toLowerCase(), steps, files });
      return ok(`Attached ${ev.shots.length} file${ev.shots.length === 1 ? "" : "s"} to ${taskId} at ${ev.sha.slice(0, 7)}. The reviewer and the owner see them on the task; the PR gets a comment.`);
    }),
  );

  server.registerTool(
    "set_my_status",
    {
      description: "Update your current task: in-progress, blocked (say why), in-review (PR opened or deliverable ready), or done. The lead is told automatically.",
      inputSchema: {
        status: z.enum(["in-progress", "blocked", "in-review", "done"]),
        note: z.string().optional().describe("Why you are blocked, or a short summary of your deliverable/changes"),
        prNumber: z.number().int().optional(),
        deliverablePath: z.string().optional().describe("Path to the deliverable file/artifact produced (in deliverables mode)"),
      },
    },
    guard(({ status, note, prNumber, deliverablePath }: { status: "in-progress" | "blocked" | "in-review" | "done"; note?: string; prNumber?: number; deliverablePath?: string }) => {
      const t = planner.setStatus(me, status, note, prNumber, deliverablePath);
      return ok(`${t.id} is now ${t.status}.`);
    }),
  );

  server.registerTool(
    "ask_user",
    {
      description:
        "Ask the user to do something you can't do from your sandbox: create an account, database or API key, change a setting in a dashboard (Vercel, Supabase…), or put a value in your env file. It goes to their Action items list. Give a short title and clear steps. Never include secret values; name the variable instead. HQ messages you when they've done it. For a variable you need, write: add NAME to <your name>'s App variables in HQ (Settings → Sandbox → App variables), then restart <your name>. For a site you need, use request_access instead.",
      inputSchema: {
        title: z.string().describe("What to do, in a few words"),
        details: z.string().describe("The exact steps: where to go, what to create, which variable name, where to put it, and whether you need a restart. No secret values."),
        waiting: z.boolean().optional().describe("True if you can't continue without it"),
      },
    },
    guard(({ title, details, waiting }: { title: string; details: string; waiting?: boolean }) => {
      if (!planner.actions) throw new Error("Action items aren't available.");
      if (!details.trim()) throw new Error("Add the steps in details, so the user knows exactly what to do.");
      const item = planner.actions.add(me, title, details, !!waiting);
      return ok(`Added to the user's Action items (${item.id}). ${waiting ? "Wait for HQ's message, or work on something else meanwhile." : "Keep working; HQ will message you when it's done."}`);
    }),
  );

  // ---------------------------------------------------------------- Ops: plan approval
  server.registerTool(
    "submit_plan",
    {
      description:
        "Ops / infra projects: before changing any system, submit your plan (what you'll run, on which hosts, how to roll back). It goes to the user as Approve / Reject. Don't execute anything until HQ tells you it was approved.",
      inputSchema: {
        title: z.string().describe("The change, in a few words"),
        plan: z.string().describe("Exact steps and commands, the hosts they touch, expected impact, and the rollback"),
      },
    },
    guard(({ title, plan }: { title: string; plan: string }) => {
      if (!planner.actions) throw new Error("Action items aren't available.");
      if (!plan.trim()) throw new Error("Write the plan: steps, commands, hosts and rollback.");
      const item = planner.actions.add(me, title, plan, true, "plan");
      return ok(`Plan sent to the user for approval (${item.id}). Wait for HQ's message before executing anything; prepare (read-only) meanwhile.`);
    }),
  );

  // ---------------------------------------------------------------- Security: findings
  server.registerTool(
    "report_finding",
    {
      description:
        "Security work: record a vulnerability. Network assets (url, host, ip) must be in scope; HQ refuses the rest. Give a CVSS 4.0 vector when you can: HQ computes the score and severity from it. Include reproducible evidence but never real secrets or personal data; redact them. Check list_findings first to avoid duplicates.",
      inputSchema: {
        title: z.string(),
        asset: z.object({ kind: z.enum(ASSET_KINDS), value: z.string().describe("The URL, host, IP, repo, cloud resource or app") }),
        location: z.object({ file: z.string(), startLine: z.number().int().optional(), endLine: z.number().int().optional() }).optional().describe("Code findings: the file and lines"),
        cvss: z.string().optional().describe("CVSS 4.0 base vector, e.g. CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N"),
        severity: z.enum(["critical", "high", "medium", "low", "info"]).optional().describe("Only when there is no CVSS vector"),
        ssvc: z
          .object({ exploitation: z.enum(["none", "poc", "active"]), automatable: z.boolean(), technicalImpact: z.enum(["partial", "total"]), decision: z.enum(["track", "track*", "attend", "act"]) })
          .optional(),
        cwe: z.array(z.string()).optional().describe("e.g. CWE-89"),
        attack: z.array(z.string()).optional().describe("MITRE ATT&CK technique ids, e.g. T1190"),
        d3fend: z.array(z.string()).optional().describe("MITRE D3FEND ids, e.g. D3-IAA"),
        wstg: z.string().optional().describe("OWASP WSTG test id, e.g. WSTG-INPV-05"),
        description: z.string().describe("What's wrong"),
        impact: z.string().describe("What an attacker gains"),
        evidence: z.array(z.object({ kind: z.enum(EVIDENCE_KINDS), content: z.string() })).describe("Requests, responses, commands and output that reproduce it (redacted)"),
        remediation: z.string().describe("How to fix it at the root"),
      },
    },
    guard((args: Record<string, unknown>) => {
      if (!planner.findings) throw new Error("Findings aren't available.");
      const f = planner.findings.report(me, planner.currentTask(me)?.id ?? null, args);
      return ok(`Recorded ${f.id} (${f.severity}${f.cvss ? `, CVSS ${f.cvss.score}` : ""}). It's in deliverables/security-report.md.`);
    }),
  );

  server.registerTool(
    "list_findings",
    { description: "Security work: the findings so far (id, severity, status, asset, title), so you don't report duplicates. Also returns the scope and rules of engagement." },
    guard(() =>
      ok({
        scope: hub.snap.config.project.scope ?? null,
        findings: (hub.snap.findings ?? []).map((f) => ({ id: f.id, severity: f.severity, cvss: f.cvss?.score ?? null, status: f.status, verified: f.verified, asset: f.asset.value, title: f.title })),
      }),
    ),
  );

  server.registerTool(
    "update_finding",
    {
      description: "Triage a finding (lead): status, verified (you reproduced it), CVSS 4.0 vector (rescores it), severity (unscored findings only), SSVC, impact or remediation. Other agents may only set verified, on a finding someone else reported, after reproducing it.",
      inputSchema: {
        id: z.string(),
        status: z.enum(["open", "confirmed", "fixed", "accepted", "false-positive"]).optional(),
        verified: z.boolean().optional(),
        cvss: z.string().optional(),
        severity: z.enum(["critical", "high", "medium", "low", "info"]).optional(),
        ssvc: z
          .object({ exploitation: z.enum(["none", "poc", "active"]), automatable: z.boolean(), technicalImpact: z.enum(["partial", "total"]), decision: z.enum(["track", "track*", "attend", "act"]) })
          .optional(),
        impact: z.string().optional(),
        remediation: z.string().optional(),
      },
    },
    guard(({ id, ...patch }: { id: string } & Record<string, unknown>) => {
      if (!planner.findings) throw new Error("Findings aren't available.");
      if (!isLead) {
        // A second look from another seat (the report gate wants critical and high findings verified by a person or a
        // model from another maker): any agent may set verified, and only that, on a finding someone else reported.
        const fields = Object.keys(patch).filter((k) => patch[k] !== undefined);
        if (fields.some((k) => k !== "verified") || !fields.length) throw new Error("Only the lead triages findings. You may set verified (and only that) on a finding someone else reported, after reproducing it.");
        if (planner.findings.reporterOf(id) === me) throw new Error("You reported this finding: someone else has to verify it.");
      }
      return ok(planner.findings.update(id, patch, me));
    }),
  );

  // ---------------------------------------------------------------- Lead: task ledger
  const memory = () => {
    if (!planner.memory) throw new Error("Memory isn't available.");
    return planner.memory;
  };
  const projectId = hub.snap.config.project.id;

  server.registerTool(
    "ledger_add",
    {
      description:
        "Lead only. Write to your task ledger: a fact you verified, a guess you haven't, a step of the plan, or a note. Tie it to a task, or leave taskId out for the whole project. The ledger outlives your context; read it back with read_ledger.",
      inputSchema: {
        kind: z.enum(LEAD_KINDS),
        text: z.string().max(2000),
        taskId: z.string().optional(),
      },
    },
    guard(({ kind, text, taskId }: { kind: (typeof LEAD_KINDS)[number]; text: string; taskId?: string }) => {
      leadOnly();
      if (taskId && !planner.task(taskId)) throw new Error(`No task ${taskId}.`);
      const e = memory().addLedger({ projectId, taskId: taskId ?? null, ledger: "task", kind, text, by: me });
      return ok(`Ledger entry ${e.id} (${e.kind}) added.`);
    }),
  );

  server.registerTool(
    "ledger_revise",
    {
      description: "Lead only. Replace a task-ledger entry's text (a guess you confirmed or disproved, a changed plan). The old entry is kept as history.",
      inputSchema: { id: z.number().int(), text: z.string().max(2000) },
    },
    guard(({ id, text }: { id: number; text: string }) => {
      leadOnly();
      const old = memory().ledger(projectId, { ledger: "task" }).find((e) => e.id === id);
      if (!old) throw new Error(`No current task-ledger entry ${id}.`);
      const e = memory().reviseLedger(projectId, id, text, me);
      return ok(`Entry ${id} revised as ${e.id}.`);
    }),
  );

  server.registerTool(
    "read_ledger",
    {
      description: "Lead only. Your task ledger (facts, guesses, plan, notes) and HQ's progress ledger (stalls it saw), current entries only. Filter by task.",
      inputSchema: { taskId: z.string().optional() },
    },
    guard(({ taskId }: { taskId?: string }) => {
      leadOnly();
      const view = (e: LedgerEntry) => ({ id: e.id, task: e.taskId, kind: e.kind, text: e.text, by: e.by, at: e.at });
      return ok({
        task: memory().ledger(projectId, { ledger: "task", taskId }).map(view),
        progress: memory().ledger(projectId, { ledger: "progress", taskId }).slice(-20).map(view),
      });
    }),
  );

  // ---------------------------------------------------------------- Everyone: the team's memory (docs/memory-core.md section 7)
  const types = [...CORE_MEMORY_TYPES, ...(hub.snap.config.template?.memoryTypes ?? [])];
  const memView = (m: Memory) => ({ id: m.id, type: m.type, text: m.text, about: m.about, task: m.taskId, certified: m.certified });
  const writableMemory = () => {
    if (isReadOnly(hub.snap.config)) throw new Error("This project was made before templates and is read-only.");
    return memory();
  };

  server.registerTool(
    "recall",
    {
      description:
        "Search what the team remembers in this project: decisions, lessons and dead ends from earlier tasks (certified ones first). Use it before trying an approach that may have been tried.",
      inputSchema: { query: z.string().max(500), types: z.array(z.string()).max(10).optional().describe(`Only these types: ${types.join(", ")}`) },
    },
    guard(async ({ query, types: only }: { query: string; types?: string[] }) => {
      const found = await memory().recall(projectId, query, { types: only, limit: 10 });
      return ok(found.length ? found.map(memView) : "Nothing remembered matches that.");
    }),
  );

  server.registerTool(
    "related",
    {
      description: "What the team remembers about one thing: a task (what it decided, learned or hit), a file or component, or another memory (by id). depth 2 also follows one more link.",
      inputSchema: {
        taskId: z.string().max(40).optional(),
        path: z.string().max(300).optional().describe("A file path or component name"),
        memoryId: z.string().max(40).optional(),
        depth: z.union([z.literal(1), z.literal(2)]).optional(),
      },
    },
    guard(async ({ taskId, path, memoryId, depth }: { taskId?: string; path?: string; memoryId?: string; depth?: 1 | 2 }) => {
      if (!taskId && !path && !memoryId) throw new Error("Give a taskId, a path or a memoryId.");
      const found = await memory().related(projectId, { taskId, path, memoryId }, { depth: depth ?? 1, limit: 10 });
      return ok(found.length ? found.map(memView) : "Nothing remembered is linked to that.");
    }),
  );

  server.registerTool(
    "remember",
    {
      description: `Save something the team should know in later tasks: a Decision (and why), a Lesson, or a DeadEnd (what failed, and why)${
        types.length > CORE_MEMORY_TYPES.length ? `, or this team's own types (${types.slice(CORE_MEMORY_TYPES.length).join(", ")})` : ""
      }. One or two sentences that make sense alone. No names of people, emails, phones, passwords or keys: they are removed. The user certifies it later.`,
      inputSchema: {
        type: z.string().describe(types.join(", ")),
        text: z.string().max(600),
        about: z.array(z.string().max(300)).max(10).optional().describe("File paths or component names it concerns"),
        taskId: z.string().max(40).optional().describe("Defaults to your current task"),
      },
    },
    guard(({ type, text, about, taskId }: { type: string; text: string; about?: string[]; taskId?: string }) => {
      const task = taskId ?? planner.currentTask(me)?.id ?? null;
      if (task && !planner.task(task)) throw new Error(`No task ${task}.`);
      const m = writableMemory().remember({ projectId, type, text, about, taskId: task, by: me });
      return ok(`Remembered as ${m.id} (uncertified until the user checks it): ${m.text}`);
    }),
  );

  server.registerTool(
    "keep_out_of_memory",
    {
      description:
        "Name a person or handle you came across (OSINT, sales, logs) so the team's memory never keeps it. It is also removed from what is already stored. Findings and reports keep their evidence; only memory forgets the name.",
      inputSchema: { name: z.string().min(2).max(120) },
    },
    guard(({ name }: { name: string }) => {
      writableMemory().keepOut(projectId, name, me);
      return ok(`"${name}" will be kept out of memory.`);
    }),
  );

  server.registerTool(
    "request_access",
    {
      description:
        "Your sandbox blocks most websites and APIs. When a request you need is blocked (docs or an API), ask the user to allow that domain. Pass the host (e.g. docs.example.com) and why you need it. The user answers in HQ; you'll get a message.",
      inputSchema: { domain: z.string(), reason: z.string() },
    },
    guard(({ domain, reason }: { domain: string; reason: string }) => ok(requestAccess(hub, me, domain, reason))),
  );

  server.registerTool(
    "send_message",
    {
      description: "Send a message to another agent (id, name, or \"lead\"), or to \"you\" (the human; use it to answer their direct messages). HQ delivers it: right away if they are idle, otherwise when their current turn ends.",
      inputSchema: { to: z.string(), text: z.string() },
    },
    guard(({ to, text }: { to: string; text: string }) => {
      const toId = planner.message(me, to, text);
      return ok(`Sent to ${hub.name(toId)}.`);
    }),
  );

  // ---------------------------------------------------------------- Multi-Project CTO Overwatch Tools
  server.registerTool(
    "list_projects",
    {
      description: "Multi-Project CTO Overwatch: Lists all registered .hq projects on this machine with their path, online status, operator roster, and task counts.",
    },
    guard(() =>
      ok(
        listProjectsOverview().map((p) => ({
          id: p.id,
          name: p.name,
          path: p.path,
          online: p.online,
          isCurrent: p.id === hub.snap.config.project.id,
          template: p.templateName,
          readOnly: p.readOnly,
          workflowMode: p.workflowMode,
          counts: p.counts,
          team: p.team.map((a) => `${a.name} (${a.role}, ${a.cli}${a.model ? `:${a.model}` : ""})`),
        })),
      ),
    ),
  );

  server.registerTool(
    "get_project_status",
    {
      description: "Multi-Project CTO Overwatch: Returns the full boards, tasks, and operator roster for any registered .hq project by projectId or name.",
      inputSchema: { projectId: z.string().describe("Project id or name from list_projects (e.g. 'booktabs', 'exposecheck')") },
    },
    guard(({ projectId }: { projectId: string }) => {
      const q = projectId.trim().toLowerCase();
      const found = listProjectsOverview().find(
        (p) => p.id.toLowerCase() === q || p.name.toLowerCase() === q || p.path.toLowerCase() === q,
      );
      if (!found) throw new Error(`Project "${projectId}" not found.`);
      return ok(found);
    }),
  );

  server.registerTool(
    "create_project_task",
    {
      description: "CTO / Lead only. Creates a task on any registered .hq project's board (live if loaded in HQ, or saved directly to that project's .arima/plan.json).",
      inputSchema: {
        projectId: z.string().describe("Project id or name from list_projects"),
        title: z.string(),
        boardId: z.string().optional(),
        description: z.string().optional(),
        files: z.array(z.string()).optional(),
        doneWhen: z.string().optional(),
        ownerId: z.string().optional().describe("Optional agent id or name on that project"),
      },
    },
    guard((args: { projectId: string; title: string; boardId?: string; description?: string; files?: string[]; doneWhen?: string; ownerId?: string }) => {
      leadOnly();
      const { projectId, ...rest } = args;
      return ok(createCrossProjectTask(projectId, rest));
    }),
  );

  server.registerTool(
    "update_project_task",
    {
      description: "CTO / Lead only. Updates a task's status, owner, title, description, or note on any registered .hq project.",
      inputSchema: {
        projectId: z.string().describe("Project id or name from list_projects"),
        taskId: z.string().describe("Task id, e.g. B1-T01"),
        title: z.string().optional(),
        description: z.string().optional(),
        doneWhen: z.string().optional(),
        status: z.enum(["todo", "in-progress", "in-review", "done", "blocked"]).optional(),
        ownerId: z.string().optional().describe("Agent id or name on that project (or empty to unassign)"),
        note: z.string().optional(),
      },
    },
    guard(({ projectId, taskId, ...patch }: { projectId: string; taskId: string; title?: string; description?: string; doneWhen?: string; status?: "todo" | "in-progress" | "in-review" | "done" | "blocked"; ownerId?: string; note?: string }) => {
      leadOnly();
      return ok(updateCrossProjectTask(projectId, taskId, patch, me));
    }),
  );

  return server;
}

/** Handles one MCP HTTP request for an already-authenticated agent. */
export async function handleMcp(hub: Hub, planner: Planner, agentId: string, req: IncomingMessage, res: ServerResponse, body: unknown) {
  const server = buildServer(hub, planner, agentId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
