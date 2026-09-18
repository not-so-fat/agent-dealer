// packages/server/src/coordinator/routing.ts
import { normalizeReviewerResult, type ReviewerResult } from "./reviewer-result.js";

export type DeveloperOutcome =
  | { kind: "clean_handoff"; branch: string; headSha: string; baseSha: string; prNumber: number; prUrl: string }
  | { kind: "no_pr" }
  /** Optional `reason` surfaces auth/runtime classifiers (NOT-113) while keeping preservation.
   * Optional `path` + `recoveryCommands` make the escalation actionable like worktree_conflict
   * (NOT-137 / NOT-145) when salvage could not land a tip. */
  | { kind: "dirty_worktree"; reason?: string; path?: string; recoveryCommands?: string[] }
  /** Local commits exist but the coordinator's own push was rejected (e.g. non-fast-forward).
   * `recoveryCommands` (NOT-137) mirrors worktree_conflict: divergence facts live in `reason`,
   * and the concrete recovery steps are folded into the escalation text at route time. */
  | { kind: "unpushed_commit"; reason: string; recoveryCommands?: string[] }
  /** A prior round's worktree still holds the issue branch and can't be safely reused/removed
   * (dirty/unpushed, or not coordinator-managed) — see git-worktree.ts's resolveDeveloperWorktree. */
  | { kind: "worktree_conflict"; path: string; reason: string; recoveryCommands: string[] }
  /** NOT-127: leftover worktree still has a live owning process — do not adopt or treat as conflict. */
  | { kind: "live_owner"; path: string; ownerSessionId: string; reason: string }
  | { kind: "checks_failed"; details?: string }
  /** Covers both the developer session's own wall-clock timeout and an exhausted CI-checks poll. */
  | { kind: "timed_out"; reason?: string }
  /** git/gh tooling itself errored during verification — not the agent's fault.
   * `publishable` names a branch whose commits the coordinator can still publish on its own:
   * already on the remote, or recovered from a dead attempt and merely waiting on a push
   * (NOT-129). Either way the infra retry re-runs coordinator publish only — spawning a fresh
   * agent to redo committed work is the expensive mistake, and a failed push does not undo
   * the commits that made the branch publishable in the first place. */
  | { kind: "adapter_failure"; reason: string; publishable?: { branch: string } }
  /** Agent Deck config, connection, bound-deck, or required-playbook preflight failed. */
  | { kind: "deck_failure"; reason: string }
  /** NOT-136: Agent Deck was unreachable at preflight — nothing spawned, nothing attempted.
   * Deferred like a usage cap (no infra attempt, exponential backoff), never routed as a
   * worker failure. `until` is computed by the deferral, not by the effect. */
  | { kind: "deck_unavailable"; reason: string }
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
  | { kind: "deck_failure"; reason: string }
  /** NOT-136 — see DeveloperOutcome's deck_unavailable. */
  | { kind: "deck_unavailable"; reason: string }
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

/**
 * The one definition of "is there infra budget left". Exported because recovery.ts asks the
 * same question about a presumed-dead reclaim (NOT-128): a host/coordinator failure is bounded
 * by `max_infra_attempts` exactly like an observed session failure, and a second copy of this
 * comparison living in recovery is the thing that would drift.
 */
