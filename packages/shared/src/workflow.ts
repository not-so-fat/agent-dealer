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
  "pull_request.opened",
  "pull_request.updated",
  "checks.completed",
  "review.submitted",
  "repair.started",
  "guidance.added",
  "human_action.requested",
  "human_action.resolved",
  "final_review.requested",
  "issue.completed",
  "issue.closed",
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
