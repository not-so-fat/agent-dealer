// packages/server/src/coordinator/routing.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  routeDeveloperOutcome,
  routeReviewerOutcome,
  type DeveloperOutcome,
  type ReviewerOutcome,
  type RouteLimits,
} from "./routing.js";

const REVIEW_ROUNDS_LEFT: RouteLimits = { currentRound: 1, maxReviewRounds: 3, infraAttempts: 0, maxInfraAttempts: 3 };
const REVIEW_AT_LIMIT: RouteLimits = { currentRound: 3, maxReviewRounds: 3, infraAttempts: 0, maxInfraAttempts: 3 };
const INFRA_ATTEMPTS_LEFT: RouteLimits = { currentRound: 1, maxReviewRounds: 3, infraAttempts: 1, maxInfraAttempts: 3 };
const INFRA_AT_LIMIT: RouteLimits = { currentRound: 1, maxReviewRounds: 3, infraAttempts: 3, maxInfraAttempts: 3 };
const PINNED_HEAD = "pinned-head-sha";

// --- Developer outcomes ---

test("clean handoff routes to spawn_reviewer", () => {
  const outcome: DeveloperOutcome = { kind: "clean_handoff", branch: "br", headSha: "h", baseSha: "b", prNumber: 1, prUrl: "u" };
  assert.deepStrictEqual(routeDeveloperOutcome(outcome, REVIEW_ROUNDS_LEFT), { next: "spawn_reviewer", headSha: "h" });
});

test("no PR with infra attempts remaining retries the developer without spending a review round", () => {
  const outcome: DeveloperOutcome = { kind: "no_pr" };
  assert.deepStrictEqual(routeDeveloperOutcome(outcome, REVIEW_AT_LIMIT), {
    next: "retry_developer",
    reason: "Developer session produced no PR.",
  });
});

test("no PR at the infra-attempt limit escalates, not attempts_exhausted (that stays pure to review rounds)", () => {
  const outcome: DeveloperOutcome = { kind: "no_pr" };
  const result = routeDeveloperOutcome(outcome, INFRA_AT_LIMIT);
  assert.equal(result.next, "human_action");
  assert.equal((result as { actionType: string }).actionType, "policy_escalation");
});

test("session_failed with infra attempts remaining also just retries (same bucket as no_pr)", () => {
  const outcome: DeveloperOutcome = { kind: "session_failed" };
  assert.deepStrictEqual(routeDeveloperOutcome(outcome, INFRA_ATTEMPTS_LEFT), {
    next: "retry_developer",
    reason: "Developer session failed or crashed.",
  });
});

test("dirty worktree always escalates immediately — never retried, regardless of any budget", () => {
  const outcome: DeveloperOutcome = { kind: "dirty_worktree" };
  const result = routeDeveloperOutcome(outcome, REVIEW_ROUNDS_LEFT);
  assert.equal(result.next, "human_action");
  assert.equal((result as { actionType: string }).actionType, "policy_escalation");
});

test("unpushed commit always escalates immediately — never retried, regardless of any budget", () => {
  const outcome: DeveloperOutcome = { kind: "unpushed_commit", reason: "non-fast-forward" };
  const result = routeDeveloperOutcome(outcome, REVIEW_ROUNDS_LEFT);
  assert.equal(result.next, "human_action");
  assert.equal((result as { actionType: string }).actionType, "policy_escalation");
});

test("worktree conflict always escalates immediately — never retried, regardless of any budget, and carries path/recovery in the reason", () => {
  const outcome: DeveloperOutcome = {
    kind: "worktree_conflict",
    path: "/data/worktrees/old-session-developer",
    reason: "A previous developer worktree for branch issue-1 still holds it at /data/worktrees/old-session-developer with uncommitted or unpushed work.",
    recoveryCommands: ["cd /data/worktrees/old-session-developer", "git status"],
  };
  const result = routeDeveloperOutcome(outcome, INFRA_AT_LIMIT);
  assert.equal(result.next, "human_action");
  assert.equal((result as { actionType: string }).actionType, "policy_escalation");
  const reason = (result as { reason: string }).reason;
  assert.match(reason, /old-session-developer/);
  assert.match(reason, /git status/);
});

