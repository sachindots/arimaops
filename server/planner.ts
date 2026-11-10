// Boards, tasks, assignments and messages. Used by both the Team MCP tools
// (agents) and the browser commands (you), so both follow the same rules.

import { CLI_LABEL, HUMAN_ID, isAgentCli, type AgentCli, type AgentMessage, type Board, type Task, type TaskStatus, type Tokens } from "../src/data/types";
import type { Hub } from "./hub";
import type { ActionItems } from "./actionItems";
import type { Findings } from "./findings";
import { HISTORY, type Inbox } from "./inbox";
import { CLEAR_COMMAND } from "./adapters";
import { FACTS_PROMPT, mergeFacts, readFacts, writeFacts } from "./facts";
import { askHaiku } from "./lib/haiku";
import { diff } from "./usage";
import { syncDeliverablesFromAgent, syncRepoToWorkspace } from "./workspace";

export interface NewTask {
  boardId?: string;
  title: string;
  description?: string;
  files?: string[];
  doneWhen?: string;
  needs?: string[];
  cli?: AgentCli | null;
  model?: string | null;
}

export type TaskPatch = Partial<Pick<Task, "title" | "description" | "files" | "doneWhen" | "needs" | "status" | "boardId" | "note" | "prNumber" | "deliverablePath" | "cli" | "model">>;

const now = () => new Date().toISOString();

export class Planner {
  private seq = 0;
  /** Set by main: the user's action items (Team MCP `ask_user`). */
  actions: ActionItems | null = null;
  /** Set by project.ts: security findings (Team MCP report_finding). */
  findings: Findings | null = null;

  /** An agent's token total right now (set by the project; null when its CLI's logs can't be read). */
  usageOf: (agentId: string) => Tokens | null = () => null;
  // shortcut: start totals live in memory, so a task running across an HQ restart gets no usage figure.
  private usageAtStart = new Map<string, Tokens>();

  constructor(private hub: Hub, private inbox: Inbox) {}

  private meterStart(task: Task) {
    const now = task.ownerId ? this.usageOf(task.ownerId) : null;
    if (now && !this.usageAtStart.has(task.id)) this.usageAtStart.set(task.id, now);
  }

