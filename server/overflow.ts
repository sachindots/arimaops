// SPDX-License-Identifier: AGPL-3.0-or-later
// Codex overflow, ask first (docs/agent-engine.md section 7). When a seat hits its CLI's usage limit and its role
// has a fallback, HQ asks the owner (an Action item) to move the seat's task to the fallback CLI and model. Never
// automatic, not even with the owner away. A moved seat runs the fallback for that task only: once the task is done
// or goes to someone else and the session is down, the seat is back on its role's CLI.

import type { Role } from "../src/data/model";
import { CLI_LABEL, type AgentCli, type Task } from "../src/data/types";
import type { ActionItems } from "./actionItems";
import type { Hub } from "./hub";
import type { Planner } from "./planner";

export interface OverflowMove {
  agentId: string;
  taskId: string;
  cli: AgentCli;
  model: string;
}

export class Overflow {
  /** Seats running their fallback, and the task they took it for. shortcut: in memory; after an HQ restart the seat is back on its role's CLI (a still-running fallback session keeps going until stopped). */
  private moved = new Map<string, string>();

  constructor(
    private hub: Pick<Hub, "snap" | "cfg" | "status" | "setStatus" | "activity" | "configChanged">,
    private planner: Pick<Planner, "currentTask" | "task" | "notify"> & { actions?: ActionItems | null },
    private sessions: { start(id: string): Promise<void>; stop(id: string): Promise<void> },
  ) {}

  private role(agentId: string): Role | undefined {
    const a = this.hub.cfg(agentId);
    return a?.roleId ? this.hub.snap.config.template?.roles.find((r) => r.id === a.roleId) : undefined;
  }

  /** A seat hit its usage limit: offer the fallback for its current task, once per seat and task. */
  offer(agentId: string, until: Date): boolean {
    const a = this.hub.cfg(agentId);
    const fallback = this.role(agentId)?.fallback;
    const task = this.planner.currentTask(agentId);
    if (!a || a.isLead || !fallback || a.cli === fallback.cli || !task || task.status === "done") return false;
    const at = until.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return !!this.planner.actions?.addOverflow(
      { agentId, taskId: task.id, cli: fallback.cli, model: fallback.model },
      `${a.name} hit the ${CLI_LABEL[a.cli]} limit until ${at} on ${task.id}. Continue it on ${CLI_LABEL[fallback.cli]} (${fallback.model}) now?`,
      `${task.title}\n\nMove: HQ stops ${a.name} and starts it on ${CLI_LABEL[fallback.cli]} for ${task.id} only, with a handoff from the branch and the task's notes. Its role stays ${CLI_LABEL[a.cli]}.\nWait: nothing changes; ${a.name} goes on at ${at}.`,
    );
  }

  /** The owner chose Move: restart the seat on the fallback for this task. */
  async move(m: OverflowMove) {
    const a = this.hub.cfg(m.agentId);
    const task: Task | undefined = this.planner.task(m.taskId);
    if (!a || !task || task.ownerId !== m.agentId || task.status === "done") {
      this.hub.activity("config", null, `Overflow for ${m.taskId} no longer applies: the task moved on.`);
      return;
    }
    const from = a.cli;
    await this.sessions.stop(m.agentId);
    Object.assign(a, { cli: m.cli, model: m.model }); // in place: the rest of HQ holds this object; config.json keeps only the seat
    this.moved.set(m.agentId, m.taskId);
    this.hub.setStatus(m.agentId, { limitedUntil: null, currentTaskId: task.id });
    this.hub.configChanged();
    this.planner.notify(m.agentId, `You're taking over ${task.id} (${task.title}) from a ${CLI_LABEL[from]} session that hit its usage limit. Read get_my_task, then the branch's last commits and your handoff notes, and carry on from there.`);
    this.hub.activity("session", m.agentId, `${a.name} moves to ${CLI_LABEL[m.cli]} (${m.model}) for ${task.id}`);
    await this.sessions.start(m.agentId);
  }

  /** Every usage poll: a seat whose fallback task is over, with its session down, goes back to its role's CLI. */
  tick() {
    for (const [agentId, taskId] of [...this.moved]) {
      const task = this.planner.task(taskId);
      const s = this.hub.status(agentId)?.session.state;
      if ((task && task.ownerId === agentId && task.status !== "done") || s === "running" || s === "starting") continue;
      const role = this.role(agentId);
      const a = this.hub.cfg(agentId);
      this.moved.delete(agentId);
      if (!a || !role) continue;
      Object.assign(a, { cli: role.cli, model: role.model });
      this.hub.configChanged();
      this.hub.activity("session", agentId, `${a.name} is back on ${CLI_LABEL[role.cli]} for its next task`);
    }
  }

  movedSeats() {
    return [...this.moved.keys()];
  }
}
