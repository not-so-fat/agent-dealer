// packages/server/src/repository/review-publications.test.ts
//
// NOT-62 review round 6: a claim grant must not just check the lease is live at that
// instant — it must also extend it, atomically, so recovery's own reclaim query cannot
// later match this work item while the `gh` call the claim protects is still in flight.
// These tests exercise that directly against `listExpiredLeases`, the exact function
// `coordinator/recovery.ts` uses to find reclaimable leases — not just a raw timestamp
// field — so a regression that broke the actual guarantee (not merely the column value)
// would be caught here.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-reviewpub-"));
process.env.REVIEWER_PUBLISH_LEASE_EXTENSION_MS = "300000";

const { migrate, getDb } = await import("../db/index.js");
const { createAgent } = await import("../repository/agents.js");
const { createIssue } = await import("./issues.js");
const { startWorkflowInstance } = await import("./workflow-events.js");
const { enqueueWorkItem, claimWorkItem, listExpiredLeases } = await import("./work-items.js");
const {
  claimReviewPublication,
  recordReviewPublishFailed,
  reclaimFailedReviewPublication,
} = await import("./review-publications.js");

before(() => migrate());
beforeEach(() => getDb().exec("DELETE FROM review_publications; DELETE FROM work_items;"));

function freshLeasedWorkItem(): { id: string; leaseToken: string } {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", workspaceRoot: "/repo" });
  const rev = createAgent({ name: `rev-${Math.random()}`, runtime: "claude_code", workspaceRoot: "/repo" });
  const issue = createIssue({
    title: "T",
    repo: "/repo",
    developerAgentId: dev.id,
    reviewerAgentId: rev.id,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
  });
  const instance = startWorkflowInstance(issue.id, "dev_reviewer_v1");
  enqueueWorkItem({ issueId: issue.id, workflowInstanceId: instance.id, kind: "reviewer", round: 1 });
  // A very short leaseMs — about to expire on its own, matching the round-6 scenario.
  const claimed = claimWorkItem("test-owner", { leaseMs: 20 })!;
  return { id: claimed.id, leaseToken: claimed.leaseToken! };
}

test("claiming publication extends the lease so recovery's own reclaim query no longer matches, even though the original lease was about to expire", async () => {
  // leaseMs: 20 in freshLeasedWorkItem — the ORIGINAL lease is about to expire on its
  // own; claiming happens immediately, while it's still (barely) live.
  const { id, leaseToken } = freshLeasedWorkItem();
  assert.equal(claimReviewPublication(id, leaseToken), true);

  // Wait past when the ORIGINAL 20ms lease would have expired.
  await new Promise((resolve) => setTimeout(resolve, 40));

  // Recovery's exact reclaim query must not see this item as expired, now or for the
  // whole extension window — not just at the instant it was claimed.
  assert.equal(listExpiredLeases(Date.now()).some((i) => i.id === id), false);
  assert.equal(
    listExpiredLeases(Date.now() + 60_000).some((i) => i.id === id),
    false,
    "must stay unreclaimable well past the original lease's own duration"
  );
});

test("reclaiming a failed publication also extends the lease", async () => {
  const { id, leaseToken } = freshLeasedWorkItem();
  assert.equal(claimReviewPublication(id, leaseToken), true);
  recordReviewPublishFailed(id);

  // The first claim's own extension is still ~5 minutes out — reset it back down to
  // something about to expire again, so reclaiming below (called while it's still
  // barely valid) is what has to be the thing keeping it alive past that point, not
  // leftover slack from the first claim's extension.
  getDb().prepare("UPDATE work_items SET lease_expires_at = ? WHERE id = ?").run(new Date(Date.now() + 20).toISOString(), id);

  assert.equal(reclaimFailedReviewPublication(id, leaseToken), true);

  await new Promise((resolve) => setTimeout(resolve, 40)); // past that reset 20ms window
  assert.equal(listExpiredLeases(Date.now()).some((i) => i.id === id), false, "reclaiming must extend the lease too, not just a fresh claim");
});

test("a claim attempt whose lease is already gone (recovery reclaimed first) never extends anything", async () => {
  const { id, leaseToken } = freshLeasedWorkItem();
  // Recovery reclaims first: a fresh claimWorkItem-style rotation onto a new token would
  // normally do this; simplest faithful simulation is directly rotating the token/lease.
  getDb().prepare("UPDATE work_items SET lease_token = ? WHERE id = ?").run("someone-elses-token", id);

  assert.equal(claimReviewPublication(id, leaseToken), false, "a stale token must never win the claim");
  // And it must not have extended the (now someone-else's) lease either.
  const row = getDb().prepare("SELECT lease_expires_at FROM work_items WHERE id = ?").get(id) as { lease_expires_at: string };
  assert.ok(new Date(row.lease_expires_at).getTime() < Date.now() + 60_000, "a losing claim attempt must not extend the lease it doesn't hold");
});
