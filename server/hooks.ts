// Claude Code / Codex hooks → agent state. Each agent's hooks POST to
// /hook/<agentId>/<Event> with the hook's JSON payload.

import type { Hub } from "./hub";
import type { Inbox } from "./inbox";

interface HookPayload {
  prompt?: string;
  tool_name?: string;
  toolCall?: { name?: string };
  message?: string;
  notification_type?: string;
}

const clip = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/**
 * Whether the agent is inside a turn (prompt submitted, no Stop yet). Hooks can
 * arrive late or out of order (e.g. a PreToolUse after Stop), so only a new prompt
 * may turn an idle agent back to "working".
 */
const turnOpen = new Map<string, boolean>();

export interface HookResult {
  ok: boolean;
  /** JSON printed by the hook command; Claude Code / Antigravity acts on it. */
  response?: Record<string, unknown>;
}

export function handleHook(hub: Hub, inbox: Inbox, agentId: string, rawEvent: string, body: HookPayload): HookResult {
  const st = hub.status(agentId);
  const turnKey = `${hub.slug}:${agentId}`; // agent ids repeat across projects in one server
  const name = hub.name(agentId);
  const isAgy = hub.cfg(agentId)?.cli === "agy";
  if (!st) return { ok: false };
  // Normalize Antigravity (agy) / Gemini CLI hook event names to .hq's canonical lifecycle events.
  const event =
    rawEvent === "BeforeAgent" || rawEvent === "PreInvocation"
      ? "UserPromptSubmit"
      : rawEvent === "BeforeTool"
        ? "PreToolUse"
        : rawEvent === "AfterTool"
          ? "PostToolUse"
          : rawEvent === "AfterAgent"
            ? "Stop"
            : rawEvent;
  inbox.noteHook(agentId, event);
  const toolName = body.tool_name ?? body.toolCall?.name;

  switch (event) {
    case "SessionStart":
      turnOpen.set(turnKey, false);
      hub.setStatus(agentId, { state: "idle", note: "Ready" });
      break;
    case "UserPromptSubmit":
      turnOpen.set(turnKey, true);
      hub.setStatus(agentId, { state: "working", note: body.prompt ? clip(body.prompt.replace(/\s+/g, " ")) : null });
      if (st.state !== "working") hub.activity("task.started", agentId, `${name} is working`);
      if (isAgy) return { ok: true, response: {} };
      break;
    case "PreToolUse":
      // Stale: the turn already ended. (Unknown, e.g. after an HQ restart, is allowed.)
      if (turnOpen.get(turnKey) !== false) {
        // Also clears "needs input" once a permission prompt is answered.
        if (st.state !== "working" || st.note?.startsWith("Asking")) hub.setStatus(agentId, { state: "working", note: toolName ? `Using ${toolName}` : null });
      }
      if (isAgy) return { ok: true, response: { decision: "allow" } };
      break;
    case "PostToolUse":
      // A tool finished: if it was waiting on the user (a question or a permission), they answered.
      if (turnOpen.get(turnKey) !== false && st.state === "needs-input") {
        hub.setStatus(agentId, { state: "working", note: "Continuing after your answer" });
      }
      if (isAgy) return { ok: true, response: {} };
      break;
    case "PermissionRequest": {
      // Codex: an approval prompt is waiting in the terminal.
      const what = toolName ? `Approve ${toolName}?` : "Approval needed in the terminal";
      hub.setStatus(agentId, { state: "needs-input", note: `Asking: ${what}` });
      hub.activity("agent.needs-input", agentId, `${name} needs you: ${what}`);
      break;
    }
    case "Notification": {
      const msg = body.message ?? "Needs your attention";
      // "Waiting for your input" fires after a finished turn sits idle — not urgent.
      if (/waiting for your input/i.test(msg) || body.notification_type === "idle_prompt") {
        hub.setStatus(agentId, { state: "idle", note: "Waiting for you" });
        break;
      }
      hub.setStatus(agentId, { state: "needs-input", note: `Asking: ${clip(msg)}` });
      hub.activity("agent.needs-input", agentId, `${name} needs you: ${clip(msg, 60)}`);
      break;
    }
    case "Stop": {
      // Messages that arrived while the agent was busy: hand them over now,
      // and the agent continues with them instead of stopping.
      const queued = inbox.takeForStop(agentId);
      if (queued) {
        turnOpen.set(turnKey, true); // Agent continues: same turn
        hub.setStatus(agentId, { state: "working", note: "Reading new messages" });
        return { ok: true, response: { decision: isAgy ? "continue" : "block", reason: queued } };
      }
      turnOpen.set(turnKey, false);
      hub.setStatus(agentId, { state: "idle", note: "Finished — ready for the next instruction" });
      hub.activity("agent.answered", agentId, `${name} finished a turn`);
      if (isAgy) return { ok: true, response: { decision: "stop" } };
      break;
    }
    case "SessionEnd":
      turnOpen.set(turnKey, false);
      hub.setStatus(agentId, { state: "idle", note: "Session ended" });
      break;
    default:
      return { ok: false };
  }
  return { ok: true };
}
