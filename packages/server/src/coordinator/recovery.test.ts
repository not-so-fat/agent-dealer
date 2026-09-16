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
const {
  getWorkItem,
  listWorkItemsForIssue,
  claimWorkItem,
  bindWorkItemSession,
  finishWorkItem,
  refreshHeartbeat,
} = await import("../repository/work-items.js");
const { startWorkflow } = await import("./commands.js");
const { recoverCoordinator } = await import("./recovery.js");

const FUTURE = () => Date.now() + 3_600_000; // a clock well past any test lease

before(() => migrate());
beforeEach(() => getDb().exec("DELETE FROM work_items"));

function newIssue(maxReviewRounds = 3, maxInfraAttempts = 3): string {
  return createIssue({
    title: "Recover me",
    acceptanceCriteria: "It works",
    repo: "/repo",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds,
    maxInfraAttempts,
    source: "manual",
  }).id;
}

test("recovery requeues an expired orphaned lease and fails its running session", async () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  const devItem = listWorkItemsForIssue(issueId).find((i) => i.kind === "developer")!;

  const claimed = claimWorkItem("crashed", { leaseMs: 60_000 })!;
  const session = createWorkerSession({
    issueId,
    role: "developer",
    round: 1,
    agentId: BUILTIN_AGENT_CLAUDE_ID,
    runtime: null,
  });
  startSession(session.id);
  assert.equal(bindWorkItemSession(devItem.id, session.id, claimed.leaseToken!), true);

  assert.equal(getWorkItem(devItem.id)!.status, "leased");
  assert.equal(listWorkerSessionsForIssue(issueId)[0].status, "running");

  const res = await recoverCoordinator({ now: FUTURE() });
  assert.deepEqual(res.reclaimed, [devItem.id]);
  assert.equal(getWorkItem(devItem.id)!.status, "pending");
  assert.equal(listWorkerSessionsForIssue(issueId)[0].status, "failed");

  // NOT-113: soft reclaim emits worker.failed with the presumed-dead reason on the timeline.
  const { listWorkflowEventsForIssue } = await import("../repository/workflow-events.js");
  const failed = listWorkflowEventsForIssue(issueId).filter((e) => e.type === "worker.failed");
  assert.equal(failed.length, 1);
  const payload = JSON.parse(failed[0]!.payloadJson!) as { reason?: string };
  assert.match(payload.reason ?? "", /presumed dead/);
  assert.match(listWorkerSessionsForIssue(issueId)[0].errorJson ?? "", /presumed dead/);
});

test("recovery ignores a lease that has not expired", async () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  claimWorkItem("healthy", { leaseMs: 600_000 });
  assert.deepEqual(await recoverCoordinator({ now: Date.now() }), { reclaimed: [], deadLettered: [], deferredForCap: [], heldAlive: [], heldAcrossClockJump: [], autoMergesFinalized: [] });
});

test("recovery leaves a lease alone when a heartbeat renewed it after the snapshot", async () => {
  // Regression for the reviewer's "recovery can reclaim a freshly renewed lease".
  const issueId = newIssue();
  startWorkflow(issueId);
  const devItem = listWorkItemsForIssue(issueId)[0];
  const claimed = claimWorkItem("racing", { leaseMs: 5 })!;

  // recovery's snapshot sees the lease as expired…
  // …but before its CAS runs, the worker heartbeats and renews the lease:
  refreshHeartbeat(devItem.id, claimed.leaseToken!, { leaseMs: 600_000 });

  const res = await recoverCoordinator({ now: Date.now() + 1_000 });
  assert.deepEqual(res, { reclaimed: [], deadLettered: [], deferredForCap: [], heldAlive: [], heldAcrossClockJump: [], autoMergesFinalized: [] });
  assert.equal(getWorkItem(devItem.id)!.status, "leased");
});

