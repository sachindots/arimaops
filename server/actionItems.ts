// Action items: things an agent needs the user to do outside its sandbox
// (create a database, put a key in an env file, change a dashboard setting).
// Agents add them with the Team MCP tool `ask_user`; the user closes them in HQ,
// and HQ tells the agent so it can continue. Kept on this Mac, never committed.

import { join } from "node:path";
import type { Memory } from "../src/data/model";
import type { ActionItem, PendingMemory } from "../src/data/types";
import type { Hub } from "./hub";
import { projectHome } from "./paths";
import type { Planner } from "./planner";
import { readDoc, writeDoc } from "./lib/docs";

const KEEP_CLOSED = 100;

export class ActionItems {
  private file: string;
  private seq = 0;

  constructor(private hub: Hub, private planner: Planner) {
    this.file = join(projectHome(hub.slug), "action-items.json");
    let saved: ActionItem[] | null = null;
    try { saved = readDoc<ActionItem[]>(this.file); } catch { /* unreadable: start empty, as before */ }
    hub.snap.actionItems = Array.isArray(saved) ? saved : [];
  }

  private get items(): ActionItem[] {
    return (this.hub.snap.actionItems ??= []);
  }

  private save() {
    const open = this.items.filter((i) => i.status === "open");
    const closed = this.items.filter((i) => i.status !== "open").slice(0, KEEP_CLOSED);
    this.hub.snap.actionItems = [...open, ...closed].sort((a, b) => b.at.localeCompare(a.at));
    writeDoc(this.file, this.hub.snap.actionItems);
  }

  add(fromId: string, title: string, details: string, waiting: boolean, kind: "request" | "plan" = "request"): ActionItem {
    const clean = title.trim().replace(/\s+/g, " ").slice(0, 160);
    if (!clean) throw new Error("Give the action item a short title.");
    const item: ActionItem = {
      id: `ai${Date.now().toString(36)}${++this.seq}`,
      fromId,
      taskId: this.planner.currentTask(fromId)?.id ?? null,
      title: clean,
      details: details.trim().slice(0, 4000),
      waiting,
      kind,
      status: "open",
      note: null,
      at: new Date().toISOString(),
      closedAt: null,
    };
    this.items.unshift(item);
    this.save();
    this.hub.emit({ type: "action.updated", item: { ...item } });
    this.hub.activity("agent.needs-input", fromId, `${this.hub.name(fromId)} added an action item${waiting ? " (waiting)" : ""}: ${clean}`);
    const lead = this.hub.snap.config.team.find((a) => a.isLead);
    if (lead && lead.id !== fromId && kind === "request") // plans need the user's own approval
      this.planner.notify(lead.id, `${this.hub.name(fromId)} asked the user: "${clean}". If it's something you can decide, answer ${this.hub.name(fromId)} yourself (send_message); only the user can create accounts, keys or settings.`);
    return item;
  }

