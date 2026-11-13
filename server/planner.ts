// Boards, tasks, assignments and messages. Used by both the Team MCP tools
// (agents) and the browser commands (you), so both follow the same rules.

import { CLI_LABEL, HUMAN_ID, isAgentCli, type AgentCli, type AgentMessage, type Board, type Task, type TaskStatus } from "../src/data/types";
import type { Hub } from "./hub";
import type { ActionItems } from "./actionItems";
import type { Findings } from "./findings";
import { HISTORY, type Inbox } from "./inbox";
import { CLEAR_COMMAND } from "./adapters";
import { readFacts } from "./facts";
import { taskUsage } from "./usageEvents";
import { syncDeliverablesFromAgent, syncRepoToWorkspace } from "./workspace";
import { assertTaskMove, gateContext, gateEvents, loadSpec, recordGate, saveSpec, type Spec } from "./planStore";
import { ownerAway } from "./presence";
import { PERSON_GATES, stagesLeft, unmetGates, type UnmetGate } from "./gates";
import { hqDb } from "./lib/db";
import type { MemoryStore } from "./memory";
import { buildBrief, type Brief } from "./brief";
import type { GateState, Memory } from "../src/data/model";
import { log } from "./lib/log";

export interface NewTask {
  boardId?: string;
  title: string;
  description?: string;
  files?: string[];
  doneWhen?: string;
  needs?: string[];
  cli?: AgentCli | null;
  model?: string | null;
  specItems?: string[];
  highStakes?: boolean;
}

export type TaskPatch = Partial<Pick<Task, "title" | "description" | "files" | "doneWhen" | "needs" | "status" | "boardId" | "note" | "prNumber" | "deliverablePath" | "cli" | "model" | "stageId" | "specItems" | "highStakes">>;

/** "s4", " S12 " → "S4", "S12"; anything else is dropped. */
const cleanItems = (items: string[] | undefined) => [...new Set((items ?? []).map((i) => i.trim().toUpperCase()).filter((i) => /^S\d+$/.test(i)))];

const now = () => new Date().toISOString();

export class Planner {
  private seq = 0;
  /** Set by main: the user's action items (Team MCP `ask_user`). */
  actions: ActionItems | null = null;
  /** Set by project.ts: security findings (Team MCP report_finding). */
  findings: Findings | null = null;
  /** Set by main: ledgers and, from Phase 2, the team's memory. */
  memory: MemoryStore | null = null;
  /** Set by main: extraction after a task, consolidation after a board (docs/memory-core.md section 5). */
  memoryJobs: { taskFinished(): void; boardDone(projectId: string): void } | null = null;


  constructor(private hub: Hub, private inbox: Inbox) {}

  /** The tokens recorded against this task while it was its owner's current task. */
  private meterEnd(task: Task) {
    task.usage = taskUsage(hqDb(), this.snap.config.project.id).get(task.id) ?? null;
  }

  private get snap() {
    return this.hub.snap;
  }

  private async syncTaskDeliverables(task: Task) {
    if (this.snap.config.workflow.mode !== "deliverables" || !task.ownerId) return;
    const owner = this.hub.cfg(task.ownerId);
    if (!owner) return;
    const hints = [...(task.files ?? []), ...(task.deliverablePath ? [task.deliverablePath] : [])];
    await syncDeliverablesFromAgent(owner, this.snap.config.team, this.hub.slug, this.hub.repo.root, hints);
  }

  task(id: string): Task | undefined {
    return this.snap.tasks.find((t) => t.id.toLowerCase() === id.trim().toLowerCase());
  }

  /** An agent by id or (case-insensitive) name; "lead" means the lead. */
  agentId(ref: string): string | null {
    const r = ref.trim().toLowerCase();
    const team = this.snap.config.team;
    if (r === "lead") return team.find((a) => a.isLead)?.id ?? null;
    return team.find((a) => a.id === r || a.name.toLowerCase() === r)?.id ?? null;
  }

  /**
   * Picks a seat of role `roleRef` for `task` (docs/agent-engine.md section 2): free and running first, then
   * free and stopped (on demand, it starts), then the busy one with the fewest open tasks. Seats at their usage
   * limit or on another CLI than the task asks for are skipped. Null when `roleRef` isn't a role; throws when
   * the role has no seat that can take the task.
   */
  seatOf(roleRef: string, task: Task): string | null {
    const roleId = roleRef.trim().toLowerCase();
    const role = this.snap.config.template?.roles.find((r) => r.id === roleId);
    if (!role) return null;
    const now = Date.now();
    const seats = this.snap.config.team.filter((a) => a.roleId === roleId);
    const fit = seats.filter((a) => {
      const limited = this.hub.status(a.id)?.limitedUntil;
      return !(limited && Date.parse(limited) > now) && (!task.cli || a.cli === task.cli);
    });
    if (!fit.length)
      throw new Error(seats.length ? `Every ${role.title} seat is at its usage limit${task.cli ? ` or not on ${CLI_LABEL[task.cli]}` : ""}. Pick another role, or wait.` : `No seat has the ${role.title} role. Add one in the team panel.`);
    const open = (id: string) => this.snap.tasks.filter((t) => t.ownerId === id && t.status !== "done" && t.id !== task.id).length;
    const rank = (id: string) => {
      const n = open(id);
      if (n) return 2 + n;
      return this.hub.status(id)?.session.state === "running" ? 0 : 1;
    };
    return fit.map((a) => ({ id: a.id, r: rank(a.id) })).sort((x, y) => x.r - y.r)[0].id;
  }

