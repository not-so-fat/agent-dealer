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
const { startWorkflowInstance } = await import("./workflow-events.js");
const {
  enqueueWorkItem,
  claimWorkItem,
  refreshHeartbeat,
  completeWorkItem,
  failWorkItem,
  reclaimExpiredWorkItems,
  getWorkItem,
} = await import("./work-items.js");

before(() => migrate());
// claimWorkItem / reclaim scan the whole table (one coordinator loop in production);
// clear it between cases so each test's assertions see only its own rows.
beforeEach(() => getDb().exec("DELETE FROM work_items"));

function freshInstance(): { issueId: string; instanceId: string } {
  const issue = createIssue({
    title: "WI host",
    repo: "/repo",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
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

test("claimWorkItem is a compare-and-set — only one of two racing claims wins", () => {
  const { issueId, instanceId } = freshInstance();
  const item = enqueueWorkItem({ issueId, workflowInstanceId: instanceId, kind: "developer", round: 1 });
  const first = claimWorkItem("owner-A", { leaseMs: 60_000 });
  const second = claimWorkItem("owner-B", { leaseMs: 60_000 });
  assert.equal(first?.id, item.id);
  assert.equal(second, null);
  assert.equal(getWorkItem(item.id)!.attemptCount, 1);
});

test("refreshHeartbeat extends the lease for the owner and fails for a non-owner", () => {
  const { issueId, instanceId } = freshInstance();
  const item = enqueueWorkItem({ issueId, workflowInstanceId: instanceId, kind: "developer", round: 1 });
  claimWorkItem("owner-A", { leaseMs: 60_000 });
  assert.equal(refreshHeartbeat(item.id, "owner-A", { leaseMs: 60_000 }), true);
  assert.equal(refreshHeartbeat(item.id, "owner-B", { leaseMs: 60_000 }), false);
});

test("completeWorkItem only completes a leased item", () => {
  const { issueId, instanceId } = freshInstance();
  const item = enqueueWorkItem({ issueId, workflowInstanceId: instanceId, kind: "developer", round: 1 });
  assert.equal(completeWorkItem(item.id, { kind: "no_pr" }), null); // still pending
  claimWorkItem("owner-A", { leaseMs: 60_000 });
  assert.equal(completeWorkItem(item.id, { kind: "no_pr" })!.status, "done");
  assert.equal(completeWorkItem(item.id, { kind: "no_pr" }), null); // already done
});

test("failWorkItem backs off, then dead-letters at the attempt cap", () => {
  const { issueId, instanceId } = freshInstance();
  const item = enqueueWorkItem({ issueId, workflowInstanceId: instanceId, kind: "developer", round: 1, maxAttempts: 2 });
  claimWorkItem("o", { leaseMs: 1 }); // attempt 1
  let r = failWorkItem(item.id, { e: 1 }, { backoffMs: 0 });
  assert.equal(r.dead, false);
  assert.equal(getWorkItem(item.id)!.status, "pending");
  claimWorkItem("o", { leaseMs: 1 }); // attempt 2
  r = failWorkItem(item.id, { e: 2 }, { backoffMs: 0 });
  assert.equal(r.dead, true);
  assert.equal(getWorkItem(item.id)!.status, "dead");
});

test("reclaimExpiredWorkItems requeues an expired lease for another attempt", () => {
  const a = freshInstance();
  const item = enqueueWorkItem({ issueId: a.issueId, workflowInstanceId: a.instanceId, kind: "developer", round: 1, maxAttempts: 3 });
  claimWorkItem("o", { leaseMs: 1 });
  const res = reclaimExpiredWorkItems(Date.now() + 10_000);
  assert.equal(res.reclaimed.length, 1);
  assert.equal(res.deadLettered.length, 0);
  assert.equal(getWorkItem(item.id)!.status, "pending");
});

test("reclaimExpiredWorkItems dead-letters an expired lease past the attempt cap", () => {
  const b = freshInstance();
  const capped = enqueueWorkItem({ issueId: b.issueId, workflowInstanceId: b.instanceId, kind: "developer", round: 1, maxAttempts: 1 });
  claimWorkItem("o", { leaseMs: 1 }); // attempt_count → 1 == cap
  const res = reclaimExpiredWorkItems(Date.now() + 10_000);
  assert.deepEqual(res.deadLettered.map((i) => i.id), [capped.id]);
  assert.equal(getWorkItem(capped.id)!.status, "dead");
});

test("startup reclaim (includeAllLeased) requeues a lease that has not yet expired", () => {
  const { issueId, instanceId } = freshInstance();
  const item = enqueueWorkItem({ issueId, workflowInstanceId: instanceId, kind: "developer", round: 1 });
  claimWorkItem("o", { leaseMs: 600_000 });
  const res = reclaimExpiredWorkItems(Date.now(), { includeAllLeased: true });
  assert.equal(res.reclaimed.map((i) => i.id).includes(item.id), true);
  assert.equal(getWorkItem(item.id)!.status, "pending");
});
