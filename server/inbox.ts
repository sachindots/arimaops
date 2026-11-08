// Delivery to agents. If the agent is idle at its prompt, HQ types the message
// into its terminal. If it's busy, the message waits and is handed over by the
// agent's Stop hook when its turn ends (Claude Code then continues with it).
// The queue and the message history are saved in ~/.hq/<project>/messages.json, so an
// HQ restart loses nothing: queued messages are delivered once the agent is back.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "../src/data/types";
import type { Hub } from "./hub";
import { log } from "./lib/log";
import { projectHome } from "./paths";

export interface InboxItem {
  fromId: string; // agent id or "you"
  text: string;
  kind: "message" | "assign" | "notice"; // notice = from HQ itself (e.g. review results)
  /** The AgentMessage this delivers (its status is updated when it's handed over). */
  msgId?: string;
}

export const HISTORY = 300; // messages kept (and sent to the UI)

export interface Keyboard {
  type(agentId: string, text: string): Promise<boolean>;
  enter(agentId: string): Promise<boolean>;
}

const QUIET_MS = 1000; // no hooks for this long = the prompt has settled
const SUBMIT_CHECK_MS = 3000; // typed text should produce UserPromptSubmit by then

export class Inbox {
  private queues = new Map<string, InboxItem[]>();
  private sessionUp = new Set<string>(); // SessionStart seen: Claude Code's prompt exists
  private lastHook = new Map<string, number>();
  private lastSubmit = new Map<string, number>();
  private typing = new Set<string>();
  private timer: NodeJS.Timeout;
  private file: string;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private hub: Hub, private keys: Keyboard) {
    this.file = join(projectHome(hub.slug), "messages.json");
    this.load();
    // Safety net: retry anything queued for agents that have gone idle.
    this.timer = setInterval(() => {
      for (const id of this.queues.keys()) void this.tryType(id);
    }, 2000);
  }

  stop() {
    clearInterval(this.timer);
    this.flush();
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as { queues?: Record<string, InboxItem[]>; messages?: AgentMessage[] };
      for (const [id, q] of Object.entries(data.queues ?? {})) if (q.length && this.hub.cfg(id)) this.queues.set(id, q);
      this.hub.snap.messages = (data.messages ?? []).slice(0, HISTORY);
      const waiting = [...this.queues.values()].reduce((n, q) => n + q.length, 0);
      if (waiting) log.info(`${this.hub.slug}: ${waiting} queued message(s) kept from before the restart`);
    } catch (err) {
      log.warn(`couldn't read ${this.file}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Saves soon (several changes in a row write once). */
  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 200);
  }

  private flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const data = { queues: Object.fromEntries([...this.queues].filter(([, q]) => q.length)), messages: this.hub.snap.messages.slice(0, HISTORY) };
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      log.warn(`couldn't save messages: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Marks the messages behind these items as handed over. */
  private delivered(items: InboxItem[], how: NonNullable<AgentMessage["delivered"]>) {
    for (const i of items) {
      const m = i.msgId && this.hub.snap.messages.find((x) => x.id === i.msgId);
      if (!m) continue;
      m.delivered = how;
      this.hub.emit({ type: "message", message: { ...m } });
    }
    this.save();
  }

  push(agentId: string, item: InboxItem) {
    const q = this.queues.get(agentId) ?? [];
    q.push(item);
    this.queues.set(agentId, q);
    this.save();
    void this.tryType(agentId);
  }

  /** When the agent's last hook arrived (0 if never). */
  lastHookAt(agentId: string): number {
    return this.lastHook.get(agentId) ?? 0;
  }

  pending(agentId: string) {
    return this.queues.get(agentId)?.length ?? 0;
  }

  /** Every hook event goes through here (before the state change it causes). */
  noteHook(agentId: string, event: string) {
    this.lastHook.set(agentId, Date.now());
    if (event === "SessionStart") this.sessionUp.add(agentId);
    if (event === "SessionEnd") this.sessionUp.delete(agentId);
    if (event === "UserPromptSubmit") this.lastSubmit.set(agentId, Date.now());
    if (event === "Stop" || event === "SessionStart" || event === "Notification") setTimeout(() => void this.tryType(agentId), QUIET_MS + 100);
  }

  /** An already-running session was reattached: its prompt exists even though HQ missed SessionStart. */
  sessionReattached(agentId: string) {
    this.sessionUp.add(agentId);
  }

  /** The session stopped or restarted: Claude Code's prompt is gone until the next SessionStart. */
  sessionDown(agentId: string) {
    this.sessionUp.delete(agentId);
  }

  forget(agentId: string) {
    this.queues.delete(agentId);
    this.sessionUp.delete(agentId);
    this.save();
  }

  /** Called from the Stop hook: everything queued, as the reason Claude continues with. */
  takeForStop(agentId: string): string | null {
    const q = this.queues.get(agentId);
    if (!q?.length) return null;
    this.queues.set(agentId, []);
    this.delivered(q, "on-stop");
    return this.format(q);
  }

  private canType(agentId: string): boolean {
    const st = this.hub.status(agentId);
    return (
      !!st &&
      this.sessionUp.has(agentId) &&
      st.session.state === "running" &&
      st.state === "idle" &&
      !this.typing.has(agentId) &&
      Date.now() - (this.lastHook.get(agentId) ?? 0) >= QUIET_MS
    );
  }

  private whyNot(agentId: string): string {
    const st = this.hub.status(agentId);
    return JSON.stringify({ up: this.sessionUp.has(agentId), session: st?.session.state, state: st?.state, note: st?.note, typing: this.typing.has(agentId), quietMs: Date.now() - (this.lastHook.get(agentId) ?? 0) });
  }

  /** Types queued items into an idle agent. Safe to call any time. */
  async tryType(agentId: string) {
    const q = this.queues.get(agentId);
    if (!q?.length) return;
    if (!this.canType(agentId)) {
      if (process.env.HQ_DEBUG) log.info(`inbox ${agentId}: holding ${q.length} — ${this.whyNot(agentId)}`);
      return;
    }
    const items = q.splice(0);
    this.typing.add(agentId);
    const typedAt = Date.now();
    try {
      if (!(await this.keys.type(agentId, this.format(items)))) {
        log.warn(`could not type into ${agentId}; keeping ${items.length} message(s) queued`);
        this.queues.set(agentId, [...items, ...(this.queues.get(agentId) ?? [])]);
        return;
      }
      this.delivered(items, "typed");
      // If the prompt didn't submit (Enter swallowed), press it once more.
      await new Promise((r) => setTimeout(r, SUBMIT_CHECK_MS));
      if ((this.lastSubmit.get(agentId) ?? 0) < typedAt && this.hub.status(agentId)?.state === "idle") {
        log.warn(`${agentId}: no prompt submit after typing; pressing Enter again`);
        await this.keys.enter(agentId);
      }
    } finally {
      this.typing.delete(agentId);
    }
  }

  private format(items: InboxItem[]): string {
    const lines = items.map((i) =>
      i.kind === "message" ? `[HQ] Message from ${this.hub.name(i.fromId)}: ${i.text}` : `[HQ] ${i.text}`,
    );
    const fromAgent = items.some((i) => i.kind === "message" && i.fromId !== "you");
    // Claude Code submits on newline, so everything goes on one line.
    return (lines.join("  ·  ") + (fromAgent ? "  (Reply with the hq send_message tool only if a reply is needed.)" : "")).replace(/\s*\n\s*/g, " ");
  }
}