  defaultBoard(): Board {
    const active = this.snap.boards.filter((b) => b.status === "active").sort((a, b) => a.order - b.order);
    if (active[0]) return active[0];
    return this.createBoard("Backlog", "active");
  }

  // ------------------------------------------------------------ boards

  /** Projects made before templates are read-only: their plan never changes, whoever asks. */
  private writable() {
    if (!this.snap.config.template) throw new Error("This project was made before templates and is read-only.");
    return this.snap.config.template;
  }

  /** Throws with every unmet gate when the task can't move to `toStageId` (null: finish it). */
  private assertMove(task: Task, toStageId: string | null, byId: string) {
    assertTaskMove(this.snap.config, task, toStageId, byId, this.snap.pullRequests ?? [], { tasks: this.snap.tasks, repoRoot: this.hub.repo.root });
  }

  /** What still stands between `byId` finishing this task: the unmet gates of its stage and the ones after it. */
  openGates(task: Task, byId: string): UnmetGate[] {
    const t = this.snap.config.template;
    if (!t) return [];
    return unmetGates(stagesLeft(t.flow, task.stageId, null), gateContext(this.snap.config, task, byId, this.snap.pullRequests ?? [], { tasks: this.snap.tasks, repoRoot: this.hub.repo.root }));
  }

  /** Records gate evidence from an agent (its id) or a person ("you"). */
  recordGate(taskId: string, gateId: string, state: GateState, byId: string, proof: { url?: string; note?: string } = {}) {
    const template = this.writable();
    const task = this.task(taskId);
    if (!task) throw new Error(`No task ${taskId}`);
    const by = byId === "you" ? ({ kind: "user", id: byId } as const) : ({ kind: "agent", id: byId } as const);
    const leadId = this.snap.config.team.find((a) => a.isLead)?.id ?? null;
    const gate = recordGate(hqDb(), template, task, { projectId: this.snap.config.project.id, gateId, state, by, proof }, { leadId, ownerAway: ownerAway() });
    const onBehalf = PERSON_GATES.has(gate.kind) && byId === leadId && state === "passed";
    this.hub.activity(state === "passed" ? "review.passed" : state === "failed" ? "review.changes" : "config", byId === "you" ? null : byId, `${this.hub.name(byId)} marked gate ${gateId} of ${task.id} ${state}${onBehalf ? " for the owner (away)" : ""}${proof.note ? `: ${proof.note.slice(0, 120)}` : ""}`);
    if (onBehalf) {
      const stageId = template.flow.stages.find((s) => s.gates.some((g) => g.id === gate.id))!.id;
      this.onLeadApproval(task, gate.id, stageId, proof.note ?? "");
    }
  }

  /** The lead passed a person gate for the away owner (set by the project: files a Keep / Undo action item). */
  onLeadApproval: (task: Task, gateId: string, stageId: string, note: string) => void = () => {};

  /**
   * The owner undid a lead approval: a reset row (the history stays), the task back in the gate's stage if it had
   * moved past it, and the lead and the task's owner told.
   */
  undoLeadApproval(taskId: string, gateId: string, stageId: string, note?: string) {
    const template = this.writable();
    const task = this.task(taskId);
    if (!task) return;
    recordGate(hqDb(), template, task, { projectId: this.snap.config.project.id, gateId, state: "reset", by: { kind: "user", id: HUMAN_ID }, proof: { note: "Undone by the owner" } });
    const at = (id?: string) => template.flow.stages.findIndex((s) => s.id === id);
    if (at(task.stageId) > at(stageId)) {
      task.stageId = stageId;
      if (task.status === "done" || task.status === "in-review") task.status = "in-progress";
      this.hub.emit({ type: "task.updated", task: { ...task } });
      this.hub.planChanged();
    }
    const n = note ? ` Their note: ${note}` : "";
    const text = `The owner undid your approval of ${gateId} on ${task.id} (${task.title}). It waits for the owner again${at(task.stageId) === at(stageId) ? `, and ${task.id} is back in its ${template.flow.stages[at(stageId)].name} stage` : ""}.${n}`;
    const lead = this.snap.config.team.find((a) => a.isLead);
    if (lead) this.notify(lead.id, text);
    if (task.ownerId && task.ownerId !== lead?.id) this.notify(task.ownerId, `The owner undid the lead's approval of ${gateId} on ${task.id}: wait for the owner before going on.${n}`);
    this.hub.activity("config", null, `You undid the lead's approval of ${gateId} on ${task.id}`);
  }

