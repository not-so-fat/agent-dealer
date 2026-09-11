// packages/server/src/coordinator/projection.ts
//
// Pure projection of a routing decision onto the issue's denormalized state
// (status / owner / intent) and the *worker* workflow-event types for this transition.
// The event rows and the transition events tied to the next effect (repair.started,
// final_review.requested, human_action.requested, issue.completed/closed) are written by
// commands.ts. Every `issueStatus` returned here is a legal ISSUE_STATUS_TRANSITIONS
// target from the phase it is reached in — asserted in tests.
import type { IssueOwner, IssueStatus, WorkflowEventType } from "@agent-dealer/shared";
import type { DeveloperRouteResult, ReviewerRouteResult } from "./routing.js";
import type { WorkItemKind } from "../repository/work-items.js";

export interface IssueProjection {
  issueStatus: IssueStatus;
  currentOwner: IssueOwner;
  currentIntent: string;
  /** Event types to append, in order, for this transition. */
  events: WorkflowEventType[];
}

/** The kind of the single next work item this decision enqueues, if any. */
export type NextEffect =
  | { kind: "enqueue"; workItem: WorkItemKind; atHeadSha?: string }
  | { kind: "human_action"; actionType: "attempts_exhausted" | "policy_escalation" | "product_scope_decision" | "final_review"; reason: string }
  | { kind: "none" };

/** Which budget (if any) this transition spends before enqueueing the next effect. */
export type BudgetAdvance = "review" | "infra" | "none";

export interface DeveloperProjection {
  projection: IssueProjection;
  effect: NextEffect;
  advance: BudgetAdvance;
}

export function projectDeveloperRoute(
  route: DeveloperRouteResult,
  currentStatus: IssueStatus,
  round: number
): DeveloperProjection {
  switch (route.next) {
    case "spawn_reviewer":
      return {
        projection: {
          issueStatus: "reviewing",
          currentOwner: "reviewer",
          currentIntent: `Reviewer evaluating round ${round}`,
          events: ["worker.completed", "pull_request.opened"],
        },
        // Pins the reviewer's input_sha to the coordinator-verified head, exactly like
        // retry_reviewer_at_new_head below — a reviewer must never be queued unpinned.
        effect: { kind: "enqueue", workItem: "reviewer", atHeadSha: route.headSha },
        advance: "none",
      };
    case "retry_developer":
      return {
        projection: {
          // developing → developing and repairing → repairing are both self-loops;
          // an infra-retry developer failure stays in "repairing".
          issueStatus: currentStatus === "repairing" ? "repairing" : "developing",
          currentOwner: "developer",
          currentIntent: `Developer retrying (infra attempt)`,
          events: ["worker.failed"],
        },
        effect: { kind: "enqueue", workItem: "developer" },
        advance: "infra",
      };
    case "human_action":
      return {
        projection: {
          issueStatus: "needs_human",
          currentOwner: "human",
          currentIntent: route.reason,
          events: ["worker.failed"],
        },
        effect: { kind: "human_action", actionType: route.actionType, reason: route.reason },
        advance: "none",
      };
  }
}

export interface ReviewerProjection {
  projection: IssueProjection;
  effect: NextEffect;
  advance: BudgetAdvance;
  /** review.submitted / findings only apply when the reviewer actually returned a verdict. */
  hasVerdict: boolean;
}

export function projectReviewerRoute(
  route: ReviewerRouteResult,
  round: number,
  hasVerdict: boolean
): ReviewerProjection {
  const verdictEvents: WorkflowEventType[] = hasVerdict ? ["review.submitted"] : [];
  switch (route.next) {
    case "final_review":
      return {
        projection: {
          issueStatus: "final_review",
          currentOwner: "human",
          currentIntent: "Awaiting final human review",
          events: ["worker.completed", ...verdictEvents],
        },
        effect: { kind: "human_action", actionType: "final_review", reason: "Reviewer approved the PR" },
        advance: "none",
        hasVerdict,
      };
    case "retry_developer_with_findings":
      return {
        projection: {
          issueStatus: "repairing",
          currentOwner: "developer",
          currentIntent: `Developer repairing round ${round + 1}`,
          events: ["worker.completed", ...verdictEvents],
        },
        effect: { kind: "enqueue", workItem: "developer" },
        advance: "review",
        hasVerdict,
      };
    case "retry_reviewer_at_new_head":
      return {
        projection: {
          issueStatus: "reviewing",
          currentOwner: "reviewer",
          currentIntent: `Reviewer re-evaluating round ${round} at ${route.headSha.slice(0, 8)}`,
          events: ["worker.completed"],
        },
        effect: { kind: "enqueue", workItem: "reviewer", atHeadSha: route.headSha },
        advance: "none",
        hasVerdict,
      };
    case "retry_reviewer":
      // Bounded infra retry — a fresh reviewer session at the SAME already-verified head
      // (unlike retry_reviewer_at_new_head, the head hasn't moved; the prior session/
      // publish attempt just failed to produce a usable result).
      return {
        projection: {
          issueStatus: "reviewing",
          currentOwner: "reviewer",
          currentIntent: `Reviewer retrying (infra attempt) at ${route.headSha.slice(0, 8)}`,
          events: ["worker.failed"],
        },
        effect: { kind: "enqueue", workItem: "reviewer", atHeadSha: route.headSha },
        advance: "infra",
        hasVerdict,
      };
    case "human_action":
      return {
        projection: {
          issueStatus: "needs_human",
          currentOwner: "human",
          currentIntent: route.reason,
          events: [hasVerdict ? "worker.completed" : "worker.failed", ...verdictEvents],
        },
        effect: { kind: "human_action", actionType: route.actionType, reason: route.reason },
        advance: "none",
        hasVerdict,
      };
  }
}
