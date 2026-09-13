import type { HumanActionType } from "@agent-dealer/shared";

export type HumanResolution =
  | { actionType: "final_review"; choice: "complete" | "repair" | "close" }
  | { actionType: "attempts_exhausted"; choice: "retry" | "close" }
  | { actionType: "policy_escalation"; choice: "resume" | "close" }
  | { actionType: "product_scope_decision"; choice: "resume"; note?: string }
  | { actionType: "deck_interaction_required"; choice: "resume" | "close" };

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
 * options." `reflection_interaction_required` is listed here only so this map stays total
 * over `HumanActionType`; it is never routed through `resolveHumanActionOutcome` (NOT-94's
 * reflect-trigger.ts resolves it directly — reflection runs after the issue is already
 * `done`, and its choices must never reopen the issue or enqueue developer/reviewer work).
 */
const VALID_CHOICES: Record<HumanActionType, readonly string[]> = {
  final_review: ["complete", "repair", "close"],
  attempts_exhausted: ["retry", "close"],
  policy_escalation: ["resume", "close"],
  product_scope_decision: ["resume"],
  deck_interaction_required: ["resume", "close"],
  reflection_interaction_required: ["retry", "dismiss"],
};

/**
 * Validates a raw (actionType, choice) pair against that action type's allowed response
 * options before it's ever treated as a typed HumanResolution. Returns null for anything
 * not in the allowed set — callers must reject the request rather than guess at intent.
 */
export function parseHumanResolution(actionType: string, choice: string): HumanResolution | null {
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
      if (resolution.choice === "complete") return { issueStatus: "done", workflowOutcome: "done", triggerReflect: true };
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
      if (resolution.choice === "close") return { issueStatus: "closed", workflowOutcome: "closed" };
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
