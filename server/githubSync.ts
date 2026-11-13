// Keeps the office's PRs in sync with what GitHubEvents reports, and runs the review automations:
// comments → tell the author; passed → tell the lead; merged → task done.

import type { PullRequest } from "../src/data/types";
import { branchAgent, OPEN_LIMIT, taskIdOf, toPullRequest } from "./github";
import { GhPolling, type GitHubEvent, type GitHubEvents, type GitHubWatch } from "./githubEvents";
import type { Hub } from "./hub";
import { log } from "./lib/log";
import type { Planner } from "./planner";

const MERGE_CMD = (n: number | string) => `gh pr merge ${n} --squash --delete-branch`;

/** What the lead is told when a PR passes review: merge it, or leave it to the user (Settings → Workflow → Merge). */
export function passedNotice(pr: Pick<PullRequest, "number" | "title">, author: string, by: "human" | "lead"): string {
  const head = `PR #${pr.number} (${pr.title}) by ${author} passed review.`;
  return by === "lead"
    ? `${head} You merge PRs on this project: run \`${MERGE_CMD(pr.number)}\` now. If GitHub refuses (conflicts or failing checks), ask the author to fix it instead. Then assign the next task if anything is waiting.`
    : `${head} It's ready for the user to merge. Don't merge it yourself.`;
}

/** With no review tool, "passed" only means the PR opened: the lead is the reviewer. */
export function unreviewedNotice(pr: Pick<PullRequest, "number" | "title">, author: string, by: "human" | "lead"): string {
  const head = `PR #${pr.number} (${pr.title}) by ${author} is open. No review tool runs on this project, so review it yourself (\`gh pr diff ${pr.number}\`). If it needs changes, tell ${author}.`;
  return by === "lead"
    ? `${head} If it's good, merge it: \`${MERGE_CMD(pr.number)}\`.`
    : `${head} If it's good, tell the user it's ready to merge. Don't merge it yourself.`;
}

/** What the lead is told when the user changes who merges, with the PRs already waiting. */
export function mergeByNotice(by: "human" | "lead", waiting: number[], reviewed = true): string {
  if (by === "human") return "The user changed the workflow: the user merges PRs now. Don't merge PRs yourself.";
  const prs = waiting.map((n) => `#${n}`).join(", ");
  if (!reviewed) {
    const list = waiting.length ? ` Open now: ${prs}. Review each (\`gh pr diff <number>\`), then merge with \`${MERGE_CMD("<number>")}\`.` : "";
    return `The user changed the workflow: no review tool runs, so you review PRs and merge the good ones.${list}`;
  }
  const list = waiting.length ? ` These passed review and are waiting: ${prs}. Merge each with \`${MERGE_CMD("<number>")}\`.` : "";
  return `The user changed the workflow: you now merge PRs once they pass review.${list}`;
}

const label = { coderabbit: "CodeRabbit", greptile: "Greptile", copilot: "Copilot", human: "The reviewer", custom: "The review check" } as const;

export class GitHubSync {
  private prev = new Map<number, PullRequest>();
  private first = true;
  private watch: GitHubWatch | null = null;
  private subscribed = false;
  private lastError: string | null = null;

  constructor(
    private hub: Hub,
    private planner: Planner,
    private repo: string | null,
    private events: GitHubEvents = new GhPolling(() => !!hub.snap.setup.checks.find((c) => c.id === "gh" && c.status === "ok")),
  ) {}

  start() {
    if (!this.repo) {
      log.warn("No GitHub remote: PRs and reviews are off.");
      return;
    }
    if (this.watch) return;
    this.watch = this.events.watch(this.repo, (e) => this.onEvent(e));
    if (this.subscribed) return;
    this.subscribed = true;
    // Check sooner when an agent finishes a turn (it may have run `gh pr create`)
    // or reports a PR with set_my_status in-review.
    let reviewCfg = JSON.stringify(this.hub.snap.config.workflow.review);
    this.hub.subscribe((e) => {
      // A review-settings change re-labels existing PRs; take a fresh baseline
      // instead of treating that as new review activity.
      if (e.type === "config.updated" && JSON.stringify(e.config.workflow.review) !== reviewCfg) {
        reviewCfg = JSON.stringify(e.config.workflow.review);
        this.first = true;
        this.nudge(500);
      }
      if (e.type === "activity" && e.event.type === "agent.answered") this.nudge();
      if (e.type === "task.updated" && e.task.status === "in-review") this.nudge(1500);
    });
  }

  stop() {
    this.watch?.stop();
    this.watch = null;
  }

  /** Look again soon: an agent just opened a PR or finished a turn. */
  nudge(delayMs = 3000) {
    this.watch?.nudge(delayMs);
  }

