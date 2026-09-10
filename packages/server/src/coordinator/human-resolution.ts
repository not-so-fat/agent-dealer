import type { HumanActionType } from "@agent-dealer/shared";

export type HumanResolution =
  | { actionType: "final_review"; choice: "complete" | "repair" | "close" }
  | { actionType: "attempts_exhausted"; choice: "retry" | "close" }
  | { actionType: "policy_escalation"; choice: "resume" | "close" }
  | { actionType: "product_scope_decision"; choice: "resume"; note?: string };

export interface HumanResolutionResult {
  issueStatus: "done" | "repairing" | "closed" | "developing";
  workflowOutcome?: "done" | "closed";
  startNewRound?: boolean;
  triggerReflect?: boolean;
}

/** The only choices resolveHumanActionOutcome accepts per action type — the stored "response options." */
const VALID_CHOICES: Record<HumanActionType, readonly string[]> = {
  final_review: ["complete", "repair", "close"],
  attempts_exhausted: ["retry", "close"],
  policy_escalation: ["resume", "close"],
  product_scope_decision: ["resume"],
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
      if (resolution.choice === "repair") return { issueStatus: "repairing", startNewRound: true };
      if (resolution.choice === "close") return { issueStatus: "closed", workflowOutcome: "closed" };
      throw new Error(`Unrecognized final_review choice: ${resolution.choice}`);
    case "attempts_exhausted":
      if (resolution.choice === "retry") return { issueStatus: "repairing", startNewRound: true };
      if (resolution.choice === "close") return { issueStatus: "closed", workflowOutcome: "closed" };
      throw new Error(`Unrecognized attempts_exhausted choice: ${resolution.choice}`);
    case "policy_escalation":
      if (resolution.choice === "resume") return { issueStatus: "developing", startNewRound: true };
      if (resolution.choice === "close") return { issueStatus: "closed", workflowOutcome: "closed" };
      throw new Error(`Unrecognized policy_escalation choice: ${resolution.choice}`);
    case "product_scope_decision":
      return { issueStatus: "developing", startNewRound: true };
  }
}
