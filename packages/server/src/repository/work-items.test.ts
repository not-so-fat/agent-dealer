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

test("listExpiredLeases: periodic sees only expired leases; startup sees all", () => {
  const { issueId, instanceId } = freshInstance();
  const item = enqueueWorkItem({ issueId, workflowInstanceId: instanceId, kind: "developer", round: 1 });
  claimWorkItem("o", { leaseMs: 600_000 });

  assert.equal(listExpiredLeases(Date.now()).length, 0); // lease still valid
  assert.equal(listExpiredLeases(Date.now(), { includeAllLeased: true }).length, 1);
  assert.equal(listExpiredLeases(Date.now() + 1_200_000).length, 1); // now past expiry
  assert.equal(listExpiredLeases(Date.now())[0]?.id, undefined);
  assert.equal(listExpiredLeases(Date.now() + 1_200_000)[0].id, item.id);
});

test("a completion that wins its CAS defeats a concurrent reclaim", () => {
  const { issueId, instanceId } = freshInstance();
  const item = enqueueWorkItem({ issueId, workflowInstanceId: instanceId, kind: "developer", round: 1 });
  const claimed = claimWorkItem("o", { leaseMs: 1 })!;
  // worker finishes first…
  assert.ok(finishWorkItem(item.id, claimed.leaseToken!, { status: "done" }));
  // …recovery then observes the (now stale) expired-lease snapshot and its CAS matches nothing
  const stale = { ...claimed };
  assert.equal(requeueWorkItem(stale.id, stale.leaseToken!, { r: 1 }, { backoffMs: 0 }), false);
  assert.equal(getWorkItem(item.id)!.status, "done");
});
