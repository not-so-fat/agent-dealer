// packages/server/src/coordinator/presumed-dead-budget.integration.test.ts
//
// NOT-128: a presumed-dead reclaim is bounded by the INFRA budget, not the developer's.
//
// On NOT-121 two work items each hit attempt_count 3 of 3 and dead-lettered, and every one of
// those six attempts was a sleeping laptop being reclaimed — no agent session ever reported a
// failure. `issues.infra_attempts` sat at 2, the two dead-letters that finally reached the
// router; the four soft reclaims in between were charged to no budget anyone checks. The
// issue reached needs_human with its agent retry budget spent on a clamshell closing.
//
// These are the acceptance scenarios for the accounting: the developer allowance survives a
// chain of reclaims longer than max_attempts, the infra budget is what counts them, and its
// exhaustion is what escalates. `repo` is deliberately a path that does not exist, so
// NOT-129's branch inspection reads "absent" and every reclaim here takes the plain re-run
// path — this file is about which counter moves, not about republishing.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-dead-budget-"));
process.env.MAX_COORDINATOR_CONCURRENCY = "2";
process.env.COORDINATOR_FAIL_BACKOFF_MS = "0";

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, getIssue } = await import("../repository/issues.js");
const { listHumanActionsForIssue } = await import("../repository/human-actions.js");
const { createWorkerSession, startSession } = await import("../repository/worker-sessions.js");
const { claimWorkItem, bindWorkItemSession, getWorkItem, listWorkItemsForIssue } = await import(
  "../repository/work-items.js"
);
const { startWorkflow, applyCompletion } = await import("./commands.js");
const { recoverCoordinator } = await import("./recovery.js");

/** A clock well past any lease here — recovery must see every lease as expired. */
const FUTURE = () => Date.now() + 3_600_000;

before(() => migrate());
beforeEach(() => getDb().exec("DELETE FROM work_items"));

function newIssue(maxInfraAttempts: number): string {
  return createIssue({
    title: "Deck membership changes outside the deck",
    acceptanceCriteria: "The route reaches the store",
    repo: "/repo",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts,
    source: "manual",
  }).id;
}

/**
 * The issue's queued developer item — the live one, not a predecessor a router already
 * finished. A reclaim requeues in place, so across a chain of them this is the same row.
 */
function devItem(issueId: string) {
  const item = listWorkItemsForIssue(issueId).find((i) => i.kind === "developer" && i.status === "pending");
  assert.ok(item, "expected a pending developer work item");
  return item!;
}

/**
 * One sleep-induced reclaim, end to end: the coordinator claims and starts a session, the
 * host goes away without the CLI ever reporting anything, and recovery runs on a clock past
 * the lease. This is the cycle that used to cost a developer attempt per iteration.
 */
async function presumedDeadReclaim(issueId: string): Promise<Awaited<ReturnType<typeof recoverCoordinator>>> {
  const item = devItem(issueId);
  const claimed = claimWorkItem(`sleeping-host-${issueId}`, { leaseMs: 1 });
  assert.ok(claimed && claimed.id === item.id, "expected to lease this issue's developer item");
  const session = createWorkerSession({
    issueId,
    role: "developer",
    round: claimed!.round,
    agentId: getIssue(issueId)!.developerAgentId,
    runtime: "claude_code",
  });
  startSession(session.id);
  assert.equal(bindWorkItemSession(item.id, session.id, claimed!.leaseToken!), true);
  return recoverCoordinator({ now: FUTURE() });
}

function openActions(issueId: string) {
  return listHumanActionsForIssue(issueId).filter((a) => a.status === "open");
}

