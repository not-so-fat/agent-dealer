import type { HumanActionType } from "@agent-dealer/shared";

export type HumanResolution =
  | { actionType: "final_review"; choice: "complete" | "merge" | "repair" | "close" }
  | { actionType: "attempts_exhausted"; choice: "retry" | "close" }
  // NOT-194: a merge failure after approval is a policy_escalation whose evidence carries
  // `mergeFailure: true`. It offers retry_merge/repair/close (never resume — the work is
  // approved, nothing needs developing). Legacy merge-failure actions created before NOT-194
  // carry no such evidence and still resolve through resume.
  | { actionType: "policy_escalation"; choice: "resume" | "retry_merge" | "repair" | "close" }
  | { actionType: "product_scope_decision"; choice: "resume"; note?: string }
  | { actionType: "deck_interaction_required"; choice: "resume" | "close" };

/**
 * NOT-194: the stored response options for a merge-failure policy_escalation. Shared by
 * auto-merge.ts (which raises it) and commands.ts's responseOptionsFor merge-failure
 * variant so the two can never drift apart.
 */
export const MERGE_FAILURE_RESPONSE_OPTIONS: Array<{ choice: string; label: string }> = [
  { choice: "retry_merge", label: "Retry merge" },
  { choice: "repair", label: "Another repair round" },
  { choice: "close", label: "Close" },
];

/** Evidence key marking a policy_escalation as a NOT-194 merge failure. */
export const MERGE_FAILURE_EVIDENCE_KEY = "mergeFailure";

export interface HumanResolutionResult {
  issueStatus: "done" | "repairing" | "closed" | "developing";
  workflowOutcome?: "done" | "closed";
  startNewRound?: boolean;
  /**
   * Which budget resuming spends, when startNewRound is set:
   * "review" bumps current_round only (final_review:repair — a genuine repair cycle);
   * "review_grant" bumps current_round AND max_review_rounds (attempts_exhausted:retry —
   * a retry must grant one more round or the very next changes_requested re-exhausts);
   * "infra" resets infra_attempts to 0, no round change (policy_escalation:resume — an
   * infra hiccup, not a review-round spend);
   * "none" touches neither (product_scope_decision — just unblocks a paused workflow).
   */
  roundKind?: "review" | "review_grant" | "infra" | "none";
  triggerReflect?: boolean;
}

/**
 * The only choices resolveHumanActionOutcome accepts per action type — the stored "response
 * options." `reflection_interaction_required` and `outbound_delivery_interaction_required`
 * are listed here only so this map stays total over `HumanActionType`; neither is ever
 * routed through `resolveHumanActionOutcome` (NOT-94's reflect-trigger.ts and NOT-95's
 * `resolveOutboundDeliveryAction` resolve them directly — the former runs after the issue is
 * already `done`, the latter is Run-scoped with no issue/workflow at all; both must never
 * reopen an issue or enqueue developer/reviewer work).
 */
const VALID_CHOICES: Record<HumanActionType, readonly string[]> = {
  // "complete" kept as a synonym for "merge" so older open actions / CLI callers still resolve.
  final_review: ["merge", "complete", "repair", "close"],
  attempts_exhausted: ["retry", "close"],
  // "resume" stays valid so pre-NOT-194 open merge-failure actions still resolve;
  // commands.ts narrows per-action (merge-failure evidence → retry_merge/repair/close only,
  // everything else → resume/close only).
  policy_escalation: ["resume", "retry_merge", "repair", "close"],
  product_scope_decision: ["resume"],
  deck_interaction_required: ["resume", "close"],
  reflection_interaction_required: ["retry", "dismiss"],
  outbound_delivery_interaction_required: ["retry_send", "reject"],
};

