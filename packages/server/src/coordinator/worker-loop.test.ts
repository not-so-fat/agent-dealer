// packages/server/src/coordinator/worker-loop.test.ts
//
// End-to-end kernel behaviour with fake effect handlers — the ticket's acceptance
// scenarios: crash before effect, crash after effect / duplicate completion, lease expiry,
// restart recovery, and duplicate dispatch.
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-loop-"));
process.env.MAX_COORDINATOR_CONCURRENCY = "4";
process.env.COORDINATOR_HEARTBEAT_MS = "20";
process.env.COORDINATOR_FAIL_BACKOFF_MS = "0";

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, getIssue } = await import("../repository/issues.js");
const { getActiveWorkflowInstance, listWorkflowEventsForIssue } = await import(
  "../repository/workflow-events.js"
);
const { listHumanActionsForIssue } = await import("../repository/human-actions.js");
const { listWorkerSessionsForIssue } = await import("../repository/worker-sessions.js");
const { listWorkItemsForIssue, claimWorkItem, getWorkItem } = await import("../repository/work-items.js");
const { startWorkflow, applyCompletion, resolveHumanActionAndAdvance } = await import("./commands.js");
const { registerEffectHandler, resetEffectHandlers } = await import("./effect-registry.js");
const { runCoordinatorTick, drainCoordinator, activeAttemptCount } = await import(
  "./worker-loop.js"
);
const { recoverCoordinator } = await import("./recovery.js");
const { ReviewerResult } = await import("./reviewer-result.js");

before(() => migrate());
// claimWorkItem / recovery scan the whole table (one loop in production); start each
// case from an empty queue so a prior test's un-processed item is never claimed here.
beforeEach(() => getDb().exec("DELETE FROM work_items"));
afterEach(() => resetEffectHandlers());

function newIssue(maxReviewRounds = 3): string {
  return createIssue({
    title: "Loop me",
    acceptanceCriteria: "It works",
    repo: "/repo",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds,
    source: "manual",
  }).id;
}

const cleanHandoff = (headSha = "head1") => ({
  kind: "clean_handoff" as const,
  headSha,
  baseSha: "base1",
  prNumber: 7,
  prUrl: "https://gh/pr/7",
});
const approvedVerdict = {
  kind: "verdict" as const,
  result: ReviewerResult.parse({
    verdict: "approved",
    baseSha: "base1",
    headSha: "head1",
    acceptanceCriteriaAssessment: "ok",
    evidenceAssessment: "ok",
    findings: [],
    risks: [],
  }),
};

/** Runs ticks until nothing is claimable and all in-flight work has drained. */
async function pump(max = 20): Promise<void> {
  for (let i = 0; i < max; i++) {
    const started = await runCoordinatorTick({ leaseOwner: "pump" });
    await drainCoordinator();
    if (started === 0) return;
  }
}

test("happy path: developer → reviewer(approved) → final_review, resolved complete → done", async () => {
  const issueId = newIssue();
  registerEffectHandler("developer", async () => cleanHandoff());
  registerEffectHandler("reviewer", async () => approvedVerdict);
  startWorkflow(issueId);
  await pump();

  assert.equal(getIssue(issueId)!.status, "final_review");
  const action = listHumanActionsForIssue(issueId).find((a) => a.actionType === "final_review")!;
  resolveHumanActionAndAdvance(action.id, "yusuke", "complete");
  assert.equal(getIssue(issueId)!.status, "done");
  assert.equal(getActiveWorkflowInstance(issueId), null);

  const roles = listWorkerSessionsForIssue(issueId).map((s) => s.role);
  assert.deepEqual(roles, ["developer", "reviewer"]);
  assert.ok(listWorkerSessionsForIssue(issueId).every((s) => s.status === "done"));
});