test("NOT-128: N presumed-dead reclaims spend N infra attempts and leave the developer budget unspent", async () => {
  // Six reclaims against a max_attempts of 3 (the enqueue default, untouched): if
  // attempt_count still bounded this path, the item would have dead-lettered on the third.
  const reclaims = 6;
  const issueId = newIssue(reclaims);
  startWorkflow(issueId);
  const itemId = devItem(issueId).id;

  for (let i = 1; i <= reclaims; i++) {
    const res = await presumedDeadReclaim(issueId);
    assert.deepEqual(res.reclaimed, [itemId], `reclaim ${i} requeues the item in place`);
    assert.deepEqual(res.deadLettered, [], `reclaim ${i} must not dead-letter`);

    const item = getWorkItem(itemId)!;
    assert.equal(item.status, "pending", `reclaim ${i} leaves the item runnable`);
    assert.equal(item.attemptCount, 0, `reclaim ${i} refunds the claim-time attempt bump`);
    assert.ok(item.attemptCount < item.maxAttempts, "the developer cap is never approached");

    const issue = getIssue(issueId)!;
    assert.equal(issue.infraAttempts, i, "the infra budget is the one being spent");
    assert.equal(issue.currentRound, 1, "no review round is consumed");
    assert.equal(issue.status, "developing", "still the agent's work, not a human's");
    assert.deepEqual(openActions(issueId), [], "nothing has been dumped on a human");
  }

  // The bound that finally fires is the infra one, on the reclaim *after* the budget is gone.
  const res = await presumedDeadReclaim(issueId);
  assert.deepEqual(res.deadLettered, [itemId]);
  assert.deepEqual(res.reclaimed, []);
  assert.equal(getWorkItem(itemId)!.status, "dead");
  assert.equal(getIssue(issueId)!.infraAttempts, reclaims, "the exhausting reclaim spends nothing further");

  const action = openActions(issueId)[0];
  assert.ok(action, "exhaustion escalates to a human");
  assert.equal(action.actionType, "policy_escalation");
  assert.match(action.reason ?? "", /presumed dead/, "the reason names the infra cause, not an agent failure");
  assert.match(action.reason ?? "", /infra-attempt limit reached/);
  assert.equal(getIssue(issueId)!.status, "needs_human");
});

test("NOT-128: the requeued attempt carries the presumed-dead reason into its next session", async () => {
  const issueId = newIssue(3);
  startWorkflow(issueId);
  const itemId = devItem(issueId).id;

  await presumedDeadReclaim(issueId);

  const payload = JSON.parse(getWorkItem(itemId)!.payloadJson!) as {
    retryReason?: string;
    publishOnly?: boolean;
    profileSnapshot?: unknown;
  };
  assert.match(payload.retryReason ?? "", /presumed dead/, "the next prompt must say why it is running again");
  assert.equal(payload.publishOnly, undefined, "an absent branch is a plain re-run, not a republish");
  assert.ok(payload.profileSnapshot, "the frozen execution profile survives the requeue");
  assert.match(getWorkItem(itemId)!.errorJson ?? "", /presumed dead/);
});

test("NOT-128: a genuine session failure and a presumed-dead reclaim spend the same budget, once each", async () => {
  const issueId = newIssue(3);
  startWorkflow(issueId);

  // A real agent exit, routed the way it always has been.
  const first = claimWorkItem(`real-session-${issueId}`, { leaseMs: 60_000 })!;
  await applyCompletion(first.id, first.leaseToken!, { kind: "session_failed" });
  assert.equal(getIssue(issueId)!.infraAttempts, 1, "an observed failure spends exactly one infra attempt");
  assert.equal(getWorkItem(first.id)!.status, "done", "…and dead-letters nothing");

  // Then the host sleeps on the retry it enqueued: same budget, one more attempt.
  const fresh = devItem(issueId);
  assert.notEqual(fresh.id, first.id, "the routed retry is a fresh work item");
  await presumedDeadReclaim(issueId);
  assert.equal(getIssue(issueId)!.infraAttempts, 2);
  assert.equal(getWorkItem(fresh.id)!.status, "pending");
  assert.deepEqual(openActions(issueId), []);

  // Third and last of the budget, then the fourth reclaim escalates.
  await presumedDeadReclaim(issueId);
  assert.equal(getIssue(issueId)!.infraAttempts, 3);
  assert.deepEqual((await presumedDeadReclaim(issueId)).deadLettered, [fresh.id]);
  assert.equal(openActions(issueId)[0]?.actionType, "policy_escalation");
});
