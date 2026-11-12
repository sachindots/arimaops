// Turns snapshot changes into one-off office moments: the team huddles when the
// lead plans, cheers on a merge or release, paper planes for messages, a PR
// parcel flying to the lead, and SOC flashes for findings and scope refusals.
// Pure (no Pixi) so scripts/office-test.ts can drive it. The first snapshot
// only seeds what has been seen: history never replays.

import type { OfficeSnapshot, Severity } from "../../data/types";

export type IsoEvent =
  | { kind: "huddle" }
  | { kind: "cheer"; agentId: string | null; label: string }
  | { kind: "plane"; from: string; to: string; chat: boolean }
  | { kind: "parcel"; from: string; num: number }
  | { kind: "finding"; id: string; severity: Severity; agentId: string }
  | { kind: "refused"; agentId: string | null }
  | { kind: "report" };

const REPORT_TASK = /report/i;

export class EventDiff {
  private first = true;
  private activity = new Set<string>();
  private messages = new Set<string>();
  private prs = new Set<number>();
  private findings = new Set<string>();
  private doneTasks = new Set<string>();

  reset() {
    this.first = true;
    for (const s of [this.activity, this.messages, this.prs, this.findings, this.doneTasks]) s.clear();
  }

  next(snap: OfficeSnapshot): IsoEvent[] {
    const out: IsoEvent[] = [];
    const team = new Set(snap.config.team.map((a) => a.id));
    const lead = snap.config.team.find((a) => a.isLead)?.id;
    const fresh = <T>(seen: Set<T>, key: T) => !seen.has(key) && (seen.add(key), !this.first);

    let planned = false;
    for (const ev of [...snap.activity].reverse()) {
      if (!fresh(this.activity, ev.id)) continue;
      if (ev.type === "task.created" || (ev.type === "task.assigned" && ev.agentId !== null && ev.agentId === lead)) planned = true;
      else if (ev.type === "pr.merged") out.push({ kind: "cheer", agentId: ev.agentId, label: "MERGED" });
      else if (ev.type === "deploy") out.push({ kind: "cheer", agentId: ev.agentId, label: "SHIPPED" });
      else if (ev.type === "scope.refused") out.push({ kind: "refused", agentId: ev.agentId });
    }
    if (planned) out.unshift({ kind: "huddle" }); // a burst of new tasks is one planning moment

    for (const m of [...snap.messages].reverse()) {
      if (!fresh(this.messages, m.id)) continue;
      if (m.fromId !== m.toId && team.has(m.fromId) && team.has(m.toId)) out.push({ kind: "plane", from: m.fromId, to: m.toId, chat: m.fromId !== lead && m.toId !== lead });
    }
    for (const pr of snap.pullRequests) {
      if (fresh(this.prs, pr.number) && !pr.merged && !pr.closed && team.has(pr.authorId) && pr.authorId !== lead) out.push({ kind: "parcel", from: pr.authorId, num: pr.number });
    }
    for (const f of snap.findings ?? []) {
      if (fresh(this.findings, f.id)) out.push({ kind: "finding", id: f.id, severity: f.severity, agentId: f.reporterId });
    }
    for (const t of snap.tasks) {
      if (t.status === "done" && REPORT_TASK.test(t.title) && fresh(this.doneTasks, t.id) && snap.config.rules.findings) out.push({ kind: "report" });
    }
    this.first = false;
    return out;
  }
}

export const SEVERITY_COLOR: Record<Severity, string> = {
  critical: "#ff3b3b",
  high: "#ff8a3d",
  medium: "#F59E0B",
  low: "#22D3EE",
  info: "#8A97B0",
};
