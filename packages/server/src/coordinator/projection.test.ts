// packages/server/src/coordinator/projection.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ISSUE_STATUS_TRANSITIONS, type IssueStatus } from "@agent-dealer/shared";
import { routeDeveloperOutcome, routeReviewerOutcome, type RouteLimits } from "./routing.js";
import { projectDeveloperRoute, projectReviewerRoute } from "./projection.js";
import type { ReviewerResult } from "./reviewer-result.js";

const REVIEW_ROUNDS_LEFT: RouteLimits = { currentRound: 1, maxReviewRounds: 3, infraAttempts: 0, maxInfraAttempts: 3 };
const REVIEW_AT_LIMIT: RouteLimits = { currentRound: 3, maxReviewRounds: 3, infraAttempts: 0, maxInfraAttempts: 3 };
const INFRA_AT_LIMIT: RouteLimits = { currentRound: 1, maxReviewRounds: 3, infraAttempts: 3, maxInfraAttempts: 3 };
const ALL_LIMITS = [REVIEW_ROUNDS_LEFT, REVIEW_AT_LIMIT, INFRA_AT_LIMIT];
const PINNED_HEAD = "pinned-head-sha";

const verdict = (v: ReviewerResult["verdict"], productScopeQuestion?: string): ReviewerResult => ({
  verdict: v,
  baseSha: "b",
  headSha: "h",
  acceptanceCriteriaAssessment: "",
  evidenceAssessment: "",
  findings: [],
  risks: [],
  ...(productScopeQuestion ? { productScopeQuestion } : {}),
});

function assertLegal(from: IssueStatus, to: IssueStatus): void {
  assert.ok(
    from === to || ISSUE_STATUS_TRANSITIONS[from].includes(to),
    `${from} → ${to} must be a legal issue transition`
  );
}

test("every developer projection lands on a legal issue transition and always has a next effect", () => {
  for (const from of ["developing", "repairing"] as IssueStatus[]) {
    for (const outcome of [
      { kind: "clean_handoff", branch: "br", headSha: "h", baseSha: "b", prNumber: 1, prUrl: "u" },
      { kind: "no_pr" },
      { kind: "session_failed" },
      { kind: "timed_out" },
      { kind: "checks_failed" },
      { kind: "adapter_failure", reason: "boom" },
      { kind: "deck_failure", reason: "preflight failed: missing playbook" },
      {
        kind: "adapter_failure",
        reason: "Branch already pushed (br); only draft PR create failed: boom",
        publishable: { branch: "br" },
      },
      { kind: "dirty_worktree" },
      { kind: "unpushed_commit", reason: "non-fast-forward" },
      { kind: "worktree_conflict", path: "/data/worktrees/old-developer", reason: "collision", recoveryCommands: ["git status"] as string[] },
      {
        kind: "live_owner",
        path: "/data/worktrees/old-developer",
        ownerSessionId: "sess-old",
        reason: "still in use by a live predecessor",
      },
    ] as const) {
      for (const limits of ALL_LIMITS) {
        const route = routeDeveloperOutcome(outcome, limits);
        const { projection, effect } = projectDeveloperRoute(route, from, limits.currentRound);
        assertLegal(from, projection.issueStatus);
        // Invariant (NOT-63 acceptance criterion): no route ever leaves an issue with
        // neither a next work item nor a human action.
        assert.ok(
        ["enqueue", "human_action", "auto_merge"].includes(effect.kind),
        `${outcome.kind} at ${JSON.stringify(limits)} produced effect.kind="${effect.kind}"`
      );
      }
    }
  }
});

test("every reviewer projection lands on a legal issue transition and always has a next effect", () => {
  const outcomes = [
    { kind: "verdict", result: verdict("approved") },
    { kind: "verdict", result: verdict("changes_requested") },
    { kind: "verdict", result: verdict("escalated") },
    { kind: "verdict", result: verdict("escalated", "Which behavior is correct?") },
    { kind: "stale", currentHeadSha: "new" },
    { kind: "session_failed" },
    { kind: "deck_failure", reason: "preflight failed: missing playbook" },
    { kind: "publish_failed" },
  ] as const;
  for (const outcome of outcomes) {
    for (const limits of ALL_LIMITS) {
      const route = routeReviewerOutcome(outcome, limits, PINNED_HEAD);
      const { projection, effect } = projectReviewerRoute(route, limits.currentRound, outcome.kind === "verdict");
      assertLegal("reviewing", projection.issueStatus);
      assert.ok(
        ["enqueue", "human_action", "auto_merge"].includes(effect.kind),
        `${outcome.kind} at ${JSON.stringify(limits)} produced effect.kind="${effect.kind}"`
      );
    }
  }
});