  /** What GitHub reported. Exported for tests: the source is the only other caller. */
  onEvent(e: GitHubEvent) {
    if (e.type === "rate-limited") {
      const at = e.until.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const msg = `GitHub API rate limit reached (shared with your agents' gh commands). PR sync paused until ${at}.`;
      if (msg !== this.lastError) {
        log.warn(msg);
        this.hub.activity("config", null, msg);
      }
      this.lastError = msg;
      return;
    }
    if (e.type === "error") {
      log.warn(`GitHub: ${e.message}`);
      this.lastError = e.message;
      return;
    }
    this.lastError = null;
    const { open, merged, closed } = e;
    const wf = this.hub.snap.config.workflow;
    const team = new Set(this.hub.snap.config.team.map((a) => a.id));
    const next = [...open, ...merged].map((gh) => {
      const taskId = taskIdOf(gh);
      const task = taskId ? this.planner.task(taskId) : undefined;
      const fromBranch = branchAgent(gh.headRefName);
      const authorId = task?.ownerId ?? (fromBranch && team.has(fromBranch) ? fromBranch : "");
      const pr = toPullRequest(gh, wf.review.tool, wf.review.enabled, task?.id ?? taskId ?? "", authorId);
      // Merged PRs come without files and checks: keep what was seen while it was open (the tests-ci gate reads it).
      // shortcut: a PR merged while HQ was down has no files seen; the owner waives tests-ci then. Fetch its files if that gets common.
      const was = this.prev.get(pr.number);
      return pr.testsChanged === undefined && was?.testsChanged !== undefined ? { ...pr, testsChanged: was.testsChanged, ciGreen: was.ciGreen } : pr;
    });
    // PRs we showed as open that are now neither open nor recently merged were closed. A full page of
    // open PRs may have left older ones out, so then only the recently-closed list proves it.
    const seen = new Set(next.map((p) => p.number));
    const complete = open.length < OPEN_LIMIT;
    const recentlyClosed = new Set(closed);
    for (const old of this.prev.values())
      if (!seen.has(old.number) && !old.merged && !old.closed) next.push(complete || recentlyClosed.has(old.number) ? { ...old, closed: true } : old);

    this.hub.snap.pullRequests = next;
    for (const pr of next) {
      const old = this.prev.get(pr.number);
      if (JSON.stringify(old) !== JSON.stringify(pr)) this.hub.emit({ type: "pr.updated", pr: { ...pr } });
      if (!this.first) this.react(old, pr);
      try {
        this.syncTask(pr);
      } catch (err) {
        log.warn(`GitHub: couldn't update ${pr.taskId}: ${err instanceof Error ? err.message : err}`);
      }
    }
    this.prev = new Map(next.map((p) => [p.number, p]));
    this.first = false;
  }

  /** Keep the task board in line with its PR. */
  private syncTask(pr: PullRequest) {
    const task = pr.taskId ? this.planner.task(pr.taskId) : undefined;
    if (!task || pr.closed || !this.hub.snap.config.template) return; // a read-only project's board never changes
    if (pr.merged && task.status !== "done") this.planner.updateTask(task.id, { status: "done", prNumber: pr.number }, "github");
    else if (!pr.merged && (task.status === "todo" || task.status === "in-progress")) this.planner.updateTask(task.id, { status: "in-review", prNumber: pr.number });
    else if (!pr.merged && task.prNumber !== pr.number) this.planner.updateTask(task.id, { prNumber: pr.number });
  }

  private react(old: PullRequest | undefined, pr: PullRequest) {
    const hub = this.hub;
    const who = pr.authorId || null;
    const tool = label[hub.snap.config.workflow.review.tool];
    const lead = hub.snap.config.team.find((a) => a.isLead);
    const ref = `#${pr.number} ${pr.title}`;

    if (!old && !pr.merged && !pr.closed) hub.activity("pr.opened", who, `${hub.name(who)} opened PR ${ref}`);
    if (pr.closed && !old?.closed) return hub.activity("config", who, `PR #${pr.number} was closed without merging`);

    if (pr.merged && !old?.merged) {
      hub.activity("pr.merged", null, `PR ${ref} was merged`);
      if (lead) this.planner.notify(lead.id, `PR #${pr.number} (${pr.title}) was merged${pr.taskId ? `; ${pr.taskId} is done` : ""}. Assign the next task if anything is waiting.`);
      return;
    }
    if (pr.merged) return;

    if (pr.review === "reviewing" && old?.review !== "reviewing") hub.activity("review.started", null, `${tool} is reviewing #${pr.number}`);

    const newComments = pr.review === "changes-requested" && (old?.review !== "changes-requested" || pr.openComments > (old?.openComments ?? 0));
    if (newComments) {
      const n = pr.openComments;
      hub.activity("review.changes", who, `${tool} left ${n || "new"} comment${n === 1 ? "" : "s"} on #${pr.number}`);
      if (who)
        this.planner.notify(
          who,
          `${tool} reviewed your PR #${pr.number} (${pr.title}) and left ${n || "new"} open comment${n === 1 ? "" : "s"}. ` +
            `Read them with \`gh pr view ${pr.number} --comments\` (or the GitHub API), fix them on the same branch, push, and resolve each thread you fixed.`,
        );
    }

    if (pr.review === "passed" && old?.review !== "passed") {
      const reviewed = hub.snap.config.workflow.review.enabled;
      const by = hub.snap.config.workflow.merge.by;
      hub.activity("review.passed", who, reviewed ? `${tool} approved #${pr.number}` : `${hub.name(who)} opened #${pr.number}`);
      if (lead) this.planner.notify(lead.id, reviewed ? passedNotice(pr, hub.name(who), by) : unreviewedNotice(pr, hub.name(who), by));
    }

    if (pr.conflict && !old?.conflict && who)
      this.planner.notify(who, `Your PR #${pr.number} has merge conflicts with main. Pull main, rebase or merge it into your branch, fix the conflicts, and push.`);
  }
}
