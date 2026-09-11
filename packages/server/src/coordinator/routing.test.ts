// packages/server/src/coordinator/routing.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeDeveloperOutcome, routeReviewerOutcome, type DeveloperOutcome, type ReviewerOutcome } from "./routing.js";

const LIMITS_ROUNDS_LEFT = { currentRound: 1, maxReviewRounds: 3 };
const LIMITS_AT_LIMIT = { currentRound: 3, maxReviewRounds: 3 };

// --- Developer outcomes ---

test("clean handoff routes to spawn_reviewer", () => {
  const outcome: DeveloperOutcome = { kind: "clean_handoff", branch: "br", headSha: "h", baseSha: "b", prNumber: 1, prUrl: "u" };
  assert.deepStrictEqual(routeDeveloperOutcome(outcome, LIMITS_ROUNDS_LEFT), { next: "spawn_reviewer" });
});

test("no PR with rounds remaining retries the developer without consuming a reviewer verdict", () => {
  const outcome: DeveloperOutcome = { kind: "no_pr" };
  assert.deepStrictEqual(routeDeveloperOutcome(outcome, LIMITS_ROUNDS_LEFT), { next: "retry_developer" });
});

test("no PR at the round limit exhausts attempts", () => {
  const outcome: DeveloperOutcome = { kind: "no_pr" };
  const result = routeDeveloperOutcome(outcome, LIMITS_AT_LIMIT);
  assert.equal(result.next, "human_action");
  assert.equal((result as { actionType: string }).actionType, "attempts_exhausted");
});

test("session_failed with rounds remaining also just retries (same bucket as no_pr)", () => {
  const outcome: DeveloperOutcome = { kind: "session_failed" };
  assert.deepStrictEqual(routeDeveloperOutcome(outcome, LIMITS_ROUNDS_LEFT), { next: "retry_developer" });
});

test("dirty worktree always escalates, even with rounds remaining — never spends a round", () => {
  const outcome: DeveloperOutcome = { kind: "dirty_worktree" };
  const result = routeDeveloperOutcome(outcome, LIMITS_ROUNDS_LEFT);
  assert.equal(result.next, "human_action");
  assert.equal((result as { actionType: string }).actionType, "policy_escalation");
});

test("unpushed commit always escalates, even with rounds remaining — never spends a round", () => {
  const outcome: DeveloperOutcome = { kind: "unpushed_commit", reason: "non-fast-forward" };
  const result = routeDeveloperOutcome(outcome, LIMITS_ROUNDS_LEFT);
  assert.equal(result.next, "human_action");
  assert.equal((result as { actionType: string }).actionType, "policy_escalation");
});

test("adapter failure always escalates, even with rounds remaining — never spends a round", () => {
  const outcome: DeveloperOutcome = { kind: "adapter_failure", reason: "gh: command not found" };
  const result = routeDeveloperOutcome(outcome, LIMITS_ROUNDS_LEFT);
  assert.equal(result.next, "human_action");
  assert.equal((result as { actionType: string }).actionType, "policy_escalation");
});

test("timed_out with rounds remaining retries (same bucket as session_failed/no_pr)", () => {
  const outcome: DeveloperOutcome = { kind: "timed_out" };
  assert.deepStrictEqual(routeDeveloperOutcome(outcome, LIMITS_ROUNDS_LEFT), { next: "retry_developer" });
});

test("checks_failed with rounds remaining retries (same bucket as session_failed/no_pr)", () => {
  const outcome: DeveloperOutcome = { kind: "checks_failed", details: "lint failed" };
  assert.deepStrictEqual(routeDeveloperOutcome(outcome, LIMITS_ROUNDS_LEFT), { next: "retry_developer" });
});

test("checks_failed at the round limit exhausts attempts", () => {
  const outcome: DeveloperOutcome = { kind: "checks_failed" };
  const result = routeDeveloperOutcome(outcome, LIMITS_AT_LIMIT);
  assert.equal(result.next, "human_action");
  assert.equal((result as { actionType: string }).actionType, "attempts_exhausted");
});

