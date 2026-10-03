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
const { createIssue, getIssue, transitionIssue } = await import("../repository/issues.js");
const { getActiveWorkflowInstance } = await import("../repository/workflow-events.js");
const { listHumanActionsForIssue } = await import("../repository/human-actions.js");
const { listWorkerSessionsForIssue, createWorkerSession, startSession } = await import(
  "../repository/worker-sessions.js"
);
const {
  getWorkItem,
  listWorkItemsForIssue,
  claimWorkItem,
  bindWorkItemSession,
  enqueueWorkItem,
  finishWorkItem,
  refreshHeartbeat} = await import("../repository/work-items.js");
const { startWorkflow } = await import("./commands.js");
const { recoverCoordinator } = await import("./recovery.js");

const FUTURE = () => Date.now() + 3_600_000; // a clock well past any test lease

before(() => migrate());
beforeEach(() => getDb().exec("DELETE FROM work_items"));

function newIssue(maxReviewRounds = 3, maxInfraAttempts = 3): string {
  return createIssue({
    title: "Recover me",
    acceptanceCriteria: "It works",
    repo: "acme/app",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds,
    maxInfraAttempts,
    source: "manual"}).id;
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
    runtime: null});
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

test("NOT-171: a reclaim records a coordinator_crash cause without touching errorJson", async () => {
  const { listFailureCausesForSession } = await import("../repository/failure-causes.js");
  const { PRESUMED_DEAD_REASON } = await import("./failure-reason.js");
  const issueId = newIssue();
  startWorkflow(issueId);
  const devItem = listWorkItemsForIssue(issueId).find((i) => i.kind === "developer")!;

  const claimed = claimWorkItem("crashed", { leaseMs: 60_000 })!;
  const session = createWorkerSession({
    issueId,
    role: "developer",
    round: 1,
    agentId: BUILTIN_AGENT_CLAUDE_ID,
    runtime: null});
  startSession(session.id);
  assert.equal(bindWorkItemSession(devItem.id, session.id, claimed.leaseToken!), true);

  const res = await recoverCoordinator({ now: FUTURE() });
  assert.deepEqual(res.reclaimed, [devItem.id]);

  // Raw evidence untouched: same presumed-dead errorJson recovery always wrote.
  assert.equal(listWorkerSessionsForIssue(issueId)[0].errorJson, JSON.stringify({ reason: PRESUMED_DEAD_REASON }));
  const causes = listFailureCausesForSession(session.id);
  assert.ok(causes.length >= 1);
  const prime = causes.find((c) => c.primary)!;
  assert.equal(prime.code, "coordinator_crash");
  assert.equal(prime.domain, "infrastructure");
  assert.equal(prime.quality, "exact");
  assert.match(prime.rawReason, /presumed dead/);
});

test("NOT-171: a reclaim over a host-sleep window records host_sleep_liveness", async () => {
  const { listFailureCausesForSession } = await import("../repository/failure-causes.js");
  const { appendWorkflowEvent, getActiveWorkflowInstance } = await import("../repository/workflow-events.js");
  const issueId = newIssue();
  startWorkflow(issueId);
  const devItem = listWorkItemsForIssue(issueId).find((i) => i.kind === "developer")!;

  const claimed = claimWorkItem("crashed", { leaseMs: 60_000 })!;
  const session = createWorkerSession({
    issueId,
    role: "developer",
    round: 1,
    agentId: BUILTIN_AGENT_CLAUDE_ID,
    runtime: null});
  startSession(session.id);
  assert.equal(bindWorkItemSession(devItem.id, session.id, claimed.leaseToken!), true);

  // Suspend evidence predates the reclaim; clockJump null forces plain reclaim.
  const instance = getActiveWorkflowInstance(issueId)!;
  assert.ok(instance);
  appendWorkflowEvent({
    issueId,
    workflowInstanceId: instance.id,
    workerSessionId: session.id,
    type: "host.suspended",
    actorType: "developer",
    stage: "developing",
    round: 1,
    payload: {}});

  const res = await recoverCoordinator({ now: FUTURE(), clockJump: null });
  assert.deepEqual(res.reclaimed, [devItem.id]);
  const prime = listFailureCausesForSession(session.id).find((c) => c.primary)!;
  assert.equal(prime.code, "host_sleep_liveness");
  assert.equal(prime.domain, "infrastructure");
});

test("recovery ignores a lease that has not expired", async () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  claimWorkItem("healthy", { leaseMs: 600_000 });
  assert.deepEqual(await recoverCoordinator({ now: Date.now() }), { reclaimed: [], republished: [], deadLettered: [], deferredForCap: [], heldAlive: [], heldAliveExpired: [], unverifiedOrphans: [], heldAcrossClockJump: [], autoMergesFinalized: [], strandedReviewingRecovered: [] });
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
  assert.deepEqual(res, { reclaimed: [], republished: [], deadLettered: [], deferredForCap: [], heldAlive: [], heldAliveExpired: [], unverifiedOrphans: [], heldAcrossClockJump: [], autoMergesFinalized: [], strandedReviewingRecovered: [] });
  assert.equal(getWorkItem(devItem.id)!.status, "leased");
});