  /**
   * The lead writes (or rewrites) a board's spec. Items are its lines that start with S1., S2.… A new version
   * resets the spec approvals of the board's tasks: the owner approves what the spec says now.
   */
  writeSpec(boardId: string | undefined, text: string, byId: string): Spec {
    const template = this.writable();
    const board = boardId ? this.snap.boards.find((b) => b.id === boardId) : this.defaultBoard();
    if (!board) throw new Error(`No board ${boardId}. Boards: ${this.snap.boards.map((b) => b.id).join(", ")}`);
    const clean = text.trim().slice(0, 20_000);
    if (!clean) throw new Error("The spec is empty.");
    const projectId = this.snap.config.project.id;
    const spec = saveSpec(hqDb(), projectId, board.id, clean, byId);
    const specGates = template.flow.stages.flatMap((st) => st.gates).filter((g) => g.kind === "spec-approved" || (g.kind === "owner-approval" && g.reason === "spec"));
    if (spec.version > 1)
      for (const t of this.snap.tasks.filter((x) => x.boardId === board.id && x.status !== "done"))
        for (const g of specGates)
          if (gateEvents(hqDb(), projectId, t.id).some((e) => e.gateId === g.id))
            recordGate(hqDb(), template, t, { projectId, gateId: g.id, state: "reset", by: { kind: "hq", id: "hq" }, proof: { note: `Spec v${spec.version} replaces the approved one` } });
    this.hub.activity("config", byId === HUMAN_ID ? null : byId, `${this.hub.name(byId)} wrote the spec for ${board.title} (v${spec.version}, ${spec.items.length} items)`);
    return spec;
  }