export function infraAttemptsRemain(
  limits: Pick<RouteLimits, "infraAttempts" | "maxInfraAttempts">
): boolean {
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
  /** Re-run the coordinator's own publish stage only — no agent spawn. Usually the branch is
   * already on origin and just gh/PR/checks is redone, but a recovered branch whose push has
   * not landed yet is pushed first (developer-effect's runPublishOnlyHandoff decides from the
   * branch, so this route must never be read as "the remote is already correct"). */
  | { next: "retry_publish"; reason: string; branch: string }
  | {
      next: "human_action";
      actionType: "attempts_exhausted" | "policy_escalation";
      reason: string;
    }
  /** `until` is only known up front when the blocker reports its own reset time (a usage
   * cap). An unreachable Agent Deck gives no ETA, so its retry time comes from the deferral
   * backoff schedule instead (NOT-136). */
  | { next: "defer_work"; reason: string; until?: string };

export function routeDeveloperOutcome(outcome: DeveloperOutcome, limits: RouteLimits): DeveloperRouteResult {
  switch (outcome.kind) {
    case "clean_handoff":
      return { next: "spawn_reviewer", headSha: outcome.headSha };
    case "dirty_worktree": {
      // Never spends any budget — an unclean handoff is preserved for inspection, not retried blindly.
      // Prefer classified reason (e.g. Cursor keychain died mid-run) when the effect attached one.
      // When path/recovery are present (NOT-145 salvage failure, or any preserved dirt), fold them
      // in the same shape as worktree_conflict so the UI is actionable (NOT-137).
      const base =
        outcome.reason ?? "Developer worktree has uncommitted changes after the session ended.";
      const reason =
        outcome.recoveryCommands && outcome.recoveryCommands.length > 0
          ? `${base} Recovery:\n${outcome.recoveryCommands.join("\n")}`
          : base;
      return {
        next: "human_action",
        actionType: "policy_escalation",
        reason,
      };
    }
    case "unpushed_commit": {
      // Same bucket as dirty_worktree: local work exists that must not be silently discarded
      // or force-retried — a human decides how to resolve the rejected push. When the adapter
      // attached recovery commands (NOT-137), fold them the same way worktree_conflict does
      // so the escalation is actionable instead of raw git stderr.
      const prefix = `Developer's commits could not be pushed: ${outcome.reason}`;
      const recovery = outcome.recoveryCommands?.length
        ? ` Recovery:\n${outcome.recoveryCommands.join("\n")}`
        : "";
      return { next: "human_action", actionType: "policy_escalation", reason: `${prefix}${recovery}` };
    }
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
    case "live_owner":
      // NOT-127: predecessor CLI is still running in this worktree. Never escalate as a
      // worktree_conflict (that mislabels live WIP as abandoned dirt) and never adopt the
      // path. Bounded infra retry — once the predecessor is actually gone, the next attempt
      // hits the normal clean-reuse / dirty-conflict path.
      return infraAttemptsRemain(limits)
        ? {
            next: "retry_developer",
            reason: outcome.reason,
          }
        : {
            next: "human_action",
            actionType: "policy_escalation",
            reason: `${outcome.reason} (infra-attempt limit reached).`,
          };
    case "adapter_failure": {
      const reason = infraFailureReason(outcome);
      if (outcome.publishable && infraAttemptsRemain(limits)) {
        return { next: "retry_publish", reason, branch: outcome.publishable.branch };
      }
      return infraAttemptsRemain(limits)
        ? { next: "retry_developer", reason }
        : { next: "human_action", actionType: "policy_escalation", reason: `${reason} (infra-attempt limit reached).` };
    }
    case "no_pr":
    case "session_failed":
    case "timed_out":
    case "checks_failed":
    case "deck_failure": {
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
    case "deck_unavailable":
      // NOT-136: a hard-down dependency is not retryable on the infra-attempt timescale, and
      // nothing was spawned, so there is no attempt to charge. Wait for the deck instead.
      return { next: "defer_work", reason: outcome.reason };
  }
}

function infraFailureReason(outcome: DeveloperOutcome & { kind: "no_pr" | "session_failed" | "timed_out" | "checks_failed" | "adapter_failure" | "deck_failure" }): string {
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
    case "deck_failure":
      return `Agent Deck ${outcome.reason}`;
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
  /** See DeveloperRouteResult's defer_work — `until` is absent for an unreachable deck. */
  | { next: "defer_work"; reason: string; until?: string };

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
    case "deck_failure":
    case "publish_failed": {
      const reason =
        outcome.kind === "deck_failure"
          ? `Agent Deck ${outcome.reason}`
          : outcome.kind === "session_failed"
          ? (outcome.reason ??
            "Reviewer session failed, timed out, its worktree checkout failed, or its output was unparseable.")
          : (outcome.reason ?? "Review publication to GitHub failed.");
      return infraAttemptsRemain(limits)
        ? { next: "retry_reviewer", headSha: pinnedHeadSha, reason }
        : { next: "human_action", actionType: "policy_escalation", reason: `${reason} (infra-attempt limit reached).` };
    }
    case "usage_capped":
      return { next: "defer_work", until: outcome.until, reason: outcome.reason };
    case "deck_unavailable":
      // See routeDeveloperOutcome — the reviewer never spawned either (NOT-136).
      return { next: "defer_work", reason: outcome.reason };
    case "verdict":
      return routeVerdict(outcome.result, limits);
  }
}

function routeVerdict(result: ReviewerResult, limits: RouteLimits & { autoMerge?: boolean }): ReviewerRouteResult {
  // Defense in depth: same invariants as parseReviewerResult / PRD §6.4 (NOT-150).
  const normalized = normalizeReviewerResult(result);
  switch (normalized.verdict) {
    case "approved":
      return limits.autoMerge ? { next: "auto_merge" } : { next: "final_review" };
    case "changes_requested":
      return roundsRemain(limits)
        ? { next: "retry_developer_with_findings" }
        : { next: "human_action", actionType: "attempts_exhausted", reason: "Reviewer requested changes and the review-round limit is reached." };
    case "escalated":
      return normalized.productScopeQuestion
        ? { next: "human_action", actionType: "product_scope_decision", reason: normalized.productScopeQuestion }
        : // Illegal bare escalate — treat as changes_requested so repair can run (NOT-150).
          roundsRemain(limits)
          ? { next: "retry_developer_with_findings" }
          : {
              next: "human_action",
              actionType: "attempts_exhausted",
              reason: "Reviewer escalated without a product scope question and the review-round limit is reached.",
            };
  }
}
