import { z } from "zod";

export const HumanActionType = z.enum([
  "product_scope_decision",
  "policy_escalation",
  "attempts_exhausted",
  "final_review",
  /** Agent Deck returned a typed control-plane requirement (INTERACTION_REQUIRED) for a
   * mint/tool call under execution authority (NOT-87) — the worker was released rather
   * than left holding an in-flight call. */
  "deck_interaction_required",
  /** Agent Deck returned INTERACTION_REQUIRED while a completed issue's post-review
   * reflection tried to read/propose against a playbook under execution authority
   * (NOT-94) — parks that reflection attempt only. Deliberately distinct from
   * `deck_interaction_required`: reflection runs after the issue is already `done`, and
   * resolving this action never reopens the issue or enqueues developer/reviewer work,
   * unlike `deck_interaction_required`'s "resume" choice. */
  "reflection_interaction_required",
  /** Agent Deck returned INTERACTION_REQUIRED while minting or calling authority for an
   * approved outbound draft's delivery (NOT-95) — parks that delivery attempt only, on the
   * legacy Run model rather than an Issue (outbound drafts predate the issue/coordinator
   * kernel and never go through it). Resolved outside `resolveHumanActionOutcome` by
   * `resolveOutboundDeliveryAction`, same reasoning as `reflection_interaction_required`. */
  "outbound_delivery_interaction_required",
]);
export type HumanActionType = z.infer<typeof HumanActionType>;

export const HumanActionStatus = z.enum(["open", "resolved"]);
export type HumanActionStatus = z.infer<typeof HumanActionStatus>;

export const HumanAction = z.object({
  id: z.string().uuid(),
  /** Null for a Run-scoped action (`runId` set instead) — outbound-draft delivery parking
   * (NOT-95) has no Issue. Exactly one of issueId/runId is set. */
  issueId: z.string().uuid().nullable(),
  /** Null for an Issue-scoped action. See `issueId`. */
  runId: z.string().uuid().nullable(),
  /** Nullable for pre-start product_scope_decision and imported legacy actions. */
  workflowInstanceId: z.string().uuid().nullable(),
  actionType: HumanActionType,
  reason: z.string(),
  question: z.string(),
  evidenceJson: z.string().nullable(),
  responseOptionsJson: z.string().nullable(),
  continuationPreviewJson: z.string().nullable(),
  /** Agent Deck's own correlation id for the INTERACTION_REQUIRED response that raised
   * this action (deck_interaction_required / reflection_interaction_required only) —
   * null for every other action type and for one Deck raised without a correlation id
   * (NOT-93). */
  requestId: z.string().nullable(),
  status: HumanActionStatus,
  resolutionJson: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  requestedAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type HumanAction = z.infer<typeof HumanAction>;
