// SPDX-License-Identifier: AGPL-3.0-or-later
// On-demand workers (docs/agent-engine.md section 3). A seat whose role is on demand starts when it gets a task
// it can begin, and stops once it has no open task for GRACE_MS. Only seats HQ started this way are ever
// stopped: a session the owner started, or one found running after an HQ restart, is left alone.
// Over the machine's agent cap (`maxAgents`), or while the project is paused at its spend cap, a start waits in a
// queue, oldest first, and goes ahead when there is room again.

import type { Hub } from "./hub";

export const GRACE_MS = 2 * 60_000;

export interface Starter {
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  /** True when the machine already runs as many agents as it allows. */
  atCap(): boolean;
}

export class OnDemand {
  /** Seats HQ started on demand: the only ones it stops. */
  private started = new Set<string>();
  /** Since when each of those has had no open task. */
  private freeSince = new Map<string, number>();
  private queue: string[] = [];

  constructor(
    private hub: Pick<Hub, "snap" | "cfg" | "status" | "setStatus" | "activity">,
    private sessions: Starter,
    /** Why starts must wait (the project is paused at its spend cap), or null. */
    private paused: () => string | null = () => null,
  ) {}

  /** Whether this seat's role is started per task. The lead never is. */
  onDemand(agentId: string): boolean {
    const a = this.hub.cfg(agentId);
    const role = a?.roleId ? this.hub.snap.config.template?.roles.find((r) => r.id === a.roleId) : undefined;
    return !!role && role.onDemand && !role.isLead;
  }

  private up(agentId: string) {
    const s = this.hub.status(agentId)?.session.state;
    return s === "running" || s === "starting";
  }

  private openTasks(agentId: string) {
    return this.hub.snap.tasks.filter((t) => t.ownerId === agentId && t.status !== "done").length;
  }

  /** `agentId` has a task it can start now. */
  ready(agentId: string) {
    if (!this.onDemand(agentId) || this.up(agentId) || this.queue.includes(agentId)) return;
    const hold = this.paused();
    if (hold || this.sessions.atCap()) {
      this.queue.push(agentId);
      const why = hold ?? "a free slot (this machine runs as many agents as it allows)";
      this.hub.setStatus(agentId, { note: `Waiting for ${why}` });
      this.hub.activity("session", agentId, `${this.hub.cfg(agentId)?.name} waits for ${why} to start`);
      return;
    }
    this.started.add(agentId);
    this.freeSince.delete(agentId);
    void this.sessions.start(agentId);
  }

  /** Every usage poll: stops workers past their grace, then starts queued ones while there is room. */
  async tick(now = Date.now()) {
    for (const id of [...this.started]) {
      if (!this.up(id)) {
        this.started.delete(id); // stopped by the owner or crashed: no longer HQ's to manage
        this.freeSince.delete(id);
        continue;
      }
      const st = this.hub.status(id);
      if (this.openTasks(id) || st?.state !== "idle") {
        this.freeSince.delete(id);
        continue;
      }
      const since = this.freeSince.get(id) ?? now;
      this.freeSince.set(id, since);
      if (now - since < GRACE_MS) continue;
      this.started.delete(id);
      this.freeSince.delete(id);
      this.hub.activity("session", id, `${this.hub.cfg(id)?.name} has no open task: stopping it until the next one`);
      await this.sessions.stop(id);
    }
    while (this.queue.length && !this.paused() && !this.sessions.atCap()) {
      const id = this.queue.shift()!;
      if (this.openTasks(id)) this.ready(id);
    }
  }

  /** Seats HQ is managing right now (for the debug panel and tests). */
  managed() {
    return { started: [...this.started], queued: [...this.queue] };
  }
}
