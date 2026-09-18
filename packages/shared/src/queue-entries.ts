import { z } from "zod";
import type { WorkflowInstance } from "./workflow.js";

export const QueueEntryState = z.enum(["queued", "admitted", "removed"]);
export type QueueEntryState = z.infer<typeof QueueEntryState>;

export const QueueEntry = z.object({
  id: z.string().uuid(),
  issueId: z.string().uuid(),
  position: z.number().int(),
  enqueuedAt: z.string(),
  state: QueueEntryState,
  waitReason: z.string().nullable(),
  waitReasonAt: z.string().nullable(),
});
export type QueueEntry = z.infer<typeof QueueEntry>;

/** Enriched row for GET /api/queue — includes issue title for UI/CLI. */
export const QueueEntryView = QueueEntry.extend({
  title: z.string().optional(),
  issueStatus: z.string().optional(),
});
export type QueueEntryView = z.infer<typeof QueueEntryView>;

export const EnqueueIssueInput = z.object({
  issueId: z.string().uuid(),
});
export type EnqueueIssueInput = z.infer<typeof EnqueueIssueInput>;

/**
 * NOT-112: relative reorder only — no arbitrary integer positions. Server computes ranks.
 * `before` / `after` name another queued issue; a concurrent admission of that reference
 * yields 409 rather than a corrupted order.
 */
export const QueueMoveTarget = z.union([
  z.literal("top"),
  z.literal("bottom"),
  z.object({ before: z.string().uuid() }).strict(),
  z.object({ after: z.string().uuid() }).strict(),
]);
export type QueueMoveTarget = z.infer<typeof QueueMoveTarget>;

export const MoveQueueEntryInput = z.object({
  to: QueueMoveTarget,
});
export type MoveQueueEntryInput = z.infer<typeof MoveQueueEntryInput>;

/**
 * NOT-118 `POST /api/issues/:id/start` response. Start has no queue bypass: it moves the
 * issue to the front and admits it when a slot is free, otherwise it waits at the top with
 * a reason. `workItem` is the round-1 developer item the admitted start enqueued.
 */
export type StartIssueResponse =
  | {
      state: "admitted";
      instance: WorkflowInstance;
      workItem: { id: string; kind: string };
    }
  | { state: "queued"; position: number; waitReason: string | null };