test("an expired lease past the attempt cap is dead-lettered AND routed in one step", async () => {
  // A dead-lettered developer work item routes as an infra failure (session_failed), not a
  // review-round spend — pin maxInfraAttempts to 0 so the very first dead-letter escalates,
  // matching this test's "one step" intent.
  const issueId = newIssue(3, 0);
  startWorkflow(issueId);
  const devItem = listWorkItemsForIssue(issueId)[0];

  // Exhaust the work item's own lease-crash attempts (max_attempts default 3): claim + expire, three times.
  for (let i = 0; i < 3; i++) {
    claimWorkItem("o", { leaseMs: 1 });
    await recoverCoordinator({ now: FUTURE() });
  }

  assert.equal(getWorkItem(devItem.id)!.status, "dead");
  assert.equal(getIssue(issueId)!.status, "needs_human");
  assert.equal(
    listHumanActionsForIssue(issueId).find((a) => a.status === "open")!.actionType,
    "policy_escalation"
  );

  // NOT-113: dead-letter path puts presumed-dead on worker.failed timeline payload.
  const { listWorkflowEventsForIssue } = await import("../repository/workflow-events.js");
  const failed = listWorkflowEventsForIssue(issueId).filter((e) => e.type === "worker.failed");
  assert.ok(failed.length >= 1);
  const last = JSON.parse(failed[failed.length - 1]!.payloadJson!) as { reason?: string };
  assert.match(last.reason ?? "", /presumed dead/);

  // A second recovery pass is a no-op — the item is already dead, nothing to reclaim.
  assert.deepEqual(await recoverCoordinator({ now: FUTURE() }), { reclaimed: [], deadLettered: [], deferredForCap: [], heldAlive: [], heldAcrossClockJump: [], autoMergesFinalized: [] });
  assert.equal(
    listHumanActionsForIssue(issueId).filter((a) => a.status === "open").length,
    1,
    "no duplicate human action from a second recovery"
  );
});

test("recovery loses its CAS to a worker that completed concurrently", async () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  const devItem = listWorkItemsForIssue(issueId)[0];
  const claimed = claimWorkItem("o", { leaseMs: 1 })!;

  // Worker finishes just before recovery's transaction runs.
  finishWorkItem(devItem.id, claimed.leaseToken!, { status: "done", result: { kind: "no_pr" } });

  assert.deepEqual(await recoverCoordinator({ now: FUTURE() }), { reclaimed: [], deadLettered: [], deferredForCap: [], heldAlive: [], heldAcrossClockJump: [], autoMergesFinalized: [] });
  assert.equal(getWorkItem(devItem.id)!.status, "done");
});

test("an expired lease on a usage-capped runtime is deferred, not dead-lettered (NOT-111 recovery gap)", async () => {
  const { recordRuntimeAvailability, clearAllRuntimeAvailability } = await import(
    "../repository/runtime-availability.js"
  );
  clearAllRuntimeAvailability();
  try {
    // maxInfraAttempts 0 means a normal expired lease would dead-letter on its first
    // reclaim — proving the cap check pre-empts that, not just skips a retry.
    const issueId = newIssue(3, 0);
    startWorkflow(issueId);
    const devItem = listWorkItemsForIssue(issueId)[0];

    const claimed = claimWorkItem("crashed", { leaseMs: 1 })!;
    const session = createWorkerSession({
      issueId,
      role: "developer",
      round: 1,
      agentId: BUILTIN_AGENT_CLAUDE_ID,
      runtime: "claude_code",
    });
    startSession(session.id);
    assert.equal(bindWorkItemSession(devItem.id, session.id, claimed.leaseToken!), true);

    const until = new Date(Date.now() + 3_600_000).toISOString();
    recordRuntimeAvailability({
      runtime: "claude_code",
      unavailableUntil: until,
      reason: "claude_code usage capped — plan limit rejected",
    });

    const res = await recoverCoordinator({ now: FUTURE() });
    assert.deepEqual(res, {
      reclaimed: [],
      deadLettered: [],
      deferredForCap: [devItem.id],
      heldAlive: [],
      heldAcrossClockJump: [],
      autoMergesFinalized: [],
    });
    assert.equal(getWorkItem(devItem.id)!.status, "pending");
    assert.equal(getWorkItem(devItem.id)!.attemptCount, 0, "claim's attempt bump is reverted, like a live cap deferral");
    assert.equal(getWorkItem(devItem.id)!.availableAt, until);
    assert.equal(listWorkerSessionsForIssue(issueId)[0].status, "failed");
    assert.equal(
      listHumanActionsForIssue(issueId).filter((a) => a.status === "open").length,
      0,
      "deferred, not routed to a human action"
    );
  } finally {
    clearAllRuntimeAvailability();
  }
});

test("recoverCoordinator is a no-op on a clean queue", async () => {
  assert.deepEqual(await recoverCoordinator({ now: FUTURE() }), { reclaimed: [], deadLettered: [], deferredForCap: [], heldAlive: [], heldAcrossClockJump: [], autoMergesFinalized: [] });
});
