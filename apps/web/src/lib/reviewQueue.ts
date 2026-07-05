import type { QueueSnapshot, Run, RunStatus } from "@agent-dealer/shared";

const PLAN_STATUSES: RunStatus[] = ["plan_pending", "queued"];
const RESULT_STATUSES: RunStatus[] = ["review", "failed"];

export function reviewQueueForRun(run: Run, snapshot: QueueSnapshot, view: "ops" | "intake" | "done" | "agents"): Run[] {
  if (PLAN_STATUSES.includes(run.status)) {
    return snapshot.awaitingPlanReview;
  }
  if (RESULT_STATUSES.includes(run.status)) {
    return snapshot.resultReviewRuns;
  }
  if (run.status === "done" && view === "done") {
    return snapshot.runs
      .filter((r) => r.status === "done")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  return [];
}

export function queueIndex(queue: Run[], runId: string): number {
  return queue.findIndex((r) => r.id === runId);
}

/** After an item leaves the queue, pick the next sibling at the same index (or last). */
export function nextInQueue(queue: Run[], currentId: string): Run | null {
  const idx = queueIndex(queue, currentId);
  if (idx < 0) return queue[0] ?? null;
  const remaining = queue.filter((r) => r.id !== currentId);
  if (remaining.length === 0) return null;
  return remaining[Math.min(idx, remaining.length - 1)] ?? null;
}
