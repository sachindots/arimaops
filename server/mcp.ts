// The HQ Team MCP. Agents connect over Streamable HTTP (stateless) at /mcp,
// identified by the agent token + X-HQ-Agent header that HQ writes into their
// .mcp.json. The lead manages the plan; everyone can message everyone.

import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Hub } from "./hub";
import { requestAccess } from "./access";
import type { Planner } from "./planner";
import { createCrossProjectTask, listProjectsOverview, updateCrossProjectTask } from "./projectsRegistry";
import { AGENT_CLIS, type AgentCli } from "../src/data/types";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (value: unknown): Result => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const fail = (msg: string): Result => ({ content: [{ type: "text", text: msg }], isError: true });

/** Wraps a tool body: thrown errors become tool errors the agent can read. */
function guard<A>(fn: (args: A) => Result) {
  return async (args: A): Promise<Result> => {
    try {
      return fn(args);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  };
}

function buildServer(hub: Hub, planner: Planner, me: string): McpServer {
  const server = new McpServer({ name: "hq", version: "0.1.0" });
  const myCfg = hub.cfg(me);
  const isLead = !!(myCfg?.isLead || myCfg?.department === "exec" || myCfg?.role.toLowerCase().includes("cto"));
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
      },
    },
    guard((args: { title: string; boardId?: string; description?: string; files?: string[]; doneWhen?: string; needs?: string[]; cli?: AgentCli; model?: string }) => {
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
      },
    },
    guard(({ taskId, ...patch }: { taskId: string; title?: string; description?: string; files?: string[]; doneWhen?: string; needs?: string[]; status?: "todo" | "in-progress" | "in-review" | "done" | "blocked"; cli?: AgentCli | null; model?: string | null }) => {
      leadOnly();
      return ok(planner.updateTask(taskId, patch));
    }),
  );

  server.registerTool(
    "assign_task",
    {
      description: "Lead only. Give a task to an agent. HQ tells them to pull main and start it (right away if idle, otherwise when their current turn ends).",
      inputSchema: { taskId: z.string(), agent: z.string().describe("Agent id or name") },
    },
    guard(({ taskId, agent }: { taskId: string; agent: string }) => {
      leadOnly();
      const t = planner.assign(taskId, agent, me);
      return ok(`Assigned ${t.id} to ${hub.name(t.ownerId)}. They have been told to start.`);
    }),
  );

  server.registerTool(
    "get_my_task",
    { description: "Your current task: title, description, the files you may edit, done-when, and what it needs. Marks it in progress." },
    guard(() => {
      const t = planner.currentTask(me);
      if (!t) return ok("You have no task right now. Wait for the lead, or ask with send_message.");
      if (t.status === "todo") planner.setStatus(me, "in-progress");
      const blockedBy = t.needs.filter((n) => planner.task(n)?.status !== "done");
      const isDeliverables = hub.snap.config.workflow.mode === "deliverables";
      const rules = isDeliverables
        ? `Work only on this task. Write your deliverable or changes to the listed files (or deliverables/${t.id}.md). When complete, call set_my_status with in-review (or done) and pass a summary in note and your output file path in deliverablePath.`
        : "Work only on this task, on its own branch. Edit only the listed files. Title the PR `[" + t.id + "] " + t.title + "`. When the PR is open, call set_my_status with in-review and the PR number.";
      return ok({ ...taskView(t.id), waitingOn: blockedBy, rules });
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
      description: "Send a message to another agent (id, name, or \"lead\"). HQ delivers it: right away if they are idle, otherwise when their current turn ends.",
      inputSchema: { to: z.string(), text: z.string() },
    },
    guard(({ to, text }: { to: string; text: string }) => {
      const toId = planner.agentId(to);
      if (toId === me) throw new Error("That's you.");
      planner.message(me, to, text);
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
          type: p.type,
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
      inputSchema: { projectId: z.string().describe("Project id or name from list_projects (e.g. 'booktabs', 'jsm-hq')") },
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
      description: "CTO / Lead only. Creates a task on any registered .hq project's board (live if loaded in HQ, or saved directly to that project's .hq/plan.json).",
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
      return ok(updateCrossProjectTask(projectId, taskId, patch));
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