  private meterEnd(task: Task) {
    const start = this.usageAtStart.get(task.id);
    const now = task.ownerId ? this.usageOf(task.ownerId) : null;
    if (start && now) task.usage = diff(now, start);
    this.usageAtStart.delete(task.id);
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

  defaultBoard(): Board {
    const active = this.snap.boards.filter((b) => b.status === "active").sort((a, b) => a.order - b.order);
    if (active[0]) return active[0];
    return this.createBoard("Backlog", "active");
  }

  // ------------------------------------------------------------ boards

  createBoard(title: string, status: Board["status"] = "planned"): Board {
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
    const board = this.snap.boards.find((b) => b.id === id);
    if (!board) throw new Error(`No board ${id}`);
    if (patch.title?.trim()) board.title = patch.title.trim().slice(0, 80);
    if (patch.status) board.status = patch.status;
    this.hub.emit({ type: "board.updated", board: { ...board } });
    this.hub.planChanged();
    return board;
  }

  // ------------------------------------------------------------ tasks

  createTask(input: NewTask, byId: string): Task {
    const board = input.boardId ? this.snap.boards.find((b) => b.id === input.boardId) : this.defaultBoard();
    if (!board) throw new Error(`No board ${input.boardId}. Boards: ${this.snap.boards.map((b) => b.id).join(", ")}`);
    let n = this.snap.tasks.filter((t) => t.boardId === board.id).length + 1;
    let id = `${board.id}-T${String(n).padStart(2, "0")}`;
    while (this.task(id)) id = `${board.id}-T${String(++n).padStart(2, "0")}`;
    const task: Task = {
      id, boardId: board.id, title: input.title.trim().slice(0, 120), ownerId: null, status: "todo",
      needs: input.needs ?? [], prNumber: null, description: input.description ?? "", files: input.files ?? [], doneWhen: input.doneWhen ?? "", note: null, deliverablePath: null,
      cli: input.cli && isAgentCli(input.cli) ? input.cli : null, model: input.model?.trim().slice(0, 80) || null,
    };
    this.snap.tasks.push(task);
    this.hub.emit({ type: "task.updated", task: { ...task } });
    this.hub.activity("task.created", byId === "you" ? null : byId, `${this.hub.name(byId)} added ${task.id} ${task.title}`);
    this.hub.planChanged();
    return task;
  }

  updateTask(id: string, patch: TaskPatch): Task {
    const task = this.task(id);
    if (!task) throw new Error(`No task ${id}`);
    const wasDone = task.status === "done";
    Object.assign(task, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    if (task.status === "done" && !wasDone) {
      this.meterEnd(task);
      for (const a of this.snap.agents) if (a.currentTaskId === task.id) this.hub.setStatus(a.agentId, { currentTaskId: null });
      this.afterDone(task);
      this.startUnblocked(task);
    }
    if (task.status === "done" || task.status === "in-review") void this.syncTaskDeliverables(task);
    this.hub.emit({ type: "task.updated", task: { ...task } });
    this.hub.planChanged();
    return task;
  }

  /** Gives a task to an agent and tells them to start. */
  assign(taskId: string, agentRef: string, byId: string): Task {
    const task = this.task(taskId);
    const agentId = this.agentId(agentRef);
    if (!task) throw new Error(`No task ${taskId}`);
    if (!agentId) throw new Error(`No agent "${agentRef}". Team: ${this.snap.config.team.map((a) => a.id).join(", ")}`);
    const agent = this.hub.cfg(agentId)!;
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
      : `${by} assigned you ${task.id} (${task.title}). Pull main, start ${task.id}. Call the hq get_my_task tool for the details.`;
    const msg = this.record(byId, agentId, `Start ${task.id}: ${task.title}`);
    this.inbox.push(agentId, { fromId: byId, kind: "assign", text, msgId: msg.id, taskId: task.id });
    return task;
  }

  setStatus(agentId: string, status: Extract<TaskStatus, "in-progress" | "blocked" | "in-review" | "done">, note?: string, prNumber?: number, deliverablePath?: string): Task {
    const task = this.currentTask(agentId);
    if (!task) throw new Error("You have no task. Ask the lead for one.");
    task.status = status;
    task.note = note?.slice(0, 300) || null;
    if (prNumber) task.prNumber = prNumber;
    if (deliverablePath) task.deliverablePath = deliverablePath.slice(0, 300);
    if (status === "in-progress") this.meterStart(task);
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

  /** Haiku by default; tests swap it out. */
  ask: typeof askHaiku = askHaiku;

  private lean = () => this.snap.config.workflow.lean?.clearBetweenTasks !== false;

  /** Lean mode, once a task is done: its owner starts the next one in a fresh conversation, and the repo facts learn from it. */
  private afterDone(done: Task) {
    if (!this.lean()) return;
    void this.learnFacts(done);
    const id = done.ownerId;
    const agent = id ? this.hub.cfg(id) : undefined;
    const cmd = agent && CLEAR_COMMAND[agent.cli];
    if (!id || !agent || agent.isLead || !cmd || this.hub.status(id)?.session.state !== "running") return;
    const next = this.currentTask(id);
    // Mid-way through another task, or the next one builds on this one: keep the conversation.
    if (next && next.id !== done.id && (next.status === "in-progress" || next.needs.includes(done.id))) return;
    this.inbox.push(id, { fromId: "hq", kind: "reset", text: cmd });
  }

  private async learnFacts(done: Task) {
    const root = this.hub.repo.root;
    const existing = readFacts(root);
    const a = await this.ask<{ facts?: unknown }>(FACTS_PROMPT(done.title, done.note ?? "", done.files ?? [], existing));
    const proposed = Array.isArray(a?.json.facts) ? a.json.facts.filter((f): f is string => typeof f === "string").slice(0, 2) : [];
    const current = readFacts(root); // re-read: another task may have added some meanwhile
    const merged = mergeFacts(current, proposed);
    const added = merged.filter((f) => !current.includes(f)).length;
    if (!added) return;
    writeFacts(root, merged);
    this.hub.activity("config", null, `Repo facts: ${added} new from ${done.id} (facts.md)`);
  }

  /** What an agent needs to start a task without re-exploring: the handoffs it builds on, its own last note, the repo facts. */
  brief(agentId: string, task: Task) {
    const handoffs = task.needs
      .map((n) => this.task(n))
      .filter((d): d is Task => !!d?.note)
      .map((d) => ({ task: d.id, by: d.ownerId ? this.hub.name(d.ownerId) : null, note: d.note }));
    const mine = this.snap.tasks.filter((t) => t.ownerId === agentId && t.status === "done" && t.note && t.id !== task.id);
    return { handoffs, yourLastNote: mine.at(-1)?.note ?? null, repoFacts: readFacts(this.hub.repo.root) };
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
      if (this.stallNudged.has(key)) continue;
      // "Working" but no hook for a long time: frozen, or one command hanging. Typing into it would interrupt, so tell the lead.
      const quietMs = now - Math.max(this.lastActivityAt(a.id), Date.parse(st.stateSince));
      if (st.state === "working" && quietMs >= silentMs) {
        this.stallNudged.add(key);
        const mins = Math.round(quietMs / 60_000);
        if (lead) this.notify(lead.id, `${a.name} shows Working on ${task.id} but has done nothing visible for ${mins} min (a command may be hanging). Check its terminal in HQ, or ask the user to.`);
        this.hub.activity("agent.needs-input", a.id, `${a.name} silent for ${mins} min while working on ${task.id}`);
        continue;
      }
      if (st.state !== "idle" || now - Date.parse(st.stateSince) < idleMs || this.inbox.pending(a.id) > 0) continue;
      this.stallNudged.add(key);
      const mins = Math.round((now - Date.parse(st.stateSince)) / 60_000);
      this.notify(a.id, `HQ: you've been idle ${mins} min but ${task.id} is still in progress. If you were waiting on a background command or job, it won't wake you: check it now and continue in the foreground. If you're blocked, call set_my_status blocked with the reason.`);
      if (lead) this.notify(lead.id, `${a.name} has been idle ${mins} min with ${task.id} still in progress. HQ nudged it; check on it if it doesn't move.`);
      this.hub.activity("agent.needs-input", a.id, `${a.name} stalled on ${task.id} (idle ${mins} min)`);
    }
  }

  /** Ids of the tasks `task` still waits on. */
  waitingOn(task: Task): string[] {
    return task.needs.filter((n) => this.task(n)?.status !== "done");
  }

  /** `done` finished: tells each owner whose queued task no longer waits on anything to start it. */
  private startUnblocked(done: Task) {
    for (const t of this.snap.tasks) {
      if (!t.ownerId || t.status !== "todo" || !t.needs.includes(done.id) || this.waitingOn(t).length) continue;
      const busy = this.currentTask(t.ownerId);
      const later = busy && busy.id !== t.id && busy.status === "in-progress" ? busy.id : null;
      if (!later) this.hub.setStatus(t.ownerId, { currentTaskId: t.id }); // else get_my_task moves on once `later` is done
      const msg = this.record("hq", t.ownerId, `Start ${t.id}: ${t.title} (${done.id} is done)`);
      const when = later ? `once you finish ${later}` : "now";
      this.inbox.push(t.ownerId, { fromId: "hq", kind: "assign", taskId: t.id, text: `${done.id} is done, so start ${t.id} (${t.title}) ${when}. Call the hq get_my_task tool for the details.`, msgId: msg.id });
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
