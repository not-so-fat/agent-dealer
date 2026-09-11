// packages/server/src/coordinator/routing.ts
import type { ReviewerResult } from "./reviewer-result.js";

export type DeveloperOutcome =
  | { kind: "clean_handoff"; branch: string; headSha: string; baseSha: string; prNumber: number; prUrl: string }
  | { kind: "no_pr" }
  | { kind: "dirty_worktree" }
  /** Local commits exist but the coordinator's own push was rejected (e.g. non-fast-forward). */
  | { kind: "unpushed_commit"; reason: string }
  | { kind: "checks_failed"; details?: string }
  /** Covers both the developer session's own wall-clock timeout and an exhausted CI-checks poll. */
  | { kind: "timed_out" }
  /** git/gh tooling itself errored during verification — not the agent's fault. */
  | { kind: "adapter_failure"; reason: string }
  | { kind: "session_failed" };

export type ReviewerOutcome =
  | { kind: "verdict"; result: ReviewerResult }
  | { kind: "stale"; currentHeadSha: string }
  | { kind: "session_failed" }
  | { kind: "publish_failed" };

export interface RoundLimits {
  currentRound: number;
  maxReviewRounds: number;
}

function roundsRemain(limits: RoundLimits): boolean {
  return limits.currentRound < limits.maxReviewRounds;
}

export type DeveloperRouteResult =
  /** headSha is the coordinator-verified SHA (not agent self-report) the reviewer must be pinned to. */
  | { next: "spawn_reviewer"; headSha: string }
  | { next: "retry_developer" }
  | { next: "human_action"; actionType: "attempts_exhausted" | "policy_escalation"; reason: string };

export function routeDeveloperOutcome(outcome: DeveloperOutcome, limits: RoundLimits): DeveloperRouteResult {
  switch (outcome.kind) {
    case "clean_handoff":
      return { next: "spawn_reviewer", headSha: outcome.headSha };
    case "dirty_worktree":
      // Never spends a round — an unclean handoff is preserved for inspection, not retried blindly.
      return { next: "human_action", actionType: "policy_escalation", reason: "Developer worktree has uncommitted changes after the session ended." };
    case "unpushed_commit":
      // Same bucket as dirty_worktree: local work exists that must not be silently discarded
      // or force-retried — a human decides how to resolve the rejected push.
      return { next: "human_action", actionType: "policy_escalation", reason: `Developer's commits could not be pushed: ${outcome.reason}` };
    case "adapter_failure":
      // Infrastructure/tooling failure, not a code problem — same bucket as reviewer publish_failed.
      return { next: "human_action", actionType: "policy_escalation", reason: `Git/GitHub verification failed: ${outcome.reason}` };
    case "no_pr":
    case "session_failed":
    case "timed_out":
    case "checks_failed":
      return roundsRemain(limits)
        ? { next: "retry_developer" }
        : { next: "human_action", actionType: "attempts_exhausted", reason: "Developer session failed, timed out, produced no PR, or its checks failed, and the review-round limit is reached." };
  }
}

export type ReviewerRouteResult =
  | { next: "final_review" }
  | { next: "retry_developer_with_findings" }
  /** Head moved mid-review — re-review at the freshly verified SHA, never the stale one. */
  | { next: "retry_reviewer_at_new_head"; headSha: string }
  | { next: "human_action"; actionType: "attempts_exhausted" | "policy_escalation" | "product_scope_decision"; reason: string };

export function routeReviewerOutcome(outcome: ReviewerOutcome, limits: RoundLimits): ReviewerRouteResult {
  switch (outcome.kind) {
    case "stale":
      return { next: "retry_reviewer_at_new_head", headSha: outcome.currentHeadSha };
    case "session_failed":
      return { next: "human_action", actionType: "policy_escalation", reason: "Reviewer session failed, timed out, or its worktree checkout failed." };
    case "publish_failed":
      return { next: "human_action", actionType: "policy_escalation", reason: "Review publication to GitHub failed — infrastructure issue, not a code finding." };
    case "verdict":
      return routeVerdict(outcome.result, limits);
  }
}

function routeVerdict(result: ReviewerResult, limits: RoundLimits): ReviewerRouteResult {
  switch (result.verdict) {
    case "approved":
      return { next: "final_review" };
    case "changes_requested":
      return roundsRemain(limits)
        ? { next: "retry_developer_with_findings" }
        : { next: "human_action", actionType: "attempts_exhausted", reason: "Reviewer requested changes and the review-round limit is reached." };
    case "escalated":
      return result.productScopeQuestion
        ? { next: "human_action", actionType: "product_scope_decision", reason: result.productScopeQuestion }
        : { next: "human_action", actionType: "policy_escalation", reason: "Reviewer escalated without a resolvable code change." };
  }
}