test("an expired lease past the infra-attempt limit is dead-lettered AND routed in one step", async () => {
  // A dead-lettered developer work item routes as an infra failure (session_failed), not a
  // review-round spend — pin maxInfraAttempts to 0 so the very first reclaim has no infra
  // budget to spend and escalates, matching this test's "one step" intent. NOT-128: the
  // *infra* budget is what bounds the reclaim; max_attempts (3, untouched here) is not.
  const issueId = newIssue(3, 0);
  startWorkflow(issueId);
  const devItem = listWorkItemsForIssue(issueId)[0];

  claimWorkItem("o", { leaseMs: 1 });
  await recoverCoordinator({ now: FUTURE() });

  assert.equal(getWorkItem(devItem.id)!.status, "dead");
  assert.equal(getWorkItem(devItem.id)!.attemptCount, 1, "one claim — the developer budget is nowhere near spent");
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
  assert.deepEqual(await recoverCoordinator({ now: FUTURE() }), { reclaimed: [], republished: [], deadLettered: [], deferredForCap: [], heldAlive: [], heldAliveExpired: [], unverifiedOrphans: [], heldAcrossClockJump: [], autoMergesFinalized: [], strandedReviewingRecovered: [] });
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

  assert.deepEqual(await recoverCoordinator({ now: FUTURE() }), { reclaimed: [], republished: [], deadLettered: [], deferredForCap: [], heldAlive: [], heldAliveExpired: [], unverifiedOrphans: [], heldAcrossClockJump: [], autoMergesFinalized: [], strandedReviewingRecovered: [] });
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
      runtime: "claude_code"});
    startSession(session.id);
    assert.equal(bindWorkItemSession(devItem.id, session.id, claimed.leaseToken!), true);

    const until = new Date(Date.now() + 3_600_000).toISOString();
    recordRuntimeAvailability({
      runtime: "claude_code",
      unavailableUntil: until,
      reason: "claude_code usage capped — plan limit rejected"});

    const res = await recoverCoordinator({ now: FUTURE() });
    assert.deepEqual(res, {
      reclaimed: [],
      republished: [],
      deadLettered: [],
      deferredForCap: [devItem.id],
      heldAlive: [],
      heldAliveExpired: [],
      unverifiedOrphans: [],
      heldAcrossClockJump: [],
      autoMergesFinalized: [],
      strandedReviewingRecovered: []});
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
  assert.deepEqual(await recoverCoordinator({ now: FUTURE() }), { reclaimed: [], republished: [], deadLettered: [], deferredForCap: [], heldAlive: [], heldAliveExpired: [], unverifiedOrphans: [], heldAcrossClockJump: [], autoMergesFinalized: [], strandedReviewingRecovered: [] });
});

/** Settles an issue's developer round so the test can park the issue in `reviewing`. */
function settleDeveloper(issueId: string): void {
  const dev = claimWorkItem(`seed-${issueId}`, { leaseMs: 600_000 })!;
  assert.equal(dev.issueId, issueId);
  assert.equal(finishWorkItem(dev.id, dev.leaseToken!, { status: "done", result: { kind: "no_pr" } })!.status, "done");
}

test("NOT-333: recovery re-enqueues exactly once for an issue stranded in reviewing, and is a no-op otherwise", async () => {
  // The NOT-200 stranding: reviewing, open instance, head pinned, but every work
  // item terminal — the resume round's reviewer enqueue deduped against the done row.
  const strandedId = newIssue();
  startWorkflow(strandedId);
  settleDeveloper(strandedId);
  transitionIssue(strandedId, "reviewing", { headSha: "abc123" });
  const instance = getActiveWorkflowInstance(strandedId)!;
  const oldReviewer = enqueueWorkItem({
    issueId: strandedId,
    workflowInstanceId: instance.id,
    kind: "reviewer",
    round: 1,
    payload: { inputSha: "abc123" },
    idempotencyKey: `${instance.id}:reviewer:1:abc123`,
  });
  const leasedOld = claimWorkItem(`seed-rev-${strandedId}`, { leaseMs: 600_000 })!;
  assert.equal(leasedOld.id, oldReviewer.id);
  assert.equal(finishWorkItem(oldReviewer.id, leasedOld.leaseToken!, { status: "done", result: { kind: "verdict" } })!.status, "done");

  // A healthy issue: reviewing WITH a pending reviewer must be left alone.
  const healthyId = newIssue();
  startWorkflow(healthyId);
  settleDeveloper(healthyId);
  transitionIssue(healthyId, "reviewing", { headSha: "def456" });
  const healthyInstance = getActiveWorkflowInstance(healthyId)!;
  const healthyReviewer = enqueueWorkItem({
    issueId: healthyId,
    workflowInstanceId: healthyInstance.id,
    kind: "reviewer",
    round: 1,
    payload: { inputSha: "def456" },
    idempotencyKey: `${healthyInstance.id}:reviewer:1:def456`,
  });

  // First tick recovers the stranded issue exactly once.
  const first = await recoverCoordinator({ now: Date.now() });
  assert.equal(first.strandedReviewingRecovered.length, 1);
  const recovered = getWorkItem(first.strandedReviewingRecovered[0])!;
  assert.equal(recovered.issueId, strandedId);
  assert.equal(recovered.kind, "reviewer");
  assert.equal(recovered.status, "pending");
  assert.notEqual(recovered.id, oldReviewer.id);
  assert.equal(JSON.parse(recovered.payloadJson!).inputSha, "abc123");

  // ...and touches nothing else.
  assert.equal(listWorkItemsForIssue(healthyId).length, 2);
  assert.equal(getWorkItem(healthyReviewer.id)!.status, "pending");

  // Second tick is a no-op — the fresh pending row bounds the guard, no loop.
  const second = await recoverCoordinator({ now: Date.now() });
  assert.deepEqual(second.strandedReviewingRecovered, []);
  assert.equal(listWorkItemsForIssue(strandedId).filter((i) => i.kind === "reviewer").length, 2);
  assert.equal(
    listWorkItemsForIssue(strandedId).filter((i) => i.kind === "reviewer" && i.status === "pending").length,
    1
  );
});
