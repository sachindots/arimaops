// The stream engine for Claude Code seats (docs/design/stream-json.md). The agent runs headless
// (`claude -p --input-format stream-json …`) under a small runner in tmux (server/streamRunner.ts), which pulls
// messages from HQ and posts Claude's events back, over the same per-agent token as hooks and the Team MCP.
//
// Delivery: the inbox hands a message to `type()`, which queues it here; the runner long-polls `next()`.
// A message stays queued until the runner acknowledges it (the next poll carries its seq), so a dropped
// connection never loses one. Status comes from events, next to the hooks Claude still fires.

import type { AgentConfig } from "../src/data/types";
import type { Hub } from "./hub";
import { CLEAR_COMMAND } from "./adapters";

/** Only Claude Code, and only where it already runs without permission prompts. */
export const isStream = (a: AgentConfig | undefined) => !!a && a.engine === "stream" && a.cli === "claude" && a.mode !== "local";

export type StreamItem = { seq: number; text: string } | { seq: number; reset: true };

const CONNECTED_MS = 40_000; // the runner polls at least every 25 s
const MAX_EVENTS = 200; // per batch

export class StreamEngine {
  private queues = new Map<string, StreamItem[]>();
  private seq = new Map<string, number>();
  private waiters = new Map<string, () => void>();
  private lastSeen = new Map<string, number>();
  /** A message was handed over and its turn hasn't ended. */
  private busy = new Set<string>();

  constructor(
    private hub: Pick<Hub, "status" | "setStatus" | "activity" | "name">,
    private session: { up(agentId: string): void },
  ) {}

  // ---------------------------------------------------------------- the inbox's side (its Keyboard)

  /** Queues a message, or the new-conversation command as a reset. Always accepted. */
  type(agentId: string, text: string): boolean {
    const n = (this.seq.get(agentId) ?? 0) + 1;
    this.seq.set(agentId, n);
    const q = this.queues.get(agentId) ?? [];
    q.push(text.trim() === CLEAR_COMMAND.claude ? { seq: n, reset: true } : { seq: n, text });
    this.queues.set(agentId, q);
    this.waiters.get(agentId)?.();
    return true;
  }

  /** The runner is there and no turn is running: a message would be taken at once. */
  ready(agentId: string): boolean {
    return Date.now() - (this.lastSeen.get(agentId) ?? 0) < CONNECTED_MS && !this.busy.has(agentId) && !this.queues.get(agentId)?.length;
  }

  // ---------------------------------------------------------------- the runner's side

  /** Drops what the runner has taken (up to `ack`), then waits up to `waitMs` for the next item. */
  async next(agentId: string, ack: number, waitMs: number, gone: AbortSignal): Promise<StreamItem | null> {
    this.lastSeen.set(agentId, Date.now());
    const q = (this.queues.get(agentId) ?? []).filter((i) => i.seq > ack);
    this.queues.set(agentId, q);
    if (!q.length && waitMs > 0 && !gone.aborted) {
      await new Promise<void>((resolve) => {
        const done = () => (clearTimeout(t), gone.removeEventListener("abort", done), this.waiters.delete(agentId), resolve());
        const t = setTimeout(done, waitMs);
        gone.addEventListener("abort", done);
        this.waiters.set(agentId, done);
      });
      this.lastSeen.set(agentId, Date.now());
    }
    const item = this.queues.get(agentId)?.[0] ?? null;
    if (item && "text" in item) this.busy.add(agentId);
    return item;
  }

  /** A batch of the runner's events. Unknown events and fields are ignored: the schema is Claude Code's. */
  events(agentId: string, batch: unknown): void {
    this.lastSeen.set(agentId, Date.now());
    if (!Array.isArray(batch)) return;
    for (const raw of batch.slice(0, MAX_EVENTS)) {
      if (!raw || typeof raw !== "object") continue;
      const e = raw as { type?: unknown; subtype?: unknown; is_error?: unknown; result?: unknown; message?: { content?: unknown } };
      const st = this.hub.status(agentId);
      if (e.type === "runner" && e.subtype === "started") {
        // Claude is up and reading stdin: deliveries can start (its SessionStart hook may only come with the first message).
        this.busy.delete(agentId);
        this.session.up(agentId);
        if (st && st.state !== "needs-input") this.hub.setStatus(agentId, { state: "idle", note: "Ready (stream)" });
      } else if (e.type === "assistant") {
        const tool = Array.isArray(e.message?.content) ? (e.message.content as { type?: unknown; name?: unknown }[]).find((c) => c?.type === "tool_use") : undefined;
        if (st && st.state !== "needs-input") this.hub.setStatus(agentId, { state: "working", note: typeof tool?.name === "string" ? `Using ${tool.name.slice(0, 60)}` : "Working" });
      } else if (e.type === "result") {
        this.busy.delete(agentId);
        const failed = e.is_error === true || (typeof e.subtype === "string" && e.subtype !== "success");
        if (failed) this.hub.activity("session", agentId, `${this.hub.name(agentId)}'s turn ended with an error: ${String(e.result ?? e.subtype).slice(0, 200)}`);
        if (st && st.state === "working") this.hub.setStatus(agentId, { state: "idle", note: failed ? "Turn failed: see its terminal" : "Waiting for you" });
      }
    }
  }

  /** The session stopped: nothing is in flight any more. Queued items wait for the next start. */
  down(agentId: string) {
    this.busy.delete(agentId);
    this.lastSeen.delete(agentId);
  }
}