test("changes_requested drives an automatic repair round with no human involvement", async () => {
  const issueId = newIssue(3);
  let devCalls = 0;
  registerEffectHandler("developer", async () => {
    devCalls++;
    return cleanHandoff(`head${devCalls}`);
  });
  registerEffectHandler("reviewer", async () =>
    devCalls === 1
      ? {
          kind: "verdict" as const,
          result: ReviewerResult.parse({
            verdict: "changes_requested",
            baseSha: "b",
            headSha: "head1",
            acceptanceCriteriaAssessment: "partial",
            evidenceAssessment: "ok",
            findings: [{ fingerprint: "f1", severity: "blocking", title: "T", rationale: "R" }],
            risks: [],
          }),
        }
      : approvedVerdict
  );
  startWorkflow(issueId);
  await pump();

  assert.equal(devCalls, 2);
  assert.equal(getIssue(issueId)!.status, "final_review");
  assert.equal(getIssue(issueId)!.currentRound, 2);
  assert.equal(listHumanActionsForIssue(issueId).filter((a) => a.actionType !== "final_review").length, 0);
});

test("crash before effect: a leased item with no completion is recovered and advances once", async () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  const devItem = listWorkItemsForIssue(issueId)[0];

  // Simulate the crash: claim the item and never complete it, bypassing the loop.
  claimWorkItem("dead-worker", { leaseMs: 60_000 });
  assert.equal(getWorkItem(devItem.id)!.status, "leased");

  // Recovery requeues the orphaned lease once it has expired…
  recoverCoordinator({ now: Date.now() + 120_000 });
  assert.equal(getWorkItem(devItem.id)!.status, "pending");

  // …now a working handler picks it up and the issue advances exactly once.
  registerEffectHandler("developer", async () => cleanHandoff());
  registerEffectHandler("reviewer", async () => approvedVerdict);
  await pump();
  assert.equal(getIssue(issueId)!.status, "final_review");
  assert.equal(
    listWorkItemsForIssue(issueId).filter((i) => i.kind === "developer").length,
    1,
    "the recovered item was reused, not duplicated"
  );
});

test("crash after effect: a duplicate applyCompletion (same or stale token) is a no-op", async () => {
  const issueId = newIssue();
  const handoff = cleanHandoff();
  startWorkflow(issueId);

  const claimed = claimWorkItem("w1", { leaseMs: 60_000 })!;
  const first = applyCompletion(claimed.id, claimed.leaseToken!, handoff);
  assert.equal(first.applied, true);
  // The worker "crashed" after committing but before recording success — it retries.
  const second = applyCompletion(claimed.id, claimed.leaseToken!, handoff);
  assert.equal(second.applied, false);
  // Recovery also races an apply against the same (now stale) observed token.
  const stale = applyCompletion(claimed.id, claimed.leaseToken!, { kind: "session_failed" });
  assert.equal(stale.applied, false);
  assert.equal(listWorkItemsForIssue(issueId).filter((i) => i.kind === "reviewer").length, 1);
  assert.equal(
    listWorkflowEventsForIssue(issueId).filter((e) => e.type === "pull_request.opened").length,
    1
  );
});

test("fail-after-done: a completeSession failure never revives a work item that already advanced", async () => {
  // Regression for the reviewer's "failure path can undo a successful apply".
  const issueId = newIssue();
  startWorkflow(issueId);
  const claimed = claimWorkItem("w1", { leaseMs: 60_000 })!;
  applyCompletion(claimed.id, claimed.leaseToken!, cleanHandoff());
  assert.equal(getWorkItem(claimed.id)!.status, "done");

  // A late token-fenced failure attempt (what the old catch path would have done) is a no-op.
  const { requeueWorkItem, finishWorkItem } = await import("../repository/work-items.js");
  assert.equal(requeueWorkItem(claimed.id, claimed.leaseToken!, { e: 1 }, { backoffMs: 0 }), false);
  assert.equal(finishWorkItem(claimed.id, claimed.leaseToken!, { status: "dead" }), null);
  assert.equal(getWorkItem(claimed.id)!.status, "done");
});

