// packages/server/src/coordinator/routing.ts
import type { ReviewerResult } from "./reviewer-result.js";

export type DeveloperOutcome =
  | { kind: "clean_handoff"; branch: string; headSha: string; baseSha: string; prNumber: number; prUrl: string }
  | { kind: "no_pr" }
  /** Optional `reason` surfaces auth/runtime classifiers (NOT-113) while keeping preservation. */
  | { kind: "dirty_worktree"; reason?: string }
  /** Local commits exist but the coordinator's own push was rejected (e.g. non-fast-forward). */
  | { kind: "unpushed_commit"; reason: string }
  /** A prior round's worktree still holds the issue branch and can't be safely reused/removed
   * (dirty/unpushed, or not coordinator-managed) — see git-worktree.ts's resolveDeveloperWorktree. */
  | { kind: "worktree_conflict"; path: string; reason: string; recoveryCommands: string[] }
  | { kind: "checks_failed"; details?: string }
  /** Covers both the developer session's own wall-clock timeout and an exhausted CI-checks poll. */
  | { kind: "timed_out"; reason?: string }
  /** git/gh tooling itself errored during verification — not the agent's fault.
   * When `afterPush` is set, the branch is already on the remote: infra retry should
   * re-run coordinator publish only (no new agent session). */
  | { kind: "adapter_failure"; reason: string; afterPush?: { branch: string } }
  | { kind: "session_failed"; reason?: string }
  /** Runtime account usage cap — defer until unavailable_until, not an infra failure (NOT-111).
   * Optional `resume.retryReason` frames the next developer prompt when commits remain (NOT-117).
   * Branch identity stays `issue.branch ?? issue-${id}` — do not dual-write a payload.branch. */
  | {
      kind: "usage_capped";
      until: string;
      reason: string;
      evidence?: unknown;
      resume?: { retryReason: string };
    };

export type ReviewerOutcome =
  | { kind: "verdict"; result: ReviewerResult }
  | { kind: "stale"; currentHeadSha: string }
  | { kind: "session_failed"; reason?: string }
  | { kind: "publish_failed"; reason?: string }
  | { kind: "usage_capped"; until: string; reason: string; evidence?: unknown };

export interface RouteLimits {
  currentRound: number;
  maxReviewRounds: number;
  /** Session/git/gh/Agent Deck/publish failures spend this budget, never the review-round one. */
  infraAttempts: number;
  maxInfraAttempts: number;
}

function roundsRemain(limits: RouteLimits): boolean {
  return limits.currentRound < limits.maxReviewRounds;
}

function infraAttemptsRemain(limits: RouteLimits): boolean {
  return limits.infraAttempts < limits.maxInfraAttempts;
}

export type DeveloperRouteResult =
  /** headSha is the coordinator-verified SHA (not agent self-report) the reviewer must be pinned to. */
  | { next: "spawn_reviewer"; headSha: string }
  /** Bounded infra retry — a fresh developer session on the same branch, no review round
   * spent. `reason` carries WHY the prior attempt failed into the next session's prompt —
   * without it, a retried developer can't tell checks_failed from adapter_failure from a
   * plain crash, and (round 1 specifically) would be told to start on a "fresh branch"
   * despite reusing one that already carries a failed attempt's commits. */
  | { next: "retry_developer"; reason: string }
  /** Branch already on origin; re-run coordinator gh/PR/checks only (no agent spawn). */
  | { next: "retry_publish"; reason: string; branch: string }
  | {
      next: "human_action";
      actionType: "attempts_exhausted" | "policy_escalation";
      reason: string;
    }
  | { next: "defer_work"; until: string; reason: string };

