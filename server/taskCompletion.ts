import type { PullRequest, Task, WorkflowConfig } from "../src/data/types";

/** Shared by live tasks and offline project edits: a success claim must not release dependencies. */
export function assertTaskCompletion(task: Task, workflow: WorkflowConfig, prs: PullRequest[], reviewerId: string) {
  if (task.status !== "done") return;
  if (workflow.mode !== "deliverables") {
    if (!prs.some((p) => p.number === task.prNumber && p.taskId === task.id && p.merged))
      throw new Error("Code tasks finish only after their linked PR is merged. Submit in-review first.");
    return;
  }
  if (!task.doneWhen?.trim()) throw new Error("Add acceptance criteria before completing this task.");
  if (!task.note?.trim() || !task.deliverablePath?.trim())
    throw new Error("Completion needs a verification summary in note and a deliverablePath. Submit in-review first.");
  if (workflow.review.enabled && (!reviewerId || reviewerId === task.ownerId))
    throw new Error("A different reviewer must accept the deliverable. Submit in-review for the lead or user.");
}
