import { z } from "zod";

export const WorkflowInstanceOutcome = z.enum(["done", "closed", "migrated"]);
export type WorkflowInstanceOutcome = z.infer<typeof WorkflowInstanceOutcome>;

export const WorkflowInstance = z.object({
  id: z.string().uuid(),
  issueId: z.string().uuid(),
  workflowVersion: z.string(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  outcome: WorkflowInstanceOutcome.nullable(),
});
export type WorkflowInstance = z.infer<typeof WorkflowInstance>;

export const WorkflowEventType = z.enum([
  "issue.created",
  "workflow.started",
  "worker.started",
  "worker.completed",
  "worker.failed",
  "worker.deferred",
  /** Mid-session milestones (NOT-109) — low volume, not per-tool-call. */
  "worktree.ready",
  "deck.connected",
  "brief.resolved",
  "branch.pushed",
  "checks.started",
  "pull_request.opened",
  "pull_request.updated",
  "checks.completed",
  "review.submitted",
  "repair.started",
  "guidance.added",
  /** A retry after an `attempts_exhausted` park re-froze the task snapshot (NOT-185). */
  "task_snapshot.refreshed",
  "human_action.requested",
  "human_action.resolved",
  "final_review.requested",
  "issue.completed",
  "issue.closed",
  /** NOT-168: durable queue/admission wait evidence. Emitted transactionally with the
   * queue_entries mutation they describe; see EXECUTION_ANALYSIS.md §2/§6. */
  "queue.enqueued",
  "queue.wait_reason_changed",
  "queue.admitted",
  "queue.removed",
  /** Migration-only — the NOT-66 cutover repoints a legacy `events` row under this type,
   * preserving the original type/payload inside `payloadJson` (see `role: "legacy"` on
   * `WorkerSessionRole` and `outcome: "migrated"` on `WorkflowInstanceOutcome` for the same
   * migration-sentinel pattern). The new coordinator never emits it. */
  "legacy.imported",
]);
export type WorkflowEventType = z.infer<typeof WorkflowEventType>;

export const WorkflowEvent = z.object({
  id: z.string().uuid(),
  issueId: z.string().uuid(),
  /** Nullable only for issue creation/guidance emitted before any workflow starts. */
  workflowInstanceId: z.string().uuid().nullable(),
  workerSessionId: z.string().uuid().nullable(),
  type: WorkflowEventType,
  actorType: z.enum(["human", "developer", "reviewer", "system"]),
  actorRef: z.string().nullable(),
  /** Issue status at emit time — lets the timeline render without re-deriving state. */
  stage: z.string(),
  round: z.number().int().nullable(),
  payloadJson: z.string().nullable(),
  artifactRef: z.string().nullable(),
  /** Provider-native key (e.g. GitHub delivery id) for idempotent re-ingestion. */
  idempotencyKey: z.string().nullable(),
  causationEventId: z.string().uuid().nullable(),
  ts: z.string(),
});
export type WorkflowEvent = z.infer<typeof WorkflowEvent>;
