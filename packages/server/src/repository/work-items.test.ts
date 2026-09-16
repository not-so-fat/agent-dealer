// packages/server/src/repository/work-items.test.ts
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-workitems-"));

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("./issues.js");
const { createWorkerSession } = await import("./worker-sessions.js");
const { startWorkflowInstance } = await import("./workflow-events.js");
const {
  enqueueWorkItem,
  claimWorkItem,
  bindWorkItemSession,
  refreshHeartbeat,
  finishWorkItem,
  requeueWorkItem,
  listExpiredLeases,
  getWorkItem,
} = await import("./work-items.js");

before(() => migrate());
// claimWorkItem / listExpiredLeases scan the whole table (one coordinator loop in
// production); clear it between cases so each test's assertions see only its own rows.
beforeEach(() => getDb().exec("DELETE FROM work_items"));

function freshInstance(): { issueId: string; instanceId: string } {
  const issue = createIssue({
    title: "WI host",
    repo: "/repo",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
  });
  const instance = startWorkflowInstance(issue.id, "dev_reviewer_v1");
  return { issueId: issue.id, instanceId: instance.id };
}

test("enqueue is idempotent on the idempotency key", () => {
  const { issueId, instanceId } = freshInstance();
  const a = enqueueWorkItem({ issueId, workflowInstanceId: instanceId, kind: "developer", round: 1, idempotencyKey: "k1" });
  const b = enqueueWorkItem({ issueId, workflowInstanceId: instanceId, kind: "developer", round: 1, idempotencyKey: "k1" });
  assert.equal(a.id, b.id);
});

test("the one-active partial index rejects a second non-terminal work item per instance", () => {
  const { issueId, instanceId } = freshInstance();
  enqueueWorkItem({ issueId, workflowInstanceId: instanceId, kind: "developer", round: 1, idempotencyKey: "a" });
  assert.throws(() =>
    enqueueWorkItem({ issueId, workflowInstanceId: instanceId, kind: "reviewer", round: 1, idempotencyKey: "b" })
  );
});

test("claimWorkItem is a compare-and-set and mints a fencing token; only one of two racing claims wins", () => {
  const { issueId, instanceId } = freshInstance();
  const item = enqueueWorkItem({ issueId, workflowInstanceId: instanceId, kind: "developer", round: 1 });
  const first = claimWorkItem("owner-A", { leaseMs: 60_000 });
  const second = claimWorkItem("owner-B", { leaseMs: 60_000 });
  assert.equal(first?.id, item.id);
  assert.ok(first?.leaseToken);
  assert.equal(second, null);
  assert.equal(getWorkItem(item.id)!.attemptCount, 1);
});

test("bindWorkItemSession is fenced on the lease token", () => {
  const { issueId, instanceId } = freshInstance();
  const item = enqueueWorkItem({ issueId, workflowInstanceId: instanceId, kind: "developer", round: 1 });
  const claimed = claimWorkItem("owner-A", { leaseMs: 60_000 })!;
  const session = createWorkerSession({
    issueId,
    role: "developer",
    round: 1,
    agentId: BUILTIN_AGENT_CLAUDE_ID,
    runtime: "claude_code",
  });
  assert.equal(bindWorkItemSession(item.id, session.id, "stale-token"), false);
  assert.equal(getWorkItem(item.id)!.workerSessionId, null);
  assert.equal(bindWorkItemSession(item.id, session.id, claimed.leaseToken!), true);
  assert.equal(getWorkItem(item.id)!.workerSessionId, session.id);
});

test("refreshHeartbeat extends the lease for the token holder and fails for a stale token", () => {
  const { issueId, instanceId } = freshInstance();
  const item = enqueueWorkItem({ issueId, workflowInstanceId: instanceId, kind: "developer", round: 1 });
  const claimed = claimWorkItem("owner-A", { leaseMs: 60_000 })!;
  assert.equal(refreshHeartbeat(item.id, claimed.leaseToken!, { leaseMs: 60_000 }), true);
  assert.equal(refreshHeartbeat(item.id, "some-other-token", { leaseMs: 60_000 }), false);
});

test("finishWorkItem CAS-marks a leased item terminal, fenced on the token", () => {
  const { issueId, instanceId } = freshInstance();
  const item = enqueueWorkItem({ issueId, workflowInstanceId: instanceId, kind: "developer", round: 1 });
  assert.equal(finishWorkItem(item.id, "no-token", { status: "done" }), null); // still pending
  const claimed = claimWorkItem("owner-A", { leaseMs: 60_000 })!;
  assert.equal(finishWorkItem(item.id, "wrong-token", { status: "done" }), null);
  assert.equal(finishWorkItem(item.id, claimed.leaseToken!, { status: "done" })!.status, "done");
  assert.equal(finishWorkItem(item.id, claimed.leaseToken!, { status: "done" }), null); // already terminal
});

