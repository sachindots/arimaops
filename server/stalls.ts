// SPDX-License-Identifier: AGPL-3.0-or-later
// Stall detection and progress-ledger escalation (docs/agent-engine.md section 4).
// Extracted from server/planner.ts to keep the planner focused on boards, tasks and assignments.

import type { Task } from "../src/data/types";
import type { Hub } from "./hub";
import type { Inbox } from "./inbox";
import type { MemoryStore } from "./memory";

export interface StallCheckContext {
  hub: Hub;
  inbox: Inbox;
  memory: MemoryStore | null;
  stallNudged: Set<string>;
  lastActivityAt: (agentId: string) => number;
  currentTask: (agentId: string) => Task | undefined;
  task: (taskId: string) => Task | undefined;
  notify: (agentId: string, text: string) => void;
}

/**
 * HQ's progress ledger: each stall it saw. The second stall on a task asks the lead to replan it; from the third
 * the owner is pushed (docs/agent-engine.md section 4).
 */
function recordStallProgress(ctx: StallCheckContext, taskId: string, text: string) {
  const projectId = ctx.hub.snap.config.project.id;
  try {
    ctx.memory?.addLedger({ projectId, taskId, ledger: "progress", kind: "stall", text, by: "hq" });
    const stalls = ctx.memory?.ledger(projectId, { taskId, ledger: "progress" }).filter((e) => e.kind === "stall" && !e.supersededBy).length ?? 0;
    const lead = ctx.hub.snap.config.team.find((a) => a.isLead);
    const task = ctx.task(taskId);
    if (stalls === 2 && lead) {
      ctx.memory?.addLedger({ projectId, taskId, ledger: "progress", kind: "replan", text: `Stalled twice; asked ${lead.name} to replan`, by: "hq" });
      ctx.notify(lead.id, `${taskId}${task ? ` (${task.title})` : ""} has stalled twice (latest: ${text}). Replan it: split it, reassign it, or drop it, and record the new plan with ledger_add kind plan.`);
    } else if (stalls >= 3) {
      ctx.hub.activity("agent.needs-input", lead?.id ?? null, `${taskId} has stalled ${stalls} times, after the lead's replan. It needs you.`);
    }
  } catch {
    /* the ledger is a record, never a reason to stop a stall check */
  }
}

/**
 * A worker that ended its turn with its task still in progress, and has sat idle since, is waiting on something
 * that won't wake it (a background job, a question it never sent). Nudge it once and tell the lead.
 */
export function runStallCheck(
  ctx: StallCheckContext,
  now: number,
  idleMs = 5 * 60_000,
  silentMs = 15 * 60_000,
  unansweredMs = 30 * 60_000,
) {
  const snap = ctx.hub.snap;
  const lead = snap.config.team.find((a) => a.isLead);
  // The user is away: hand questions they haven't answered to the lead (plans still wait for the user).
  for (const item of snap.actionItems ?? []) {
    if (!lead || item.status !== "open" || item.kind === "plan" || now - Date.parse(item.at) < unansweredMs) continue;
    const key = `ask:${item.id}`;
    if (ctx.stallNudged.has(key)) continue;
    ctx.stallNudged.add(key);
    const who = item.fromId === lead.id ? "You" : ctx.hub.name(item.fromId);
    ctx.notify(lead.id, `The user hasn't answered "${item.title}" (from ${who}) for ${Math.round((now - Date.parse(item.at)) / 60_000)} min. If it's a reversible decision, make it, tell ${item.fromId === lead.id ? "the team" : who}, and tell the user what you decided. If only the user can do it, keep the team on other work.`);
  }
  for (const a of snap.config.team) {
    const st = ctx.hub.status(a.id);
    const task = ctx.currentTask(a.id);
    if (a.isLead || !st || !task || task.status !== "in-progress" || st.session.state !== "running") continue;
    if (st.limitedUntil && Date.parse(st.limitedUntil) > now) continue; // the usage-limit notice covers this
    const key = `${a.id}:${task.id}`;
    // "Working" but no hook for a long time: frozen, or one command hanging. Typing into it would interrupt, so tell the lead.
    const quietMs = now - Math.max(ctx.lastActivityAt(a.id), Date.parse(st.stateSince));
    if (ctx.stallNudged.has(key)) {
      if (st.state === "working" && quietMs < silentMs) ctx.stallNudged.delete(key); // moving again: a later stall counts anew
      continue;
    }
    if (st.state === "working" && quietMs >= silentMs) {
      ctx.stallNudged.add(key);
      const mins = Math.round(quietMs / 60_000);
      if (lead) ctx.notify(lead.id, `${a.name} shows Working on ${task.id} but has done nothing visible for ${mins} min (a command may be hanging). Check its terminal in HQ, or ask the user to.`);
      recordStallProgress(ctx, task.id, `${a.name} silent ${mins} min while working`);
      ctx.hub.activity("agent.needs-input", a.id, `${a.name} silent for ${mins} min while working on ${task.id}`);
      continue;
    }
    if (st.state !== "idle" || now - Date.parse(st.stateSince) < idleMs || ctx.inbox.pending(a.id) > 0) continue;
    ctx.stallNudged.add(key);
    const mins = Math.round((now - Date.parse(st.stateSince)) / 60_000);
    ctx.notify(a.id, `HQ: you've been idle ${mins} min but ${task.id} is still in progress. If you were waiting on a background command or job, it won't wake you: check it now and continue in the foreground. If you're blocked, call set_my_status blocked with the reason.`);
    if (lead) ctx.notify(lead.id, `${a.name} has been idle ${mins} min with ${task.id} still in progress. HQ nudged it; check on it if it doesn't move.`);
    recordStallProgress(ctx, task.id, `${a.name} idle ${mins} min with the task in progress; nudged`);
    ctx.hub.activity("agent.needs-input", a.id, `${a.name} stalled on ${task.id} (idle ${mins} min)`);
  }
}
