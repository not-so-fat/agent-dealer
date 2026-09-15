import { z } from "zod";

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