  resolve(id: string, decision: "done" | "dismissed", note?: string) {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.status !== "open") return;
    item.status = decision;
    item.note = note?.trim().slice(0, 1000) || null;
    item.closedAt = new Date().toISOString();
    this.save();
    this.hub.emit({ type: "action.updated", item: { ...item } });
    if (item.kind === "memory") return; // dismissed memories stay uncertified and fade; no agent to tell
    if (item.kind === "approval") {
      if (decision === "dismissed" && item.taskId && item.approval) this.planner.undoLeadApproval(item.taskId, item.approval.gateId, item.approval.stageId, item.note ?? undefined);
      else if (decision === "done") this.planner.notify(item.fromId, `The owner kept your approval: ${item.title}.`);
      return;
    }
    const n = item.note ? ` Note from the user: ${item.note}` : "";
    if (item.kind === "plan") {
      if (decision === "done") this.planner.notify(item.fromId, `The user APPROVED your plan "${item.title}".${n} Go ahead and execute it, exactly as planned.`);
      else this.planner.notify(item.fromId, `The user REJECTED your plan "${item.title}".${n} Don't execute it. Revise the plan and submit_plan again, or ask the lead.`);
      return;
    }
    if (decision === "done") this.planner.notify(item.fromId, `The user did your action item "${item.title}".${n} Continue with it.`);
    else this.planner.notify(item.fromId, `The user dismissed your action item "${item.title}".${n} Continue without it, or find another way.`);
  }

  /** The lead passed a person gate for the away owner (docs/agent-engine.md section 4): Keep or Undo. */
  addApproval(leadId: string, taskId: string, taskTitle: string, gateId: string, stageId: string, note: string): ActionItem {
    const item: ActionItem = {
      id: `ai${Date.now().toString(36)}${++this.seq}`,
      fromId: leadId,
      taskId,
      title: `${this.hub.name(leadId)} approved ${gateId} on ${taskId} while you were away`,
      details: `${taskTitle}${note ? `\n\n${this.hub.name(leadId)}'s note: ${note.slice(0, 1000)}` : ""}\n\nKeep it, or Undo: the gate waits for you again and the task goes back to that stage.`,
      waiting: false,
      kind: "approval",
      approval: { gateId, stageId },
      status: "open",
      note: null,
      at: new Date().toISOString(),
      closedAt: null,
    };
    this.items.unshift(item);
    this.save();
    this.hub.emit({ type: "action.updated", item: { ...item } });
    return item;
  }

  // ---------------------------------------------------------------- memories to check (docs/memory-core.md section 8)

  private memoryItems(): ActionItem[] {
    return this.items.filter((i) => i.kind === "memory" && i.status === "open");
  }

  /** Memories still waiting for a check, across this project's items. */
  pendingMemories(): number {
    return this.memoryItems().reduce((n, i) => n + (i.memories?.length ?? 0), 0);
  }

  private retitle(item: ActionItem) {
    const n = item.memories?.length ?? 0;
    item.title = `${n} memor${n === 1 ? "y" : "ies"} from ${item.taskId ?? "the project"} to check`;
  }

  /** Files a new memory under its task's open item (one item per task). */
  addMemory(m: Pick<Memory, "id" | "type" | "text" | "about" | "taskId">) {
    if (this.memoryItems().some((i) => i.memories?.some((p) => p.id === m.id))) return;
    let item = this.memoryItems().find((i) => i.taskId === m.taskId);
    if (!item) {
      item = {
        id: `ai${Date.now().toString(36)}${++this.seq}`,
        fromId: "hq",
        taskId: m.taskId,
        title: "",
        details: "What the team learned. Certify what is right (it ranks first in briefs and never fades); reject what is wrong (it is deleted). Unchecked memories fade after 30 days unused.",
        waiting: false,
        kind: "memory",
        memories: [],
        status: "open",
        note: null,
        at: new Date().toISOString(),
        closedAt: null,
      };
      this.items.unshift(item);
    }
    item.memories!.push({ id: m.id, type: m.type, text: m.text, about: m.about, conflict: null });
    this.retitle(item);
    this.save();
    this.hub.emit({ type: "action.updated", item: { ...item } });
  }

  /** Marks a pending memory that may contradict a certified one. Returns false when it isn't pending any more. */
  setConflict(memoryId: string, conflict: { id: string; text: string }): boolean {
    const item = this.memoryItems().find((i) => i.memories?.some((p) => p.id === memoryId));
    const pending = item?.memories?.find((p) => p.id === memoryId);
    if (!item || !pending) return false;
    pending.conflict = conflict;
    this.save();
    this.hub.emit({ type: "action.updated", item: { ...item } });
    return true;
  }

  /** The user's check on some of an item's memories. Returns the ids to certify and to reject; closes the item when none are left. */
  decideMemories(itemId: string, decisions: Record<string, "certify" | "reject">): { certify: string[]; reject: string[] } {
    const item = this.memoryItems().find((i) => i.id === itemId);
    if (!item) throw new Error("Those memories were already checked.");
    const out = { certify: [] as string[], reject: [] as string[] };
    for (const p of item.memories ?? []) {
      const d = decisions[p.id];
      if (d === "certify" || d === "reject") out[d].push(p.id);
    }
    const decided = new Set([...out.certify, ...out.reject]);
    item.memories = (item.memories ?? []).filter((p) => !decided.has(p.id));
    const tally = item.note?.match(/^(\d+) certified, (\d+) rejected$/);
    const [c, r] = tally ? [Number(tally[1]), Number(tally[2])] : [0, 0];
    item.note = `${c + out.certify.length} certified, ${r + out.reject.length} rejected`;
    if (item.memories.length) this.retitle(item);
    else (item.status = "done"), (item.closedAt = new Date().toISOString());
    this.save();
    this.hub.emit({ type: "action.updated", item: { ...item } });
    return out;
  }

  /** Brings the open items in line with the graph's uncertified memories: adds missing ones, drops merged, faded or deleted ones. */
  syncMemories(uncertified: Pick<Memory, "id" | "type" | "text" | "about" | "taskId">[]) {
    const live = new Set(uncertified.map((m) => m.id));
    for (const item of this.memoryItems()) {
      const before = item.memories?.length ?? 0;
      item.memories = (item.memories ?? []).filter((p: PendingMemory) => live.has(p.id));
      if (item.memories.length === before) continue;
      if (item.memories.length) this.retitle(item);
      else (item.status = "dismissed"), (item.closedAt = new Date().toISOString()), (item.note = "Merged or faded before it was checked.");
      this.save();
      this.hub.emit({ type: "action.updated", item: { ...item } });
    }
    for (const m of uncertified) this.addMemory(m);
  }
}
