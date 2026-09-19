// packages/server/src/coordinator/branch-tip-status.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyBranchTipStatus } from "./branch-tip-status.js";

test("NOT-148: empty tip after a failed attempt flags restart risk", () => {
  const status = classifyBranchTipStatus({
    branch: "issue-x",
    progress: { state: "empty", branch: "issue-x" },
    hadFailedAttempt: true,
  });
  assert.equal(status.commitsAhead, 0);
  assert.equal(status.tipLabel, "no tip yet");
  assert.equal(status.restartRisk, true);
});

test("NOT-148: empty tip with no prior failure is not restart risk yet", () => {
  const status = classifyBranchTipStatus({
    branch: "issue-x",
    progress: { state: "absent", branch: "issue-x" },
    hadFailedAttempt: false,
  });
  assert.equal(status.tipLabel, "no tip yet");
  assert.equal(status.restartRisk, false);
});

test("NOT-148: tip with commits ahead is not restart risk even after failures", () => {
  const status = classifyBranchTipStatus({
    branch: "issue-x",
    progress: { state: "unpushed", branch: "issue-x", ahead: 2, unpushed: 2 },
    hadFailedAttempt: true,
  });
  assert.equal(status.commitsAhead, 2);
  assert.equal(status.tipLabel, "2 ahead");
  assert.equal(status.restartRisk, false);
});

test("NOT-148: unknown progress after failure still flags restart risk conservatively", () => {
  const status = classifyBranchTipStatus({
    branch: "issue-x",
    progress: null,
    hadFailedAttempt: true,
  });
  assert.equal(status.state, "unknown");
  assert.equal(status.tipLabel, "unknown");
  assert.equal(status.restartRisk, true);
});
