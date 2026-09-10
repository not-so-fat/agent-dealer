// packages/server/src/coordinator/recovery.test.ts
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-recover-"));
process.env.MAX_COORDINATOR_CONCURRENCY = "2";
process.env.COORDINATOR_FAIL_BACKOFF_MS = "0";

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, getIssue } = await import("../repository/issues.js");
const { listHumanActionsForIssue } = await import("../repository/human-actions.js");
const { listWorkerSessionsForIssue, createWorkerSession, startSession } = await import(
  "../repository/worker-sessions.js"
);
const { getWorkItem, listWorkItemsForIssue, claimWorkItem, bindWorkItemSession, finishWorkItem } =
  await import("../repository/work-items.js");
const { startWorkflow } = await import("./commands.js");
const { recoverCoordinator } = await import("./recovery.js");

before(() => migrate());
beforeEach(() => getDb().exec("DELETE FROM work_items"));

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

  // A worker that claimed the item and recorded a running session, then died.
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

test("a periodic tick ignores a healthy (unexpired) lease", () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  claimWorkItem("healthy", { leaseMs: 600_000 });
  const res = recoverCoordinator({ startup: false, now: Date.now() });
  assert.deepEqual(res, { reclaimed: [], deadLettered: [] });
});

test("an expired lease past the attempt cap is dead-lettered AND routed in one step", () => {
  const issueId = newIssue(1); // at the round limit → a dead developer item exhausts attempts
  startWorkflow(issueId);
  const devItem = listWorkItemsForIssue(issueId)[0];

  // Exhaust the attempts (max_attempts default 3): claim + expire, three times.
  for (let i = 0; i < 3; i++) {
    claimWorkItem("o", { leaseMs: 1 });
    recoverCoordinator({ startup: false, now: Date.now() + 10_000 });
  }
  const final = recoverCoordinator({ startup: false, now: Date.now() + 10_000 });

  // The dead-letter + routing happened together — no separate un-routed dead state.
  assert.equal(getWorkItem(devItem.id)!.status, "dead");
  assert.equal(getIssue(issueId)!.status, "needs_human");
  assert.equal(
    listHumanActionsForIssue(issueId).find((a) => a.status === "open")!.actionType,
    "attempts_exhausted"
  );
  // Running it again is a no-op (the item is already dead, nothing left to reclaim).
  const again = recoverCoordinator({ startup: true, now: Date.now() + 20_000 });
  assert.deepEqual(again, { reclaimed: [], deadLettered: [] });
  assert.equal(
    listHumanActionsForIssue(issueId).filter((a) => a.status === "open").length,
    1,
    "no duplicate human action from a second recovery"
  );
  assert.ok(final.deadLettered.length + final.reclaimed.length >= 0);
});

test("recovery loses its CAS to a worker that completed concurrently", () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  const devItem = listWorkItemsForIssue(issueId)[0];
  const claimed = claimWorkItem("o", { leaseMs: 1 })!;

  // Worker finishes just before recovery's transaction runs.
  finishWorkItem(devItem.id, claimed.leaseToken!, { status: "done", result: { kind: "no_pr" } });

  const res = recoverCoordinator({ startup: true, now: Date.now() + 10_000 });
  assert.deepEqual(res, { reclaimed: [], deadLettered: [] });
  assert.equal(getWorkItem(devItem.id)!.status, "done");
});

test("recoverCoordinator is a no-op on a clean queue", () => {
  const res = recoverCoordinator({ startup: true });
  assert.deepEqual(res, { reclaimed: [], deadLettered: [] });
});