test("adapter failure is bounded-retried on the infra budget (unified failure policy), not escalated on first occurrence", () => {
  const outcome: DeveloperOutcome = { kind: "adapter_failure", reason: "gh: command not found" };
  assert.deepStrictEqual(routeDeveloperOutcome(outcome, INFRA_ATTEMPTS_LEFT), {
    next: "retry_developer",
    reason: "Git/GitHub verification failed: gh: command not found",
  });
});

test("adapter failure escalates once the infra-attempt limit is reached", () => {
  const outcome: DeveloperOutcome = { kind: "adapter_failure", reason: "gh: command not found" };
  const result = routeDeveloperOutcome(outcome, INFRA_AT_LIMIT);
  assert.equal(result.next, "human_action");
  assert.equal((result as { actionType: string }).actionType, "policy_escalation");
});

test("timed_out with infra attempts remaining retries (same bucket as session_failed/no_pr)", () => {
  const outcome: DeveloperOutcome = { kind: "timed_out" };
  assert.deepStrictEqual(routeDeveloperOutcome(outcome, INFRA_ATTEMPTS_LEFT), {
    next: "retry_developer",
    reason: "Developer session timed out.",
  });
});

test("checks_failed with infra attempts remaining retries (same bucket as session_failed/no_pr)", () => {
  const outcome: DeveloperOutcome = { kind: "checks_failed", details: "lint failed" };
  assert.deepStrictEqual(routeDeveloperOutcome(outcome, INFRA_ATTEMPTS_LEFT), {
    next: "retry_developer",
    reason: "Developer's PR checks failed.",
  });
});

test("checks_failed at the infra-attempt limit escalates", () => {
  const outcome: DeveloperOutcome = { kind: "checks_failed" };
  const result = routeDeveloperOutcome(outcome, INFRA_AT_LIMIT);
  assert.equal(result.next, "human_action");
  assert.equal((result as { actionType: string }).actionType, "policy_escalation");
});

test("an infra-class developer failure never spends the review-round budget, even at the review-round limit", () => {
  const outcome: DeveloperOutcome = { kind: "session_failed" };
  assert.deepStrictEqual(routeDeveloperOutcome(outcome, REVIEW_AT_LIMIT), {
    next: "retry_developer",
    reason: "Developer session failed or crashed.",
  });
});

// --- Reviewer outcomes ---

test("approved verdict routes to final_review regardless of round", () => {
  const outcome: ReviewerOutcome = {
    kind: "verdict",
    result: { verdict: "approved", baseSha: "b", headSha: "h", acceptanceCriteriaAssessment: "met", evidenceAssessment: "ok", findings: [], risks: [] },
  };
  assert.deepStrictEqual(routeReviewerOutcome(outcome, REVIEW_ROUNDS_LEFT, PINNED_HEAD), { next: "final_review" });
});

test("changes_requested with rounds remaining retries the developer with findings", () => {
  const outcome: ReviewerOutcome = {
    kind: "verdict",
    result: { verdict: "changes_requested", baseSha: "b", headSha: "h", acceptanceCriteriaAssessment: "partial", evidenceAssessment: "ok", findings: [{ fingerprint: "f1", severity: "blocking", title: "T", rationale: "R" }], risks: [] },
  };
  assert.deepStrictEqual(routeReviewerOutcome(outcome, REVIEW_ROUNDS_LEFT, PINNED_HEAD), { next: "retry_developer_with_findings" });
});

test("changes_requested at the review-round limit exhausts attempts, even with infra attempts untouched", () => {
  const outcome: ReviewerOutcome = {
    kind: "verdict",
    result: { verdict: "changes_requested", baseSha: "b", headSha: "h", acceptanceCriteriaAssessment: "partial", evidenceAssessment: "ok", findings: [], risks: [] },
  };
  const result = routeReviewerOutcome(outcome, REVIEW_AT_LIMIT, PINNED_HEAD);
  assert.equal(result.next, "human_action");
  assert.equal((result as { actionType: string }).actionType, "attempts_exhausted");
});