test("requeueWorkItem returns a leased item to pending behind a backoff gate, fenced on the token", () => {
  const { issueId, instanceId } = freshInstance();
  const item = enqueueWorkItem({ issueId, workflowInstanceId: instanceId, kind: "developer", round: 1 });
  const claimed = claimWorkItem("o", { leaseMs: 60_000 })!;
  assert.equal(requeueWorkItem(item.id, "wrong-token", { e: 1 }, { backoffMs: 50_000 }), false);
  assert.equal(requeueWorkItem(item.id, claimed.leaseToken!, { e: 1 }, { backoffMs: 50_000 }), true);
  const after = getWorkItem(item.id)!;
  assert.equal(after.status, "pending");
  assert.ok(new Date(after.availableAt).getTime() > Date.now() + 40_000);
  // behind the backoff gate → not yet claimable
  assert.equal(claimWorkItem("o", { leaseMs: 60_000 }), null);
});

test("NOT-128: requeueWorkItem can refund the claim-time attempt bump", () => {
  const { issueId, instanceId } = freshInstance();
  const item = enqueueWorkItem({ issueId, workflowInstanceId: instanceId, kind: "developer", round: 1 });

  // Default: the attempt is charged, exactly as an observed failure should be.
  const first = claimWorkItem("o", { leaseMs: 60_000 })!;
  assert.equal(requeueWorkItem(item.id, first.leaseToken!, { e: 1 }, { backoffMs: 0 }), true);
  assert.equal(getWorkItem(item.id)!.attemptCount, 1);

  // Refunded: a requeue bounded by some other budget (recovery's infra attempts) leaves the
  // developer allowance where it was, so a chain of them can never exhaust max_attempts.
  const second = claimWorkItem("o", { leaseMs: 60_000 })!;
  assert.equal(getWorkItem(item.id)!.attemptCount, 2);
  assert.equal(
    requeueWorkItem(item.id, second.leaseToken!, { e: 2 }, { backoffMs: 0, revertAttemptCount: true }),
    true
  );
  assert.equal(getWorkItem(item.id)!.attemptCount, 1);
});

test("listExpiredLeases returns only leases whose lease_expires_at is past the given clock", () => {
  const { issueId, instanceId } = freshInstance();
  const item = enqueueWorkItem({ issueId, workflowInstanceId: instanceId, kind: "developer", round: 1 });
  claimWorkItem("o", { leaseMs: 600_000 });

  assert.equal(listExpiredLeases(Date.now()).length, 0); // lease still valid
  assert.equal(listExpiredLeases(Date.now() + 1_200_000).length, 1); // past expiry
  assert.equal(listExpiredLeases(Date.now() + 1_200_000)[0].id, item.id);
});

test("a completion that wins its CAS defeats a concurrent reclaim", () => {
  const { issueId, instanceId } = freshInstance();
  const item = enqueueWorkItem({ issueId, workflowInstanceId: instanceId, kind: "developer", round: 1 });
  const claimed = claimWorkItem("o", { leaseMs: 1 })!;
  // worker finishes first…
  assert.ok(finishWorkItem(item.id, claimed.leaseToken!, { status: "done" }));
  // …recovery then observes the (now stale) expired-lease snapshot and its CAS matches nothing
  assert.equal(
    requeueWorkItem(claimed.id, claimed.leaseToken!, { r: 1 }, { backoffMs: 0, onlyIfExpiredBefore: new Date(Date.now() + 10_000).toISOString() }),
    false
  );
  assert.equal(getWorkItem(item.id)!.status, "done");
});

test("a heartbeat that renews the lease defeats a concurrent reclaim (onlyIfExpiredBefore guard)", () => {
  const { issueId, instanceId } = freshInstance();
  const item = enqueueWorkItem({ issueId, workflowInstanceId: instanceId, kind: "developer", round: 1 });
  const claimed = claimWorkItem("o", { leaseMs: 5 })!;
  const recoveryClock = Date.now() + 1_000; // recovery observed the lease as expired

  // the worker heartbeats first, pushing lease_expires_at past the recovery clock
  assert.equal(refreshHeartbeat(item.id, claimed.leaseToken!, { leaseMs: 600_000 }), true);

  // recovery's guarded CAS now matches nothing — the healthy attempt keeps its lease
  assert.equal(
    requeueWorkItem(claimed.id, claimed.leaseToken!, { r: 1 }, {
      backoffMs: 0,
      onlyIfExpiredBefore: new Date(recoveryClock).toISOString(),
    }),
    false
  );
  assert.equal(getWorkItem(item.id)!.status, "leased");
});
