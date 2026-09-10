// packages/server/src/coordinator/recovery.test.ts
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-recover-"));
process.env.MAX_COORDINATOR_CONCURRENCY = "2";

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, getIssue } = await import("../repository/issues.js");
const { listHumanActionsForIssue } = await import("../repository/human-actions.js");
const { listWorkerSessionsForIssue, createWorkerSession, startSession } = await import(
  "../repository/worker-sessions.js"
);
const { getWorkItem, listWorkItemsForIssue, claimWorkItem, bindWorkItemSession } = await import(
  "../repository/work-items.js"
);
const { startWorkflow } = await import("./commands.js");
const { resetEffectHandlers } = await import("./effect-registry.js");
const { recoverCoordinator } = await import("./recovery.js");

before(() => migrate());
beforeEach(() => {
  getDb().exec("DELETE FROM work_items");
  resetEffectHandlers();
});

function newIssue(maxReviewRounds = 3): string {
  return createIssue({
    title: "Recover me",
    acceptanceCriteria: "It works",
    repo: "/repo",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds,
    source: "manual",
  }).id;
}

test("startup recovery requeues an orphaned lease and fails its running session", () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  const devItem = listWorkItemsForIssue(issueId).find((i) => i.kind === "developer")!;

  // Simulate a worker that claimed the item and recorded a running session, then died.
  claimWorkItem("crashed", { leaseMs: 600_000 });
  const session = createWorkerSession({
    issueId,
    role: "developer",
    round: 1,
    agentId: BUILTIN_AGENT_CLAUDE_ID,
    runtime: null,
  });
  startSession(session.id);
  bindWorkItemSession(devItem.id, session.id);

  assert.equal(getWorkItem(devItem.id)!.status, "leased");
  assert.equal(listWorkerSessionsForIssue(issueId)[0].status, "running");

  const res = recoverCoordinator({ startup: true });
  assert.deepEqual(res.reclaimed, [devItem.id]);
  assert.equal(getWorkItem(devItem.id)!.status, "pending");
  assert.equal(listWorkerSessionsForIssue(issueId)[0].status, "failed");
});

test("an expired lease past the attempt cap is dead-lettered through the failure route", () => {
  const issueId = newIssue(1); // at the round limit → a dead developer item exhausts attempts
  startWorkflow(issueId);
  const devItem = listWorkItemsForIssue(issueId)[0];
  // Exhaust the attempts: max_attempts default 3, so 3 claims then reclaim → dead.
  claimWorkItem("o", { leaseMs: 1 });
  recoverCoordinator({ startup: false, now: Date.now() + 10_000 }); // attempt 1 → requeue
  claimWorkItem("o", { leaseMs: 1 });
  recoverCoordinator({ startup: false, now: Date.now() + 10_000 }); // attempt 2 → requeue
  claimWorkItem("o", { leaseMs: 1 });
  const res = recoverCoordinator({ startup: false, now: Date.now() + 10_000 }); // attempt 3 → dead

  assert.deepEqual(res.deadLettered, [devItem.id]);
  assert.equal(getWorkItem(devItem.id)!.status, "dead");
  assert.equal(getIssue(issueId)!.status, "needs_human");
  const open = listHumanActionsForIssue(issueId).find((a) => a.status === "open")!;
  assert.equal(open.actionType, "attempts_exhausted");
});

test("recoverCoordinator is a no-op on a clean queue", () => {
  const res = recoverCoordinator({ startup: true });
  assert.deepEqual(res, { reclaimed: [], deadLettered: [] });
});