test("escalated with a product scope question routes to product_scope_decision", () => {
  const outcome: ReviewerOutcome = {
    kind: "verdict",
    result: { verdict: "escalated", baseSha: "b", headSha: "h", acceptanceCriteriaAssessment: "unclear", evidenceAssessment: "ok", findings: [], risks: [], productScopeQuestion: "Should deleted users retain their sessions?" },
  };
  const result = routeReviewerOutcome(outcome, REVIEW_ROUNDS_LEFT, PINNED_HEAD);
  assert.equal((result as { actionType: string }).actionType, "product_scope_decision");
});

test("escalated without a product scope question routes to policy_escalation", () => {
  const outcome: ReviewerOutcome = {
    kind: "verdict",
    result: { verdict: "escalated", baseSha: "b", headSha: "h", acceptanceCriteriaAssessment: "unclear", evidenceAssessment: "ok", findings: [], risks: [] },
  };
  const result = routeReviewerOutcome(outcome, REVIEW_ROUNDS_LEFT, PINNED_HEAD);
  assert.equal((result as { actionType: string }).actionType, "policy_escalation");
});

test("stale review retries the reviewer at the freshly verified head while infra attempts remain", () => {
  const outcome: ReviewerOutcome = { kind: "stale", currentHeadSha: "new-head" };
  assert.deepStrictEqual(routeReviewerOutcome(outcome, INFRA_ATTEMPTS_LEFT, PINNED_HEAD), { next: "retry_reviewer_at_new_head", headSha: "new-head" });
});

test("a stale review never spends a review round, even at the review-round limit", () => {
  const outcome: ReviewerOutcome = { kind: "stale", currentHeadSha: "new-head" };
  assert.deepStrictEqual(routeReviewerOutcome(outcome, REVIEW_AT_LIMIT, PINNED_HEAD), { next: "retry_reviewer_at_new_head", headSha: "new-head" });
});

test("a head that keeps moving faster than the reviewer can catch up eventually escalates, bounding the retry loop", () => {
  const outcome: ReviewerOutcome = { kind: "stale", currentHeadSha: "new-head" };
  const result = routeReviewerOutcome(outcome, INFRA_AT_LIMIT, PINNED_HEAD);
  assert.equal(result.next, "human_action");
  assert.equal((result as { actionType: string }).actionType, "policy_escalation");
});

test("reviewer session_failed is bounded-retried at the SAME pinned head, not the developer", () => {
  const outcome: ReviewerOutcome = { kind: "session_failed" };
  assert.deepStrictEqual(routeReviewerOutcome(outcome, INFRA_ATTEMPTS_LEFT, PINNED_HEAD), { next: "retry_reviewer", headSha: PINNED_HEAD });
});

test("reviewer session_failed escalates once the infra-attempt limit is reached", () => {
  const outcome: ReviewerOutcome = { kind: "session_failed" };
  const result = routeReviewerOutcome(outcome, INFRA_AT_LIMIT, PINNED_HEAD);
  assert.equal(result.next, "human_action");
  assert.equal((result as { actionType: string }).actionType, "policy_escalation");
});

test("review publish_failed is bounded-retried rather than immediately confused with a code finding", () => {
  const outcome: ReviewerOutcome = { kind: "publish_failed" };
  assert.deepStrictEqual(routeReviewerOutcome(outcome, INFRA_ATTEMPTS_LEFT, PINNED_HEAD), { next: "retry_reviewer", headSha: PINNED_HEAD });
});

test("review publish_failed escalates once the infra-attempt limit is reached", () => {
  const outcome: ReviewerOutcome = { kind: "publish_failed" };
  const result = routeReviewerOutcome(outcome, INFRA_AT_LIMIT, PINNED_HEAD);
  assert.equal(result.next, "human_action");
  assert.equal((result as { actionType: string }).actionType, "policy_escalation");
});

test("a reviewer infra-class failure never spends the review-round budget, even at the review-round limit", () => {
  const outcome: ReviewerOutcome = { kind: "session_failed" };
  assert.deepStrictEqual(routeReviewerOutcome(outcome, REVIEW_AT_LIMIT, PINNED_HEAD), { next: "retry_reviewer", headSha: PINNED_HEAD });
});
