import { z } from "zod";

export const HumanActionType = z.enum([
  "product_scope_decision",
  "policy_escalation",
  "attempts_exhausted",
  "final_review",
]);
export type HumanActionType = z.infer<typeof HumanActionType>;

export const HumanActionStatus = z.enum(["open", "resolved"]);
export type HumanActionStatus = z.infer<typeof HumanActionStatus>;

export const HumanAction = z.object({
  id: z.string().uuid(),
  issueId: z.string().uuid(),
  /** Nullable for pre-start product_scope_decision and imported legacy actions. */
  workflowInstanceId: z.string().uuid().nullable(),
  actionType: HumanActionType,
  reason: z.string(),
  question: z.string(),
  evidenceJson: z.string().nullable(),
  responseOptionsJson: z.string().nullable(),
  continuationPreviewJson: z.string().nullable(),
  status: HumanActionStatus,
  resolutionJson: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  requestedAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type HumanAction = z.infer<typeof HumanAction>;