/**
 * Validates a raw (actionType, choice) pair against that action type's allowed response
 * options before it's ever treated as a typed HumanResolution. Returns null for anything
 * not in the allowed set — callers must reject the request rather than guess at intent.
 *
 * `reflection_interaction_required` is deliberately rejected here even though
 * `VALID_CHOICES` lists it (PR #21 review): it has no corresponding `HumanResolution`
 * variant, so casting it through would be a type lie, and its only legal resolver is
 * `resolveReflectionInteractionAction` (reflect-trigger.ts), never `resolveHumanActionOutcome`.
 * `outbound_delivery_interaction_required` is rejected for the same reason (NOT-95): it is
 * Run-scoped, has no Issue/workflow_instance to advance, and its only legal resolver is
 * `resolveOutboundDeliveryAction` (queue/approve-deliver.ts).
 */
export function parseHumanResolution(actionType: string, choice: string): HumanResolution | null {
  if (actionType === "reflection_interaction_required" || actionType === "outbound_delivery_interaction_required") {
    return null;
  }
  if (!(actionType in VALID_CHOICES)) return null;
  if (!VALID_CHOICES[actionType as HumanActionType].includes(choice)) return null;
  return { actionType, choice } as HumanResolution;
}

/**
 * Implements PRD §6.3's human pass-the-ball outcomes: continue, repair, complete, or close.
 * v1 (open decision #2 in the spec) treats every "resume/retry/repair" choice as starting
 * another round rather than distinguishing a true resume from a fresh repair round.
 *
 * Every branch is explicit — an unrecognized choice throws rather than silently falling
 * through to "close" (the previous shape's `? X : close` ternaries meant any typo or bad
 * input silently closed the issue). Callers should validate with parseHumanResolution
 * first, making these throws unreachable in practice; they exist as defense in depth.
 */
export function resolveHumanActionOutcome(resolution: HumanResolution): HumanResolutionResult {
  switch (resolution.actionType) {
    case "final_review":
      // Merge (and legacy "complete") undraft+merge via commands.ts, then mark done.
      if (resolution.choice === "merge" || resolution.choice === "complete") {
        return { issueStatus: "done", workflowOutcome: "done", triggerReflect: true };
      }
      if (resolution.choice === "repair") return { issueStatus: "repairing", startNewRound: true, roundKind: "review" };
      if (resolution.choice === "close") return { issueStatus: "closed", workflowOutcome: "closed" };
      throw new Error(`Unrecognized final_review choice: ${resolution.choice}`);
    case "attempts_exhausted":
      // A "retry" must grant one more round, not just re-spend the exhausted one —
      // otherwise the very next changes_requested re-creates attempts_exhausted immediately.
      if (resolution.choice === "retry") return { issueStatus: "repairing", startNewRound: true, roundKind: "review_grant" };
      if (resolution.choice === "close") return { issueStatus: "closed", workflowOutcome: "closed" };
      throw new Error(`Unrecognized attempts_exhausted choice: ${resolution.choice}`);
    case "policy_escalation":
      // An infra escalation resuming is not a review-round spend — reset the infra budget instead.
      if (resolution.choice === "resume") return { issueStatus: "developing", startNewRound: true, roundKind: "infra" };
      // NOT-194: same outcome shape as final_review:repair — a genuine repair cycle that
      // spends a review round and queues a developer round in commands.ts's generic path.
      if (resolution.choice === "repair") return { issueStatus: "repairing", startNewRound: true, roundKind: "review" };
      if (resolution.choice === "close") return { issueStatus: "closed", workflowOutcome: "closed" };
      // retry_merge never reaches here: commands.ts parks it for undraft+merge (same
      // finalize as final_review:merge) before consulting this outcome map.
      throw new Error(`Unrecognized policy_escalation choice: ${resolution.choice}`);
    case "product_scope_decision":
      return { issueStatus: "developing", startNewRound: true, roundKind: "none" };
    case "deck_interaction_required":
      // Same semantics as policy_escalation:resume — an authority/control-plane hiccup is
      // not a review-round spend; a fresh attempt mints its own new authority when it runs.
      if (resolution.choice === "resume") return { issueStatus: "developing", startNewRound: true, roundKind: "infra" };
      if (resolution.choice === "close") return { issueStatus: "closed", workflowOutcome: "closed" };
      throw new Error(`Unrecognized deck_interaction_required choice: ${resolution.choice}`);
  }
}