test("only a verdict carries review.submitted; a failed session does not", () => {
  const failRoute = routeReviewerOutcome({ kind: "session_failed" }, REVIEW_ROUNDS_LEFT, PINNED_HEAD);
  const failed = projectReviewerRoute(failRoute, 1, false);
  assert.ok(!failed.projection.events.includes("review.submitted"));

  const okRoute = routeReviewerOutcome({ kind: "verdict", result: verdict("changes_requested") }, REVIEW_ROUNDS_LEFT, PINNED_HEAD);
  const ok = projectReviewerRoute(okRoute, 1, true);
  assert.ok(ok.projection.events.includes("review.submitted"));
});

test("spawn_reviewer advances no budget; a genuine repair round spends the review budget", () => {
  const spawn = projectDeveloperRoute(
    routeDeveloperOutcome({ kind: "clean_handoff", branch: "br", headSha: "h", baseSha: "b", prNumber: 1, prUrl: "u" }, REVIEW_ROUNDS_LEFT),
    "developing",
    1
  );
  assert.equal(spawn.advance, "none");

  const repair = projectReviewerRoute(
    routeReviewerOutcome({ kind: "verdict", result: verdict("changes_requested") }, REVIEW_ROUNDS_LEFT, PINNED_HEAD),
    1,
    true
  );
  assert.equal(repair.advance, "review");
});

test("infra-class retries — including a stale re-review — spend the infra budget, never the review-round budget", () => {
  const devRetry = projectDeveloperRoute(
    routeDeveloperOutcome({ kind: "session_failed" }, REVIEW_ROUNDS_LEFT),
    "developing",
    1
  );
  assert.equal(devRetry.advance, "infra");
  assert.deepStrictEqual(devRetry.effect, { kind: "enqueue", workItem: "developer", retryReason: "Developer session failed or crashed." });

  const publishRetry = projectDeveloperRoute(
    routeDeveloperOutcome(
      {
        kind: "adapter_failure",
        reason: "Branch already pushed (br); only draft PR create failed: x",
        publishable: { branch: "br" },
      },
      REVIEW_ROUNDS_LEFT
    ),
    "developing",
    1
  );
  assert.equal(publishRetry.advance, "infra");
  assert.deepStrictEqual(publishRetry.effect, {
    kind: "enqueue",
    workItem: "developer",
    retryReason: "Git/GitHub verification failed: Branch already pushed (br); only draft PR create failed: x",
    publishOnly: true,
    branch: "br",
  });
  assert.match(publishRetry.projection.currentIntent, /Retrying GitHub publish/);

  const reviewerRetry = projectReviewerRoute(
    routeReviewerOutcome({ kind: "publish_failed" }, REVIEW_ROUNDS_LEFT, PINNED_HEAD),
    1,
    false
  );
  assert.equal(reviewerRetry.advance, "infra");
  // The infra retry re-pins the SAME head — it is not a "the head moved" stale re-review.
  assert.deepStrictEqual(reviewerRetry.effect, { kind: "enqueue", workItem: "reviewer", atHeadSha: PINNED_HEAD });

  // A stale re-review (the head genuinely moved) is also bounded on the infra budget —
  // an unbounded chain of these could otherwise spawn reviewer sessions indefinitely.
  const stale = projectReviewerRoute(
    routeReviewerOutcome({ kind: "stale", currentHeadSha: "new" }, REVIEW_ROUNDS_LEFT, PINNED_HEAD),
    1,
    false
  );
  assert.equal(stale.advance, "infra");
});

test("NOT-147: empty-tip no-progress escalation projects to needs_human without spending infra budget", () => {
  const INFRA_ATTEMPTS_LEFT: RouteLimits = {
    currentRound: 1,
    maxReviewRounds: 3,
    infraAttempts: 1,
    maxInfraAttempts: 3,
  };
  const route = routeDeveloperOutcome(
    {
      kind: "timed_out",
      commitsAhead: 0,
      reason: "Developer session timed out.",
      worktreePath: "/data/worktrees/s-dev-developer",
      logPath: "/data/logs/s-dev.log",
    },
    INFRA_ATTEMPTS_LEFT
  );
  assert.equal(route.next, "human_action");
  const { projection, effect, advance } = projectDeveloperRoute(route, "developing", 1);
  assert.equal(projection.issueStatus, "needs_human");
  assert.equal(projection.currentOwner, "human");
  assert.equal(advance, "none", "escalation must not burn another infra attempt");
  assert.equal(effect.kind, "human_action");
  if (effect.kind === "human_action") {
    assert.equal(effect.actionType, "policy_escalation");
    assert.match(effect.reason, /stuck: no commits after 2 timeouts\/crashes/i);
  }
  assertLegal("developing", projection.issueStatus);
});
