// packages/server/src/coordinator/projection.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ISSUE_STATUS_TRANSITIONS, type IssueStatus } from "@agent-dealer/shared";
import { routeDeveloperOutcome, routeReviewerOutcome } from "./routing.js";
import { projectDeveloperRoute, projectReviewerRoute } from "./projection.js";
import type { ReviewerResult } from "./reviewer-result.js";

const ROUNDS_LEFT = { currentRound: 1, maxReviewRounds: 3 };
const AT_LIMIT = { currentRound: 3, maxReviewRounds: 3 };
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

test("every developer projection lands on a legal issue transition", () => {
  for (const from of ["developing", "repairing"] as IssueStatus[]) {
    for (const outcome of [
      { kind: "clean_handoff", headSha: "h", baseSha: "b", prNumber: 1, prUrl: "u" },
      { kind: "no_pr" },
      { kind: "session_failed" },
      { kind: "dirty_worktree" },
    ] as const) {
      for (const limits of [ROUNDS_LEFT, AT_LIMIT]) {
        const route = routeDeveloperOutcome(outcome, limits);
        const { projection, effect } = projectDeveloperRoute(route, from, limits.currentRound);
        assertLegal(from, projection.issueStatus);
        assert.ok(["enqueue", "human_action", "none"].includes(effect.kind));
      }
    }
  }
});

test("every reviewer projection lands on a legal issue transition", () => {
  const outcomes = [
    { kind: "verdict", result: verdict("approved") },
    { kind: "verdict", result: verdict("changes_requested") },
    { kind: "verdict", result: verdict("escalated") },
    { kind: "verdict", result: verdict("escalated", "Which behavior is correct?") },
    { kind: "stale", currentHeadSha: "new" },
    { kind: "session_failed" },
    { kind: "publish_failed" },
  ] as const;
  for (const outcome of outcomes) {
    for (const limits of [ROUNDS_LEFT, AT_LIMIT]) {
      const route = routeReviewerOutcome(outcome, limits);
      const { projection } = projectReviewerRoute(route, limits.currentRound, outcome.kind === "verdict");
      assertLegal("reviewing", projection.issueStatus);
    }
  }
});

test("only a verdict carries review.submitted; a failed session does not", () => {
  const failRoute = routeReviewerOutcome({ kind: "session_failed" }, ROUNDS_LEFT);
  const failed = projectReviewerRoute(failRoute, 1, false);
  assert.ok(!failed.projection.events.includes("review.submitted"));

  const okRoute = routeReviewerOutcome({ kind: "verdict", result: verdict("changes_requested") }, ROUNDS_LEFT);
  const ok = projectReviewerRoute(okRoute, 1, true);
  assert.ok(ok.projection.events.includes("review.submitted"));
});

test("spawn_reviewer advances no round; a repair round does", () => {
  const spawn = projectDeveloperRoute(
    routeDeveloperOutcome({ kind: "clean_handoff", headSha: "h", baseSha: "b", prNumber: 1, prUrl: "u" }, ROUNDS_LEFT),
    "developing",
    1
  );
  assert.equal(spawn.advanceRound, false);

  const repair = projectReviewerRoute(
    routeReviewerOutcome({ kind: "verdict", result: verdict("changes_requested") }, ROUNDS_LEFT),
    1,
    true
  );
  assert.equal(repair.advanceRound, true);
});