  /** The spec text a task's brief shows: the items it covers, else the whole spec (the brief trims it to fit). */
  specFor(task: Task): string {
    const spec = loadSpec(hqDb(), this.snap.config.project.id, task.boardId);
    if (!spec) return "";
    const mine = new Set(task.specItems ?? []);
    if (!mine.size) return spec.text;
    const lines = spec.text.split("\n").filter((l) => {
      const m = l.match(/^\s*(?:[-*]\s*)?(S\d+)[.:)]/);
      return m && mine.has(m[1].toUpperCase());
    });
    return `${lines.join("\n")}\n(Spec v${spec.version}; the whole spec covers ${spec.items.join(", ")}.)`;
  }

  createBoard(title: string, status: Board["status"] = "planned"): Board {
    this.writable();
    const clean = title.trim().slice(0, 80) || "Board";
    const base = clean.split(/\s+/).map((w) => w[0]).join("").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3) || "B";
    let id = base;
    for (let i = 2; this.snap.boards.some((b) => b.id === id); i++) id = `${base}${i}`;
    const board: Board = { id, title: clean, status, order: this.snap.boards.length };
    this.snap.boards.push(board);
    this.hub.emit({ type: "board.updated", board: { ...board } });
    this.hub.planChanged();
    return board;
  }

  updateBoard(id: string, patch: Partial<Pick<Board, "title" | "status">>) {
    this.writable();
    const board = this.snap.boards.find((b) => b.id === id);
    if (!board) throw new Error(`No board ${id}`);
    if (patch.title?.trim()) board.title = patch.title.trim().slice(0, 80);
    const finishing = patch.status === "done" && board.status !== "done";
    if (patch.status) board.status = patch.status;
    if (finishing) this.memoryJobs?.boardDone(this.snap.config.project.id);
    this.hub.emit({ type: "board.updated", board: { ...board } });
    this.hub.planChanged();
    return board;
  }

  // ------------------------------------------------------------ tasks

  createTask(input: NewTask, byId: string): Task {
    const template = this.writable();
    const board = input.boardId ? this.snap.boards.find((b) => b.id === input.boardId) : this.defaultBoard();
    if (!board) throw new Error(`No board ${input.boardId}. Boards: ${this.snap.boards.map((b) => b.id).join(", ")}`);
    let n = this.snap.tasks.filter((t) => t.boardId === board.id).length + 1;
    let id = `${board.id}-T${String(n).padStart(2, "0")}`;
    while (this.task(id)) id = `${board.id}-T${String(++n).padStart(2, "0")}`;
    const task: Task = {
      id, boardId: board.id, stageId: template.flow.stages[0].id, title: input.title.trim().slice(0, 120), ownerId: null, status: "todo",
      needs: input.needs ?? [], prNumber: null, description: input.description ?? "", files: input.files ?? [], doneWhen: input.doneWhen ?? "", note: null, deliverablePath: null,
      cli: input.cli && isAgentCli(input.cli) ? input.cli : null, model: input.model?.trim().slice(0, 80) || null,
      specItems: cleanItems(input.specItems), highStakes: !!input.highStakes,
    };
    this.snap.tasks.push(task);
    this.hub.emit({ type: "task.updated", task: { ...task } });
    this.hub.activity("task.created", byId === "you" ? null : byId, `${this.hub.name(byId)} added ${task.id} ${task.title}`);
    this.hub.planChanged();
    return task;
  }

  updateTask(id: string, patch: TaskPatch, reviewerId = "you"): Task {
    const flow = this.writable().flow;
    const task = this.task(id);
    if (!task) throw new Error(`No task ${id}`);
    const wasDone = task.status === "done";
    const changes = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as TaskPatch;
    if (changes.specItems) changes.specItems = cleanItems(changes.specItems);
    const next = { ...task, ...changes, stageId: task.stageId };
    const at = (id?: string) => flow.stages.findIndex((s) => s.id === id);
    if (changes.stageId !== undefined && at(changes.stageId) < 0) throw new Error(`No stage "${changes.stageId}". Stages: ${flow.stages.map((s) => s.id).join(", ")}.`);
    if (changes.stageId !== undefined && at(changes.stageId) > at(task.stageId)) this.assertMove(next, changes.stageId, reviewerId);
    if (changes.status === "done" && !wasDone) {
      this.assertMove(next, null, reviewerId);
      changes.stageId = flow.stages.at(-1)!.id; // finishing leaves every stage
    }
    Object.assign(task, changes);
    if (task.status === "done" && !wasDone) {
      this.meterEnd(task);
      for (const a of this.snap.agents) if (a.currentTaskId === task.id) this.hub.setStatus(a.agentId, { currentTaskId: null });
      this.afterDone(task);
      this.startUnblocked(task);
    }
    if (task.status === "done" || task.status === "in-review") void this.syncTaskDeliverables(task);
    if (task.status === "in-review" && task.prNumber && (changes.status === "in-review" || changes.prNumber)) this.startUnblocked(task); // tasks that can stack on its PR
    this.hub.emit({ type: "task.updated", task: { ...task } });
    this.hub.planChanged();
    return task;
  }

  /** Gives a task to an agent and tells them to start. */
  assign(taskId: string, agentRef: string, byId: string): Task {
    const template = this.writable();
    const task = this.task(taskId);
    if (!task) throw new Error(`No task ${taskId}`);
    const agentId = this.agentId(agentRef) ?? this.seatOf(agentRef, task);
    if (!agentId) throw new Error(`No agent or role "${agentRef}". Team: ${this.snap.config.team.map((a) => a.id).join(", ")}. Roles: ${template.roles.map((r) => r.id).join(", ")}`);
    const agent = this.hub.cfg(agentId)!;
    const stage = template.flow.stages.find((s) => s.id === task.stageId);
    if (stage && agent.roleId && !stage.roleIds.includes(agent.roleId))
      throw new Error(`${task.id} is in the ${stage.name} stage, which ${stage.roleIds.join(" or ")} work. ${agent.name} is a ${agent.roleId}. Assign a seat of those roles, or move the task to a stage ${agent.name}'s role works first.`);
    if (task.cli && agent.cli !== task.cli) {
      const fits = this.snap.config.team.filter((a) => a.cli === task.cli && !a.isLead).map((a) => a.name);
      throw new Error(`${task.id} runs on ${CLI_LABEL[task.cli]}, but ${agent.name} runs ${CLI_LABEL[agent.cli]}. ${fits.length ? `Agents on ${CLI_LABEL[task.cli]}: ${fits.join(", ")}.` : `No agent runs ${CLI_LABEL[task.cli]}; add one or clear the task's "runs on".`}`);
    }
    const limited = this.hub.status(agentId)?.limitedUntil;
    if (limited && Date.parse(limited) > Date.now())
      throw new Error(`${agent.name} hit its ${CLI_LABEL[agent.cli]} usage limit until ${new Date(limited).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Pick an agent on another CLI.`);
    if (task.model && task.model !== agent.model) {
      if (this.hub.status(agentId)?.session.state !== "running") {
        agent.model = task.model; // takes effect when the agent starts
        this.hub.configChanged();
      } else this.hub.activity("config", agentId, `${task.id} prefers ${task.model}; ${agent.name} is running ${agent.model || "its default model"}. Restart ${agent.name} with that model if it matters.`);
    }
    task.ownerId = agentId;
    if (task.status === "done") task.status = "todo";
    this.hub.emit({ type: "task.updated", task: { ...task } });
    const waiting = this.waitingOn(task);
    if (!waiting.length) this.hub.setStatus(agentId, { currentTaskId: task.id });
    this.hub.planChanged();
    this.hub.activity("task.assigned", byId === "you" ? null : byId, `${this.hub.name(byId)} assigned ${task.id} ${task.title} to ${agent.name}`);
    const by = byId === "you" ? "The user (your human)" : this.hub.name(byId);
    const isDeliverables = this.snap.config.workflow.mode === "deliverables";
    if (isDeliverables) {
      void Promise.all(
        task.needs.map((depId) => {
          const dep = this.task(depId);
          return dep ? this.syncTaskDeliverables(dep) : Promise.resolve();
        }),
      ).then(() => {
        syncRepoToWorkspace(agent, this.hub.slug, this.hub.repo.root, task.files);
      });
    }
    if (waiting.length) {
      const text = `${by} assigned you ${task.id} (${task.title}). It waits on ${waiting.join(", ")}: don't start it yet, HQ will tell you when.`;
      const msg = this.record(byId, agentId, `Queued ${task.id}: ${task.title} (after ${waiting.join(", ")})`);
      this.inbox.push(agentId, { fromId: byId, kind: "assign", text, msgId: msg.id, taskId: task.id });
      return task;
    }
    const text = isDeliverables
      ? `${by} assigned you ${task.id} (${task.title}). Start ${task.id} and call the hq get_my_task tool for the details.`
      : this.stackBase(task)
        ? `${by} assigned you ${task.id} (${task.title}). Start ${task.id}.${this.stackNote(task)} Call the hq get_my_task tool for the details.`
        : `${by} assigned you ${task.id} (${task.title}). Pull main, start ${task.id}. Call the hq get_my_task tool for the details.`;
    const msg = this.record(byId, agentId, `Start ${task.id}: ${task.title}`);
    this.inbox.push(agentId, { fromId: byId, kind: "assign", text, msgId: msg.id, taskId: task.id });
    this.onReady(agentId);
    return task;
  }

  /** An agent has a task it can start now (set by the project: starts an on-demand seat that is stopped). */
  onReady: (agentId: string) => void = () => {};

  setStatus(agentId: string, status: Extract<TaskStatus, "in-progress" | "blocked" | "in-review" | "done">, note?: string, prNumber?: number, deliverablePath?: string): Task {
    const flow = this.writable().flow;
    const task = this.currentTask(agentId);
    if (!task) throw new Error("You have no task. Ask the lead for one.");
    if (status === "done") {
      this.assertMove({ ...task, status, note: note ?? task.note, prNumber: prNumber ?? task.prNumber, deliverablePath: deliverablePath ?? task.deliverablePath }, null, agentId);
      task.stageId = flow.stages.at(-1)!.id;
    }
    if (status === "in-progress" && this.waitingOn(task).length) throw new Error(`Wait for ${this.waitingOn(task).join(", ")} before starting this task.`);
    task.status = status;
    task.note = note?.slice(0, 300) || (status === "done" ? task.note ?? null : null);
    if (prNumber) task.prNumber = prNumber;
    if (deliverablePath) task.deliverablePath = deliverablePath.slice(0, 300);
    if (status === "done") this.meterEnd(task);
    if (status === "done") this.hub.setStatus(agentId, { currentTaskId: null });
    else this.hub.setStatus(agentId, { currentTaskId: task.id });
    if (status === "in-review" || status === "done") void this.syncTaskDeliverables(task);
    this.hub.emit({ type: "task.updated", task: { ...task } });
    this.hub.planChanged();
    if (status === "done") {
      this.afterDone(task);
      this.startUnblocked(task);
    }
    if (status === "in-review" && task.prNumber) this.startUnblocked(task); // tasks that can stack on its PR
    const name = this.hub.name(agentId);
    const words = { "in-progress": "started", blocked: "is blocked on", "in-review": "sent for review", done: "finished" }[status];
    this.hub.activity(status === "blocked" ? "agent.needs-input" : "task.started", agentId, `${name} ${words} ${task.id}${note ? `: ${note}` : ""}`);
    // Let the lead know when work is blocked or ready for review.
    const lead = this.snap.config.team.find((a) => a.isLead);
    if (lead && lead.id !== agentId && (status === "blocked" || status === "in-review" || status === "done"))
      this.message(
        agentId,
        lead.id,
        `${task.id} ${words}${note ? `: ${note}` : ""}${prNumber ? ` (PR #${prNumber})` : ""}${deliverablePath ? ` (Deliverable: ${deliverablePath})` : ""}`,
      );
    return task;
  }

  currentTask(agentId: string): Task | undefined {
    const st = this.hub.status(agentId);
    const byCurrent = st?.currentTaskId ? this.task(st.currentTaskId) : undefined;
    if (byCurrent && byCurrent.ownerId === agentId && byCurrent.status !== "done") return byCurrent;
    const mine = this.snap.tasks.filter((t) => t.ownerId === agentId && t.status !== "done");
    const ready = (t: Task) => !this.waitingOn(t).length;
    return mine.find((t) => t.status === "in-progress") ?? mine.find((t) => t.status === "todo" && ready(t)) ?? mine.find((t) => t.status === "todo") ?? mine[0];
  }

  private lean = () => this.snap.config.workflow.lean?.clearBetweenTasks !== false;

  /** Lean mode, once a task is done: its owner starts the next one in a fresh conversation, and the repo facts learn from it. */
  private afterDone(done: Task) {
    this.summarise(done);
    if (!this.lean()) return;
    const id = done.ownerId;
    const agent = id ? this.hub.cfg(id) : undefined;
    const cmd = agent && CLEAR_COMMAND[agent.cli];
    if (!id || !agent || agent.isLead || !cmd || this.hub.status(id)?.session.state !== "running") return;
    const next = this.currentTask(id);
    // Mid-way through another task, or the next one builds on this one: keep the conversation.
    if (next && next.id !== done.id && (next.status === "in-progress" || next.needs.includes(done.id))) return;
    this.inbox.push(id, { fromId: "hq", kind: "reset", text: cmd });
  }

  /**
   * The brief's memory section: what the tasks it builds on produced, what is known about its files, and what
   * matches its words. Certified first. Neo4j down never blocks a brief: the section says so instead.
   */
  private async memoryFor(task: Task): Promise<string> {
    const memory = this.memory;
    if (!memory) return "";
    const p = this.snap.config.project.id;
    try {
      const lists = await Promise.all([
        ...task.needs.slice(-8).map((id) => memory.related(p, { taskId: id }, { depth: 1, limit: 6 })),
        ...(task.files ?? []).slice(0, 10).map((f) => memory.related(p, { path: f }, { depth: 1, limit: 6 })),
        memory.recall(p, `${task.title} ${task.description ?? ""}`, { limit: 6 }),
      ]);
      const seen = new Map<string, Memory>();
      for (const m of lists.flat()) if (!seen.has(m.id)) seen.set(m.id, m);
      // Certified first; then dead ends (the brief says not to repeat them), decisions, and the rest.
      const rank = (m: Memory) => (m.type === "DeadEnd" ? 0 : m.type === "Decision" ? 1 : 2);
      const picked = [...seen.values()].sort((a, b) => Number(b.certified) - Number(a.certified) || rank(a) - rank(b)).slice(0, 12);
      return picked
        .map((m) => `- ${m.type}${m.certified ? " (certified)" : ""}${m.taskId ? `, from ${m.taskId}` : ""}: ${m.text}${m.about.length ? ` [${m.about.join(", ")}]` : ""} (${m.id})`)
        .join("\n");
    } catch (err) {
      return `Memory is offline right now (${err instanceof Error ? err.message : err}). Ask the lead if you need what the team learned before.`;
    }
  }

  /** What a finished task leaves behind for the team's memory (docs/memory-core.md section 4). */
  private summarise(task: Task) {
    if (!this.memory) return;
    const projectId = this.snap.config.project.id;
    try {
      this.memory.summarise({
        projectId,
        taskId: task.id,
        title: task.title,
        description: task.description?.trim() || null,
        doneWhen: task.doneWhen?.trim() || null,
        stageId: task.stageId ?? null,
        ownerId: task.ownerId,
        needs: task.needs,
        files: task.files ?? [],
        prNumber: task.prNumber,
        deliverablePath: task.deliverablePath ?? null,
        note: task.note ?? null,
        ledger: this.memory.ledger(projectId, { ledger: "task", taskId: task.id }).map((e) => ({ kind: e.kind, text: e.text })),
        usage: task.usage ?? null,
        finishedAt: new Date().toISOString(),
      });
      this.memoryJobs?.taskFinished();
    } catch (err) {
      log.warn(`couldn't keep the summary of ${task.id}: ${err instanceof Error ? err.message : err}`); // never a reason to refuse finishing
    }
  }

  /** What an agent needs to start a task without re-exploring: the handoffs it builds on, its own last note, the repo facts. */
  async brief(agentId: string, task: Task): Promise<Brief> {
    // Least relevant first: the brief drops from the front when it is over budget.
    const mine = this.snap.tasks.filter((t) => t.ownerId === agentId && t.status === "done" && t.note && t.id !== task.id).at(-1);
    const deps = task.needs.map((n) => this.task(n)).filter((d): d is Task => !!d?.note).slice(-8);
    const handoffs = [...(mine ? [{ ...mine, ownerId: "you" }] : []), ...deps].map((d) => ({
      taskId: d.id,
      by: d.ownerId === "you" ? "your last task" : d.ownerId ? this.hub.name(d.ownerId) : null,
      note: d.note!.slice(0, 600),
    }));
    const ledger = (this.memory?.ledger(this.snap.config.project.id, { ledger: "task" }) ?? []).filter((e) => e.taskId === task.id || e.taskId === null);
    return buildBrief({
      task,
      spec: this.specFor(task),
      handoffs,
      ledger,
      memory: await this.memoryFor(task),
      facts: readFacts(this.hub.repo.root),
      skills: this.hub.cfg(agentId)?.skills ?? [],
      gates: this.openGates(task, agentId).map((g) => ({ id: g.gate.id, kind: g.gate.kind, needs: g.why })),
    });
  }

  private stallNudged = new Set<string>(); // agent:task, so each stall is reported once
  /** When the agent's last hook arrived (set by the project from the inbox). */
  lastActivityAt: (agentId: string) => number = () => 0;

  /**
   * A worker that ended its turn with its task still in progress, and has sat idle since, is waiting on something
   * that won't wake it (a background job, a question it never sent). Nudge it once and tell the lead.
   */
  checkStalls(now: number, idleMs = 5 * 60_000, silentMs = 15 * 60_000, unansweredMs = 30 * 60_000) {
    const lead = this.snap.config.team.find((a) => a.isLead);
    // The user is away: hand questions they haven't answered to the lead (plans still wait for the user).
    for (const item of this.snap.actionItems ?? []) {
      if (!lead || item.status !== "open" || item.kind === "plan" || now - Date.parse(item.at) < unansweredMs) continue;
      const key = `ask:${item.id}`;
      if (this.stallNudged.has(key)) continue;
      this.stallNudged.add(key);
      const who = item.fromId === lead.id ? "You" : this.hub.name(item.fromId);
      this.notify(lead.id, `The user hasn't answered "${item.title}" (from ${who}) for ${Math.round((now - Date.parse(item.at)) / 60_000)} min. If it's a reversible decision, make it, tell ${item.fromId === lead.id ? "the team" : who}, and tell the user what you decided. If only the user can do it, keep the team on other work.`);
    }
    for (const a of this.snap.config.team) {
      const st = this.hub.status(a.id);
      const task = this.currentTask(a.id);
      if (a.isLead || !st || !task || task.status !== "in-progress" || st.session.state !== "running") continue;
      if (st.limitedUntil && Date.parse(st.limitedUntil) > now) continue; // the usage-limit notice covers this
      const key = `${a.id}:${task.id}`;
      // "Working" but no hook for a long time: frozen, or one command hanging. Typing into it would interrupt, so tell the lead.
      const quietMs = now - Math.max(this.lastActivityAt(a.id), Date.parse(st.stateSince));
      if (this.stallNudged.has(key)) {
        if (st.state === "working" && quietMs < silentMs) this.stallNudged.delete(key); // moving again: a later stall counts anew
        continue;
      }
      if (st.state === "working" && quietMs >= silentMs) {
        this.stallNudged.add(key);
        const mins = Math.round(quietMs / 60_000);
        if (lead) this.notify(lead.id, `${a.name} shows Working on ${task.id} but has done nothing visible for ${mins} min (a command may be hanging). Check its terminal in HQ, or ask the user to.`);
        this.progress(task.id, `${a.name} silent ${mins} min while working`);
        this.hub.activity("agent.needs-input", a.id, `${a.name} silent for ${mins} min while working on ${task.id}`);
        continue;
      }
      if (st.state !== "idle" || now - Date.parse(st.stateSince) < idleMs || this.inbox.pending(a.id) > 0) continue;
      this.stallNudged.add(key);
      const mins = Math.round((now - Date.parse(st.stateSince)) / 60_000);
      this.notify(a.id, `HQ: you've been idle ${mins} min but ${task.id} is still in progress. If you were waiting on a background command or job, it won't wake you: check it now and continue in the foreground. If you're blocked, call set_my_status blocked with the reason.`);
      if (lead) this.notify(lead.id, `${a.name} has been idle ${mins} min with ${task.id} still in progress. HQ nudged it; check on it if it doesn't move.`);
      this.progress(task.id, `${a.name} idle ${mins} min with the task in progress; nudged`);
      this.hub.activity("agent.needs-input", a.id, `${a.name} stalled on ${task.id} (idle ${mins} min)`);
    }
  }

  /**
   * HQ's progress ledger: each stall it saw. The second stall on a task asks the lead to replan it; from the third
   * the owner is pushed (docs/agent-engine.md section 4).
   */
  private progress(taskId: string, text: string) {
    const projectId = this.snap.config.project.id;
    try {
      this.memory?.addLedger({ projectId, taskId, ledger: "progress", kind: "stall", text, by: "hq" });
      const stalls = this.memory?.ledger(projectId, { taskId, ledger: "progress" }).filter((e) => e.kind === "stall" && !e.supersededBy).length ?? 0;
      const lead = this.snap.config.team.find((a) => a.isLead);
      const task = this.task(taskId);
      if (stalls === 2 && lead) {
        this.memory?.addLedger({ projectId, taskId, ledger: "progress", kind: "replan", text: `Stalled twice; asked ${lead.name} to replan`, by: "hq" });
        this.notify(lead.id, `${taskId}${task ? ` (${task.title})` : ""} has stalled twice (latest: ${text}). Replan it: split it, reassign it, or drop it, and record the new plan with ledger_add kind plan.`);
      } else if (stalls >= 3) {
        this.hub.activity("agent.needs-input", lead?.id ?? null, `${taskId} has stalled ${stalls} times, after the lead's replan. It needs you.`);
      }
    } catch {
      /* the ledger is a record, never a reason to stop a stall check */
    }
  }

  /**
   * Ids of the tasks `task` still waits on. A task that waits on exactly one task whose PR is open doesn't wait: it is
   * stacked on that PR's branch (docs/agent-engine.md section 6).
   */
  waitingOn(task: Task): string[] {
    const open = task.needs.filter((n) => this.task(n)?.status !== "done");
    return open.length === 1 && this.stackBase(task) ? [] : open;
  }

  /** The open PR `task` can stack on: its one unfinished dependency, in review with an open PR on GitHub. Pull-request flows only. */
  stackBase(task: Task): { taskId: string; prNumber: number; branch: string } | null {
    if (this.snap.config.workflow.mode !== "github-pr") return null;
    const open = task.needs.map((n) => this.task(n)).filter((d): d is Task => !!d && d.status !== "done");
    const dep = open.length === 1 ? open[0] : null;
    if (!dep || dep.status !== "in-review" || !dep.prNumber) return null;
    const pr = (this.snap.pullRequests ?? []).find((p) => p.number === dep.prNumber && p.taskId === dep.id);
    return pr && !pr.merged && !pr.closed && pr.branch ? { taskId: dep.id, prNumber: pr.number, branch: pr.branch } : null;
  }

  /** What an agent starting `task` on top of an unmerged PR has to do differently. */
  private stackNote(task: Task): string {
    const base = this.stackBase(task);
    return base
      ? ` It builds on ${base.taskId}, whose PR #${base.prNumber} isn't merged yet: branch from origin/${base.branch} (not main) and open your PR with --base ${base.branch}. HQ tells you when to rebase onto main.`
      : "";
  }

  /**
   * `dep` finished, or opened its PR: tells each owner whose queued task no longer waits on anything to start it.
   * Once `dep` is merged, the tasks stacked on its branch are told to move onto main.
   */
  private startUnblocked(dep: Task) {
    for (const t of this.snap.tasks) {
      if (!t.ownerId || !t.needs.includes(dep.id)) continue;
      if (dep.status === "done" && (t.status === "in-progress" || t.status === "in-review")) {
        // Started before `dep` was done, so it was stacked on dep's branch.
        const branch = (this.snap.pullRequests ?? []).find((p) => p.taskId === dep.id && p.number === dep.prNumber)?.branch;
        if (!branch) continue;
        const msg = this.record("hq", t.ownerId, `Rebase ${t.id} onto main (${dep.id} is merged)`);
        this.inbox.push(t.ownerId, {
          fromId: "hq", kind: "message", taskId: t.id, msgId: msg.id,
          text: `${dep.id} (PR #${dep.prNumber}) is merged. Move ${t.id} onto main: git fetch origin && git rebase --onto origin/main origin/${branch}, push with --force-with-lease${t.prNumber ? `, then gh pr edit ${t.prNumber} --base main` : ", and open your PR against main"}.`,
        });
        continue;
      }
      if (t.status !== "todo" || this.waitingOn(t).length) continue;
      const busy = this.currentTask(t.ownerId);
      const later = busy && busy.id !== t.id && busy.status === "in-progress" ? busy.id : null;
      if (!later) this.hub.setStatus(t.ownerId, { currentTaskId: t.id }); // else get_my_task moves on once `later` is done
      const why = dep.status === "done" ? `${dep.id} is done` : `${dep.id}'s PR is open`;
      const msg = this.record("hq", t.ownerId, `Start ${t.id}: ${t.title} (${why})`);
      const when = later ? `once you finish ${later}` : "now";
      this.inbox.push(t.ownerId, { fromId: "hq", kind: "assign", taskId: t.id, text: `${why}, so start ${t.id} (${t.title}) ${when}.${this.stackNote(t)} Call the hq get_my_task tool for the details.`, msgId: msg.id });
      this.onReady(t.ownerId);
    }
  }

  // ------------------------------------------------------------ messages

  /** Records a message, shows it in the office, and delivers it. */
  message(fromId: string, toRef: string, text: string) {
    const toId = /^(you|user|human)$/i.test(toRef.trim()) ? HUMAN_ID : this.agentId(toRef);
    if (toId === fromId) throw new Error("That's you.");
    if (toId === HUMAN_ID) {
      const clean = text.trim().slice(0, 2000);
      if (!clean) throw new Error("Empty message");
      this.record(fromId, HUMAN_ID, clean); // shows in that agent's thread; nothing to deliver
      this.hub.activity("message", fromId, `${this.hub.name(fromId)} → You: ${clean.slice(0, 80)}`);
      return toId;
    }
    if (!toId) throw new Error(`No agent "${toRef}". Team: ${this.snap.config.team.map((a) => a.id).join(", ")}`);
    const clean = text.trim().slice(0, 2000);
    if (!clean) throw new Error("Empty message");
    const duplicate = this.snap.messages.find((m) => m.fromId === fromId && m.toId === toId && m.text === clean && Date.now() - Date.parse(m.at) < 5 * 60_000);
    if (duplicate) return toId;
    const msg = this.record(fromId, toId, clean);
    this.hub.activity("message", fromId === "you" ? null : fromId, `${this.hub.name(fromId)} → ${this.hub.name(toId)}: ${clean.slice(0, 80)}`);
    this.inbox.push(toId, { fromId, kind: "message", text: clean, msgId: msg.id });
    return toId;
  }

  /** A notice from HQ itself (review results, merges) to one agent. */
  notify(agentId: string, text: string) {
    if (!this.hub.cfg(agentId)) return;
    const msg = this.record("hq", agentId, text);
    this.inbox.push(agentId, { fromId: "hq", kind: "notice", text, msgId: msg.id });
  }

  /** Adds to the history (saved) and the UI; to an agent it starts as "queued" until the inbox hands it over. */
  private record(fromId: string, toId: string, text: string): AgentMessage {
    this.seq += 1;
    const msg: AgentMessage = { id: `m${Date.now().toString(36)}${this.seq}`, at: now(), fromId, toId, text, ...(this.hub.cfg(toId) ? { delivered: "queued" as const } : {}) };
    this.snap.messages = [msg, ...this.snap.messages].slice(0, HISTORY);
    this.hub.emit({ type: "message", message: msg });
    this.inbox.save();
    return msg;
  }
}
