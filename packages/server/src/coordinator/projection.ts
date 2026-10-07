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
import type { PushDivergenceEvidence } from "./human-resolution.js";
import type { RuntimeAuthParkEvidence } from "./runtime-auth-park.js";
import { AUTO_MERGE_INTENT } from "./auto-merge.js";

export interface IssueProjection {
  issueStatus: IssueStatus;
  currentOwner: IssueOwner;
  currentIntent: string;
  /** Event types to append, in order, for this transition. */
  events: WorkflowEventType[];
}

/** The kind of the single next work item this decision enqueues, if any. */
export type NextEffect =
  | {
      kind: "enqueue";
      workItem: WorkItemKind;
      atHeadSha?: string;
      retryReason?: string;
      /** Coordinator-only gh/PR/checks retry — no agent spawn (post-push adapter_failure). */
      publishOnly?: boolean;
      branch?: string;
      /** NOT-368: this enqueue spent the one transient high-confidence auth retry. */
      authTransientRetry?: true;
    }
  | {
      kind: "human_action";
      actionType:
        | "attempts_exhausted"
        | "policy_escalation"
        | "product_scope_decision"
        | "final_review";
      reason: string;
      /** NOT-221: diverged-push facts from the route — the action stores them as evidence. */
      pushDivergence?: PushDivergenceEvidence;
      /** NOT-280: worktree blocker fingerprint from the route — used to dedupe the action. */
      blockerFingerprint?: string;
      /** NOT-368: confirmed runtime login park — stored as action evidence for resolve re-probe. */
      runtimeAuthPark?: RuntimeAuthParkEvidence;
    }
  /** NOT-102: merge the PR after approve, then complete or escalate — runs after the
   * routing transaction so `gh` never holds the SQLite write lock. */
  | { kind: "auto_merge" }
  | { kind: "none" };

/** Which budget (if any) this transition spends before enqueueing the next effect. */
export type BudgetAdvance = "review" | "infra" | "ci" | "none";

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
    case "retry_developer": {
      // NOT-313: a CI-repair retry spends the CI budget, never the infra one —
      // the route's budget marker (set only by the checks_failed path) decides.
      const isCiRepair = route.budget === "ci";
      return {
        projection: {
          // developing → developing and repairing → repairing are both self-loops;
          // a retried developer failure stays in "repairing".
          issueStatus: currentStatus === "repairing" ? "repairing" : "developing",
          currentOwner: "developer",
          currentIntent: isCiRepair
            ? `Developer retrying (CI repair attempt) — ${route.reason}`
            : `Developer retrying (infra attempt) — ${route.reason}`,
          events: ["worker.failed"],
        },
        effect: {
          kind: "enqueue",
          workItem: "developer",
          retryReason: route.reason,
          // NOT-368: mark the work item so a second high-confidence auth failure parks.
          ...(route.authTransientRetry ? { authTransientRetry: true as const } : {}),
        },
        advance: isCiRepair ? "ci" : "infra",
      };
    }
    case "retry_publish":
      return {
        projection: {
          issueStatus: currentStatus === "repairing" ? "repairing" : "developing",
          currentOwner: "developer",
          currentIntent: `Retrying GitHub publish (no agent) — ${route.reason}`,
          events: ["worker.failed"],
        },
        effect: {
          kind: "enqueue",
          workItem: "developer",
          retryReason: route.reason,
          publishOnly: true,
          branch: route.branch,
        },
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
        effect: {
          kind: "human_action",
          actionType: route.actionType,
          reason: route.reason,
          // Only the developer unpushed_commit route sets this — the reviewer path never does.
          ...("pushDivergence" in route && route.pushDivergence
            ? { pushDivergence: route.pushDivergence }
            : {}),
          ...(route.blockerFingerprint ? { blockerFingerprint: route.blockerFingerprint } : {}),
          ...("runtimeAuthPark" in route && route.runtimeAuthPark
            ? { runtimeAuthPark: route.runtimeAuthPark }
            : {}),
        },
        advance: "none",
      };
    case "defer_work":
      throw new Error("defer_work is applied by the deferral path in commands.ts, not projection");
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
    case "auto_merge":
      // Park in final_review under system ownership with no human_action — finalizeAutoMerge
      // then moves to done or needs_human. Intent equals AUTO_MERGE_INTENT for recovery.
      return {
        projection: {
          issueStatus: "final_review",
          currentOwner: "system",
          currentIntent: AUTO_MERGE_INTENT,
          events: ["worker.completed", ...verdictEvents],
        },
        effect: { kind: "auto_merge" },
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
      // Spends an infra attempt (not a review round): an unbounded chain of these — the
      // head kept moving faster than the reviewer could catch up — must still terminate.
      return {
        projection: {
          issueStatus: "reviewing",
          currentOwner: "reviewer",
          currentIntent: `Reviewer re-evaluating round ${round} at ${route.headSha.slice(0, 8)}`,
          events: ["worker.completed"],
        },
        effect: { kind: "enqueue", workItem: "reviewer", atHeadSha: route.headSha },
        advance: "infra",
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
          currentIntent: `Reviewer retrying (infra attempt) at ${route.headSha.slice(0, 8)} — ${route.reason}`,
          events: ["worker.failed"],
        },
        effect: {
          kind: "enqueue",
          workItem: "reviewer",
          atHeadSha: route.headSha,
          retryReason: route.reason,
          // NOT-368: mark the work item so a second high-confidence auth failure parks.
          ...(route.authTransientRetry ? { authTransientRetry: true as const } : {}),
        },
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
        effect: {
          kind: "human_action",
          actionType: route.actionType,
          reason: route.reason,
          ...("runtimeAuthPark" in route && route.runtimeAuthPark
            ? { runtimeAuthPark: route.runtimeAuthPark }
            : {}),
        },
        advance: "none",
        hasVerdict,
      };
    case "defer_work":
      throw new Error("defer_work is applied by the deferral path in commands.ts, not projection");
  }
}