test("lease expiry: a hung worker's late completion is dropped; the requeued item wins", async () => {
  const issueId = newIssue();
  registerEffectHandler("developer", async () => cleanHandoff());
  registerEffectHandler("reviewer", async () => approvedVerdict);
  startWorkflow(issueId);
  const devItemId = listWorkItemsForIssue(issueId)[0].id;

  // A hung worker: it holds the lease but its heartbeat stopped (process frozen).
  const hung = claimWorkItem("hung", { leaseMs: 20 })!;
  await new Promise((r) => setTimeout(r, 40));

  // The periodic reclaim requeues the now-expired lease.
  const res = recoverCoordinator({ now: Date.now() });
  assert.deepEqual(res.reclaimed, [devItemId]);
  assert.equal(getWorkItem(devItemId)!.status, "pending");

  // The hung worker finally wakes and reports success — but its token is dead: no-op.
  const late = applyCompletion(devItemId, hung.leaseToken!, cleanHandoff());
  assert.equal(late.applied, false);

  // A fresh worker reprocesses the requeued item and drives the workflow forward.
  await pump();
  assert.equal(getIssue(issueId)!.status, "final_review");
});

test("duplicate dispatch: two racing ticks run one worker session, one advance", async () => {
  const issueId = newIssue();
  registerEffectHandler("developer", async () => {
    await new Promise((r) => setTimeout(r, 15));
    return cleanHandoff();
  });
  registerEffectHandler("reviewer", async () => approvedVerdict);
  startWorkflow(issueId);

  await Promise.all([
    runCoordinatorTick({ leaseOwner: "A" }),
    runCoordinatorTick({ leaseOwner: "B" }),
  ]);
  await drainCoordinator();

  assert.equal(
    listWorkerSessionsForIssue(issueId).filter((s) => s.role === "developer").length,
    1
  );
  await pump();
  assert.equal(getIssue(issueId)!.status, "final_review");
});

test("a recovery-requeued re-attempt is tracked separately from its zombie predecessor", async () => {
  // Regression for "active.set(item.id) replaces the old promise" — key by lease token.
  const prevHb = process.env.COORDINATOR_HEARTBEAT_MS;
  const prevLease = process.env.COORDINATOR_LEASE_MS;
  process.env.COORDINATOR_HEARTBEAT_MS = "100000"; // effectively never during the test
  process.env.COORDINATOR_LEASE_MS = "10";
  try {
    const issueId = newIssue();
    let calls = 0;
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });
    registerEffectHandler("developer", async () => {
      calls++;
      if (calls === 1) await gateA;
      return cleanHandoff(`h${calls}`);
    });
    registerEffectHandler("reviewer", async () => approvedVerdict);
    startWorkflow(issueId);

    await runCoordinatorTick({ leaseOwner: "A" }); // attempt A starts, hangs on gateA
    assert.equal(activeAttemptCount(), 1);

    await new Promise((r) => setTimeout(r, 25)); // the 10ms lease expires; no heartbeat fires
    recoverCoordinator({ now: Date.now() }); // requeues the item + fails A's session
    const predecessorSessionId = listWorkerSessionsForIssue(issueId)[0].id;
    assert.equal(listWorkerSessionsForIssue(issueId)[0].status, "failed");

    await runCoordinatorTick({ leaseOwner: "B" }); // attempt B claims the requeued item
    assert.equal(activeAttemptCount(), 2, "zombie A + re-attempt B tracked separately");

    releaseA();
    await drainCoordinator();
    assert.equal(activeAttemptCount(), 0);
    // A's late completion must NOT overwrite recovery's terminal evidence on its session.
    const predecessor = listWorkerSessionsForIssue(issueId).find((s) => s.id === predecessorSessionId)!;
    assert.equal(predecessor.status, "failed");
    assert.match(predecessor.errorJson ?? "", /presumed dead/);

    await pump(); // run the reviewer B enqueued
    assert.equal(getIssue(issueId)!.status, "final_review");
  } finally {
    restoreEnv("COORDINATOR_HEARTBEAT_MS", prevHb);
    restoreEnv("COORDINATOR_LEASE_MS", prevLease);
  }
});

function restoreEnv(key: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

test("placeholder handlers escalate rather than fabricating a PR", async () => {
  const issueId = newIssue();
  // no handlers registered → defaults return session_failed
  startWorkflow(issueId);
  await pump();
  // maxReviewRounds 3 → session_failed retries until exhausted, then attempts_exhausted
  assert.equal(getIssue(issueId)!.status, "needs_human");
  assert.equal(
    listHumanActionsForIssue(issueId).find((a) => a.status === "open")!.actionType,
    "attempts_exhausted"
  );
});