// --- Reviewer outcomes ---

test("approved verdict routes to final_review regardless of round", () => {
  const outcome: ReviewerOutcome = {
    kind: "verdict",
    result: { verdict: "approved", baseSha: "b", headSha: "h", acceptanceCriteriaAssessment: "met", evidenceAssessment: "ok", findings: [], risks: [] },
  };
  assert.deepStrictEqual(routeReviewerOutcome(outcome, LIMITS_ROUNDS_LEFT), { next: "final_review" });
});

test("changes_requested with rounds remaining retries the developer with findings", () => {
  const outcome: ReviewerOutcome = {
    kind: "verdict",
    result: { verdict: "changes_requested", baseSha: "b", headSha: "h", acceptanceCriteriaAssessment: "partial", evidenceAssessment: "ok", findings: [{ fingerprint: "f1", severity: "blocking", title: "T", rationale: "R" }], risks: [] },
  };
  assert.deepStrictEqual(routeReviewerOutcome(outcome, LIMITS_ROUNDS_LEFT), { next: "retry_developer_with_findings" });
});

test("changes_requested at the round limit exhausts attempts", () => {
  const outcome: ReviewerOutcome = {
    kind: "verdict",
    result: { verdict: "changes_requested", baseSha: "b", headSha: "h", acceptanceCriteriaAssessment: "partial", evidenceAssessment: "ok", findings: [], risks: [] },
  };
  const result = routeReviewerOutcome(outcome, LIMITS_AT_LIMIT);
  assert.equal(result.next, "human_action");
  assert.equal((result as { actionType: string }).actionType, "attempts_exhausted");
});

test("escalated with a product scope question routes to product_scope_decision", () => {
  const outcome: ReviewerOutcome = {
    kind: "verdict",
    result: { verdict: "escalated", baseSha: "b", headSha: "h", acceptanceCriteriaAssessment: "unclear", evidenceAssessment: "ok", findings: [], risks: [], productScopeQuestion: "Should deleted users retain their sessions?" },
  };
  const result = routeReviewerOutcome(outcome, LIMITS_ROUNDS_LEFT);
  assert.equal((result as { actionType: string }).actionType, "product_scope_decision");
});

test("escalated without a product scope question routes to policy_escalation", () => {
  const outcome: ReviewerOutcome = {
    kind: "verdict",
    result: { verdict: "escalated", baseSha: "b", headSha: "h", acceptanceCriteriaAssessment: "unclear", evidenceAssessment: "ok", findings: [], risks: [] },
  };
  const result = routeReviewerOutcome(outcome, LIMITS_ROUNDS_LEFT);
  assert.equal((result as { actionType: string }).actionType, "policy_escalation");
});

test("stale review retries the reviewer at the freshly verified head without consuming a round", () => {
  const outcome: ReviewerOutcome = { kind: "stale", currentHeadSha: "new-head" };
  assert.deepStrictEqual(routeReviewerOutcome(outcome, LIMITS_ROUNDS_LEFT), { next: "retry_reviewer_at_new_head", headSha: "new-head" });
});

test("reviewer session_failed escalates rather than silently retrying", () => {
  const outcome: ReviewerOutcome = { kind: "session_failed" };
  const result = routeReviewerOutcome(outcome, LIMITS_ROUNDS_LEFT);
  assert.equal(result.next, "human_action");
  assert.equal((result as { actionType: string }).actionType, "policy_escalation");
});

test("review publish_failed escalates rather than being confused with a code finding", () => {
  const outcome: ReviewerOutcome = { kind: "publish_failed" };
  const result = routeReviewerOutcome(outcome, LIMITS_ROUNDS_LEFT);
  assert.equal(result.next, "human_action");
  assert.equal((result as { actionType: string }).actionType, "policy_escalation");
});