export function routeDeveloperOutcome(outcome: DeveloperOutcome, limits: RouteLimits): DeveloperRouteResult {
  switch (outcome.kind) {
    case "clean_handoff":
      return { next: "spawn_reviewer", headSha: outcome.headSha };
    case "dirty_worktree":
      // Never spends any budget — an unclean handoff is preserved for inspection, not retried blindly.
      // Prefer classified reason (e.g. Cursor keychain died mid-run) when the effect attached one.
      return {
        next: "human_action",
        actionType: "policy_escalation",
        reason:
          outcome.reason ??
          "Developer worktree has uncommitted changes after the session ended.",
      };
    case "unpushed_commit":
      // Same bucket as dirty_worktree: local work exists that must not be silently discarded
      // or force-retried — a human decides how to resolve the rejected push.
      return { next: "human_action", actionType: "policy_escalation", reason: `Developer's commits could not be pushed: ${outcome.reason}` };
    case "worktree_conflict":
      // Never spends infra-attempt budget — the branch is provably still checked out
      // somewhere, so a blind auto-retry would collide identically every time. Preserved
      // for inspection, same bucket as dirty_worktree/unpushed_commit, with the path and
      // recovery commands folded into the reason so the escalation is actionable instead
      // of an opaque git error (design §"Worktree lifecycle and concurrency").
      return {
        next: "human_action",
        actionType: "policy_escalation",
        reason: `${outcome.reason} Recovery:\n${outcome.recoveryCommands.join("\n")}`,
      };
    case "adapter_failure": {
      const reason = infraFailureReason(outcome);
      if (outcome.afterPush && infraAttemptsRemain(limits)) {
        return { next: "retry_publish", reason, branch: outcome.afterPush.branch };
      }
      return infraAttemptsRemain(limits)
        ? { next: "retry_developer", reason }
        : { next: "human_action", actionType: "policy_escalation", reason: `${reason} (infra-attempt limit reached).` };
    }
    case "no_pr":
    case "session_failed":
    case "timed_out":
    case "checks_failed": {
      // Unified infra-failure policy: the session/environment failed to produce a
      // reviewable result at all — bounded auto-retry on max_infra_attempts, decoupled
      // from the review-round budget, then a human policy_escalation.
      const reason = infraFailureReason(outcome);
      return infraAttemptsRemain(limits)
        ? { next: "retry_developer", reason }
        : { next: "human_action", actionType: "policy_escalation", reason: `${reason} (infra-attempt limit reached).` };
    }
    case "usage_capped":
      return { next: "defer_work", until: outcome.until, reason: outcome.reason };
  }
}

function infraFailureReason(outcome: DeveloperOutcome & { kind: "no_pr" | "session_failed" | "timed_out" | "checks_failed" | "adapter_failure" }): string {
  switch (outcome.kind) {
    case "no_pr":
      return "Developer session produced no PR.";
    case "session_failed":
      return outcome.reason ?? "Developer session failed or crashed.";
    case "timed_out":
      return outcome.reason ?? "Developer session timed out.";
    case "checks_failed":
      return "Developer's PR checks failed.";
    case "adapter_failure":
      return `Git/GitHub verification failed: ${outcome.reason}`;
  }
}

export type ReviewerRouteResult =
  | { next: "final_review" }
  /** Reviewer approved and the issue opted into per-issue auto-merge (NOT-102). */
  | { next: "auto_merge" }
  | { next: "retry_developer_with_findings" }
  /** Head moved mid-review — re-review at the freshly verified SHA, never the stale one.
   * Never spends a review round, but DOES spend an infra attempt: an unbounded chain of
   * these (the head kept moving faster than the reviewer could catch up) would otherwise
   * let the coordinator spawn reviewer sessions indefinitely. */
  | { next: "retry_reviewer_at_new_head"; headSha: string }
  /** Bounded infra retry — a fresh reviewer session at the SAME already-verified head. */
  | { next: "retry_reviewer"; headSha: string; reason: string }
  | {
      next: "human_action";
      actionType: "attempts_exhausted" | "policy_escalation" | "product_scope_decision";
      reason: string;
    }
  | { next: "defer_work"; until: string; reason: string };

export function routeReviewerOutcome(
  outcome: ReviewerOutcome,
  limits: RouteLimits & { autoMerge?: boolean },
  pinnedHeadSha: string
): ReviewerRouteResult {
  switch (outcome.kind) {
    case "stale":
      return infraAttemptsRemain(limits)
        ? { next: "retry_reviewer_at_new_head", headSha: outcome.currentHeadSha }
        : {
            next: "human_action",
            actionType: "policy_escalation",
            reason: "The PR head kept moving before the reviewer could evaluate it (infra-attempt limit reached).",
          };
    case "session_failed":
    case "publish_failed": {
      const reason =
        outcome.kind === "session_failed"
          ? (outcome.reason ??
            "Reviewer session failed, timed out, its worktree checkout failed, or its output was unparseable.")
          : (outcome.reason ?? "Review publication to GitHub failed.");
      return infraAttemptsRemain(limits)
        ? { next: "retry_reviewer", headSha: pinnedHeadSha, reason }
        : { next: "human_action", actionType: "policy_escalation", reason: `${reason} (infra-attempt limit reached).` };
    }
    case "usage_capped":
      return { next: "defer_work", until: outcome.until, reason: outcome.reason };
    case "verdict":
      return routeVerdict(outcome.result, limits);
  }
}

function routeVerdict(result: ReviewerResult, limits: RouteLimits & { autoMerge?: boolean }): ReviewerRouteResult {
  switch (result.verdict) {
    case "approved":
      return limits.autoMerge ? { next: "auto_merge" } : { next: "final_review" };
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
