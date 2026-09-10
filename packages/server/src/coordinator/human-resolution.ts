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

/**
 * Implements PRD §6.3's human pass-the-ball outcomes: continue, repair, complete, or close.
 * v1 (open decision #2 in the spec) treats every "resume/retry/repair" choice as starting
 * another round rather than distinguishing a true resume from a fresh repair round.
 */
export function resolveHumanActionOutcome(resolution: HumanResolution): HumanResolutionResult {
  switch (resolution.actionType) {
    case "final_review":
      if (resolution.choice === "complete") return { issueStatus: "done", workflowOutcome: "done", triggerReflect: true };
      if (resolution.choice === "repair") return { issueStatus: "repairing", startNewRound: true };
      return { issueStatus: "closed", workflowOutcome: "closed" };
    case "attempts_exhausted":
      return resolution.choice === "retry"
        ? { issueStatus: "repairing", startNewRound: true }
        : { issueStatus: "closed", workflowOutcome: "closed" };
    case "policy_escalation":
      return resolution.choice === "resume"
        ? { issueStatus: "developing", startNewRound: true }
        : { issueStatus: "closed", workflowOutcome: "closed" };
    case "product_scope_decision":
      return { issueStatus: "developing", startNewRound: true };
  }
}
