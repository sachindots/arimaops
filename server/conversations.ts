// Questions and disagreements between agents (send_message kind "question" / "disagree"). A question nobody answers
// goes to the lead once; two disagreements between the same pair on one task go to the lead to decide (or to the
// owner, when the lead is one of the two). Each is sent up once.

import type { AgentMessage } from "../src/data/types";

export interface ConversationCtx {
  snap: { messages: AgentMessage[]; config: { team: { id: string; isLead: boolean }[] } };
  name(id: string): string;
  /** Message ids and task:pair keys already sent up. */
  escalated: Set<string>;
  notify(agentId: string, text: string): void;
  toOwner(text: string): void;
}

export function escalateDisagreement(c: ConversationCtx, a: string, b: string, taskId: string | undefined, now = Date.now()) {
  if (!taskId) return;
  const pair = [a, b].sort().join("+");
  const key = `${taskId}:${pair}`;
  const recent = c.snap.messages.filter(
    (m) => m.kind === "disagree" && m.taskId === taskId && [m.fromId, m.toId].sort().join("+") === pair && Date.parse(m.at) >= now - 3_600_000,
  );
  if (recent.length < 2 || c.escalated.has(key)) return;
  c.escalated.add(key);
  const points = recent.slice(0, 2).reverse().map((m) => `${c.name(m.fromId)}: ${m.text.slice(0, 300)}`).join("\n");
  const lead = c.snap.config.team.find((x) => x.isLead);
  const text = `${c.name(a)} and ${c.name(b)} disagree on ${taskId}.\n${points}`;
  if (lead && lead.id !== a && lead.id !== b)
    c.notify(lead.id, `${text}\nDecide, tell both with send_message, and record it with remember (type Decision, about the task's files).`);
  else c.toOwner(`${text}\nThe lead is one of them, so this is yours to decide: reply in either thread.`);
}

/** A question between agents unanswered for `afterMs` goes to the lead once (not when the lead was the one asked). */
export function checkQuestions(c: ConversationCtx, now: number, afterMs = 15 * 60_000) {
  const lead = c.snap.config.team.find((x) => x.isLead);
  if (!lead) return;
  for (const q of c.snap.messages) {
    if (q.kind !== "question" || c.escalated.has(q.id) || q.toId === lead.id || now - Date.parse(q.at) < afterMs) continue;
    c.escalated.add(q.id);
    const answered = c.snap.messages.some((m) => m.fromId === q.toId && m.toId === q.fromId && Date.parse(m.at) > Date.parse(q.at));
    if (!answered)
      c.notify(
        lead.id,
        `${c.name(q.fromId)} asked ${c.name(q.toId)} ${Math.round((now - Date.parse(q.at)) / 60_000)} min ago and has no answer${q.taskId ? ` (${q.taskId})` : ""}: "${q.text.slice(0, 300)}". Answer it, or point them to someone who can.`,
      );
  }
}
