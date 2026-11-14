// SPDX-License-Identifier: AGPL-3.0-or-later
// Certifying memories (docs/memory-core.md section 8). New memories wait in Action items, one item per
// task. They aren't pushed one by one: a digest goes out daily at 09:00, and only a memory that may
// contradict a certified one is pushed at once.
//
// "May contradict" is an approximation: a new Decision or DeadEnd about the same file or component as a
// certified memory of the same type. Telling a real contradiction apart needs a model call; the user
// decides with both texts side by side.

import type { Memory } from "../src/data/model";
import type { ActionItems } from "./actionItems";
import type { Hub } from "./hub";
import { log } from "./lib/log";
import type { Neo4jMemory } from "./memory";

const URGENT_TYPES = new Set(["Decision", "DeadEnd"]);
export const DIGEST_HOUR = 9;

export class MemoryReview {
  private stopListening: () => void;

  constructor(
    private hub: Pick<Hub, "emit" | "snap">,
    private actions: ActionItems,
    private mem: Neo4jMemory,
  ) {
    this.stopListening = mem.onRemember((m) => this.filed(m));
  }

  private get projectId() {
    return this.hub.snap.config.project.id;
  }

  private filed(m: Memory) {
    if (m.projectId !== this.projectId) return;
    this.actions.addMemory(m);
    if (URGENT_TYPES.has(m.type) && m.about.length) void this.checkConflict(m);
  }

  /** Pushes at once when a new memory sits on the same thing as a certified one of its type. */
  async checkConflict(m: Pick<Memory, "id" | "type" | "text" | "about">) {
    try {
      const certified = await this.mem.certifiedAbout(this.projectId, m.type, m.about);
      const other = certified.find((c) => c.id !== m.id);
      if (!other || !this.actions.setConflict(m.id, { id: other.id, text: other.text })) return;
      this.hub.emit({ type: "memory.digest", key: `urgent:${m.id}`, count: this.actions.pendingMemories(), urgent: `${m.type} "${m.text}" may contradict certified ${other.id}: "${other.text}"` });
    } catch (err) {
      log.warn(`memory: couldn't check ${m.id} against certified memories: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Lines the items up with the graph (memories made while the project wasn't loaded, merged or faded ones). Needs Neo4j. */
  async sync() {
    try {
      const all = await this.mem.memories(this.projectId);
      this.actions.syncMemories(all.filter((m) => !m.certified));
    } catch (err) {
      log.warn(`memory: couldn't sync the memories to check: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** The daily push: how many memories wait. Nothing when none do. */
  digest(now = new Date()) {
    const count = this.actions.pendingMemories();
    if (count) this.hub.emit({ type: "memory.digest", key: `digest:${now.toISOString().slice(0, 10)}`, count, urgent: null });
  }

  stop() {
    this.stopListening();
  }
}

/** The next `hour`:00 local after `now`. */
export function nextAt(now: Date, hour: number): Date {
  const at = new Date(now);
  at.setHours(hour, 0, 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at;
}

/** Runs `job` every day at `hour`:00 local. Returns a stop function. */
export function daily(hour: number, job: () => void | Promise<void>): () => void {
  let timer: NodeJS.Timeout;
  const arm = () => {
    timer = setTimeout(async () => {
      try {
        await job();
      } catch (err) {
        log.warn(`daily job at ${hour}:00 failed: ${err instanceof Error ? err.message : err}`);
      }
      arm();
    }, nextAt(new Date(), hour).getTime() - Date.now());
    timer.unref();
  };
  arm();
  return () => clearTimeout(timer);
}
