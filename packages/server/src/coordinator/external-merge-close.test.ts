// packages/server/src/coordinator/external-merge-close.test.ts
//
// NOT-196: closing an issue whose PR already merged outside Dealer must land it as
// `done` (releasing dependents), not `closed`. Every other close — open PR,
// closed-unmerged PR, no PR, or an unreadable PR state — keeps today's `closed`, and
// an unreadable state must never guess `done`.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-extmerge-"));

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, getIssue, transitionIssue } = await import("../repository/issues.js");
const {
  listWorkflowEventsForIssue,
  getActiveWorkflowInstance,
  listWorkflowInstancesForIssue,
} = await import("../repository/workflow-events.js");
const { createHumanAction } = await import("../repository/human-actions.js");
const {
  startWorkflow,
  resolveHumanActionAndAdvance,
  resolveHumanActionAndAdvanceAsync,
  abortIssue,
  abortIssueAsync,
} = await import("./commands.js");
const {
  setPrStateReaderForTests,
  resetExternalMergeForTests,
  parsePrState,
} = await import("./external-merge.js");
const { blockerVerdict, unsatisfiedBlockerReason } = await import("./dependencies.js");
const { stubManagedCloneForTests } = await import("../adapters/managed-repo.js");

before(() => migrate());
beforeEach(() => {
  getDb().exec("DELETE FROM work_items");
  resetExternalMergeForTests();
  stubManagedCloneForTests("acme/app");
});

function newIssue(opts: { source?: "manual" | "linear"; externalId?: string } = {}): string {
  return createIssue({
    title: "Close me",
    description: "d",
    acceptanceCriteria: "It works",
    repo: "acme/app",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: opts.source ?? "manual",
    externalId: opts.externalId,
  }).id;
}

/**
 * An issue parked the way a real close-offering action leaves it: the workflow is
 * mid-flight at needs_human (the only statuses close actions resolve from all carry
 * a →done edge) with an open attempts_exhausted action offering retry/close.
 */
function parkedIssueWithPr(prNumber: number | null): { issueId: string; actionId: string } {
  const issueId = newIssue();
  const started = startWorkflow(issueId);
  assert.equal(started.ok, true);
  // PR fields are coordinator-owned: stamped via the parking transition itself.
  transitionIssue(issueId, "needs_human", {
    currentOwner: "human",
    currentIntent: "Awaiting operator",
    ...(prNumber != null ? { prNumber } : {}),
  });
  const instance = getActiveWorkflowInstance(issueId)!;
  const action = createHumanAction({
    issueId,
    workflowInstanceId: instance.id,
    actionType: "attempts_exhausted",
    reason: "rounds exhausted",
    question: "Retry or close?",
    responseOptions: [
      { choice: "retry", label: "Retry" },
      { choice: "close", label: "Close" },
    ],
  });
  return { issueId, actionId: action.id };
}

function payloadOf(issueId: string, type: string): Record<string, unknown> | null {
  const event = [...listWorkflowEventsForIssue(issueId)].reverse().find((e) => e.type === type);
  assert.ok(event, `expected an ${type} event`);
  return event!.payloadJson ? (JSON.parse(event!.payloadJson) as Record<string, unknown>) : null;
}

test("close with a MERGED PR finishes as done, with the instance completed and an external-merge event", async () => {
  const seen: number[] = [];
  setPrStateReaderForTests(async ({ number }) => (seen.push(number), "MERGED"));
  const { issueId, actionId } = parkedIssueWithPr(42);

  const result = await resolveHumanActionAndAdvanceAsync(actionId, "yusuke", "close");

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.issueStatus, "done");
  assert.equal(getIssue(issueId)!.status, "done");
  assert.deepEqual(seen, [42], "the PR state must be read for the issue's own PR number");
  assert.equal(getActiveWorkflowInstance(issueId), null);
  const instances = listWorkflowInstancesForIssue(issueId);
  assert.equal(instances[instances.length - 1].outcome, "done");
  assert.deepEqual(payloadOf(issueId, "issue.completed"), {
    externalMerge: true,
    prNumber: 42,
    prState: "MERGED",
  });
  assert.equal(payloadOf(issueId, "human_action.resolved")?.externalMerge, true);
  assert.ok(
    !listWorkflowEventsForIssue(issueId).some((e) => e.type === "issue.closed"),
    "no issue.closed may be emitted on the merged path"
  );
});

test("sync close with an explicit merged pre-read lands as done without any gh call", () => {
  let calls = 0;
  setPrStateReaderForTests(async () => (calls++, "MERGED"));
  const { issueId, actionId } = parkedIssueWithPr(7);

  const result = resolveHumanActionAndAdvance(actionId, "yusuke", "close", {
    externalMergeState: "merged",
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.issueStatus, "done");
  assert.equal(getIssue(issueId)!.status, "done");
  assert.equal(calls, 0, "the sync core consumes the pre-read state; it never shells out");
});

test("close with an OPEN PR stays closed, exactly as before", async () => {
  setPrStateReaderForTests(async () => "OPEN");
  const { issueId, actionId } = parkedIssueWithPr(42);

  const result = await resolveHumanActionAndAdvanceAsync(actionId, "yusuke", "close");

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.issueStatus, "closed");
  assert.equal(getIssue(issueId)!.status, "closed");
  const instances = listWorkflowInstancesForIssue(issueId);
  assert.equal(instances[instances.length - 1].outcome, "closed");
  assert.ok(listWorkflowEventsForIssue(issueId).some((e) => e.type === "issue.closed"));
  assert.ok(!listWorkflowEventsForIssue(issueId).some((e) => e.type === "issue.completed"));
});

test("close with a closed-unmerged PR stays closed", async () => {
  setPrStateReaderForTests(async () => "CLOSED");
  const { issueId, actionId } = parkedIssueWithPr(42);

  const result = await resolveHumanActionAndAdvanceAsync(actionId, "yusuke", "close");

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.issueStatus, "closed");
  assert.equal(getIssue(issueId)!.status, "closed");
});

test("close with no PR stays closed and never calls gh", async () => {
  let calls = 0;
  setPrStateReaderForTests(async () => (calls++, "MERGED"));
  const { issueId, actionId } = parkedIssueWithPr(null);

  const result = await resolveHumanActionAndAdvanceAsync(actionId, "yusuke", "close");

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.issueStatus, "closed");
  assert.equal(calls, 0, "without a PR number there is nothing to check");
});

test("close when the PR state cannot be read stays closed and records merge state unknown — never done", async () => {
  setPrStateReaderForTests(async () => {
    throw new Error("gh pr view failed: network down");
  });
  const { issueId, actionId } = parkedIssueWithPr(42);

  const result = await resolveHumanActionAndAdvanceAsync(actionId, "yusuke", "close");

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.issueStatus, "closed");
  assert.equal(getIssue(issueId)!.status, "closed");
  assert.deepEqual(payloadOf(issueId, "issue.closed"), {
    prNumber: 42,
    prMergeStateUnknown: true,
  });
  assert.equal(payloadOf(issueId, "human_action.resolved")?.prMergeStateUnknown, true);
});

test("parsePrState maps every non-merged gh state away from done", () => {
  assert.equal(parsePrState("MERGED"), "merged");
  assert.equal(parsePrState("OPEN"), "open");
  assert.equal(parsePrState("CLOSED"), "closed-unmerged");
  assert.equal(parsePrState("WEIRD"), "unknown");
  assert.equal(parsePrState(null), "unknown");
  assert.equal(parsePrState(undefined), "unknown");
});

test("abort with a MERGED PR finishes as done with an external-merge event", async () => {
  setPrStateReaderForTests(async () => "MERGED");
  const issueId = newIssue();
  assert.equal(startWorkflow(issueId).ok, true);
  // The NOT-186 shape: parked at needs_human (which carries a →done edge) when the
  // operator aborts instead of choosing Close.
  transitionIssue(issueId, "needs_human", {
    currentOwner: "human",
    currentIntent: "Awaiting operator",
    prNumber: 11,
  });

  const result = await abortIssueAsync(issueId, "yusuke");

  assert.deepEqual(result, { ok: true, issueStatus: "done", alreadyClosed: false });
  assert.equal(getIssue(issueId)!.status, "done");
  assert.deepEqual(payloadOf(issueId, "issue.completed"), {
    reason: "aborted_by_user",
    externalMerge: true,
    prNumber: 11,
    prState: "MERGED",
  });
});

test("abort when the PR state cannot be read stays closed and records merge state unknown", async () => {
  setPrStateReaderForTests(async () => {
    throw new Error("gh timed out");
  });
  const issueId = newIssue();
  assert.equal(startWorkflow(issueId).ok, true);
  transitionIssue(issueId, "developing", { prNumber: 11 });

  const result = await abortIssueAsync(issueId, "yusuke");

  assert.deepEqual(result, { ok: true, issueStatus: "closed", alreadyClosed: false });
  assert.deepEqual(payloadOf(issueId, "issue.closed"), {
    reason: "aborted_by_user",
    prNumber: 11,
    prMergeStateUnknown: true,
  });
});

test("sync abort without a pre-read keeps today's closed behavior and exact payload", () => {
  const issueId = newIssue();
  assert.equal(startWorkflow(issueId).ok, true);
  transitionIssue(issueId, "developing", { prNumber: 11 });

  const result = abortIssue(issueId, "yusuke");

  assert.deepEqual(result, { ok: true, issueStatus: "closed", alreadyClosed: false });
  const events = listWorkflowEventsForIssue(issueId).filter((e) => e.type === "issue.closed");
  assert.equal(events.length, 1);
  assert.equal(events[0].payloadJson, JSON.stringify({ reason: "aborted_by_user" }));
});

test("a dependent of an externally-merged issue is released without dropping the Linear relation", async () => {
  setPrStateReaderForTests(async () => "MERGED");
  const blockerExternalId = "linear-blocker-external-merge";
  const blockerId = newIssue({ source: "linear", externalId: blockerExternalId });
  assert.equal(startWorkflow(blockerId).ok, true);
  transitionIssue(blockerId, "needs_human", {
    currentOwner: "human",
    currentIntent: "Awaiting operator",
    prNumber: 99,
  });
  const blockerInstance = getActiveWorkflowInstance(blockerId)!;
  const blockerAction = createHumanAction({
    issueId: blockerId,
    workflowInstanceId: blockerInstance.id,
    actionType: "attempts_exhausted",
    reason: "rounds exhausted",
    question: "Retry or close?",
    responseOptions: [
      { choice: "retry", label: "Retry" },
      { choice: "close", label: "Close" },
    ],
  });
  const closed = await resolveHumanActionAndAdvanceAsync(blockerAction.id, "yusuke", "close");
  assert.equal(closed.ok, true);
  if (!closed.ok) return;
  assert.equal(closed.issueStatus, "done");

  // The Linear `blocks` edge is untouched — the release comes from the dealer `done`
  // alone, via the existing rule.
  const blocker = {
    id: blockerExternalId,
    identifier: "NOT-186",
    stateName: "In Progress",
    stateType: "started",
  };
  assert.deepEqual(blockerVerdict(blocker), { satisfied: true, state: "done" });
  assert.equal(unsatisfiedBlockerReason([blocker]), null);
});

test("abort with a MERGED PR from a status with no done edge stays closed but names the merged PR", async () => {
  setPrStateReaderForTests(async () => "MERGED");
  const issueId = newIssue();
  assert.equal(startWorkflow(issueId).ok, true);
  transitionIssue(issueId, "developing", { prNumber: 11 });
  // Still developing: the status machine has no developing → done edge, so the abort
  // must stay closed rather than throw — but the event still names the merged PR.
  assert.equal(getIssue(issueId)!.status, "developing");

  const result = await abortIssueAsync(issueId, "yusuke");

  assert.deepEqual(result, { ok: true, issueStatus: "closed", alreadyClosed: false });
  assert.deepEqual(payloadOf(issueId, "issue.closed"), {
    reason: "aborted_by_user",
    prNumber: 11,
    prState: "MERGED",
    doneTransitionBlocked: "no developing → done edge",
  });
});

test("blockerVerdict still ignores Linear Done for a Dealer-tracked blocker with live work", () => {
  const blockerExternalId = "linear-blocker-still-live";
  const blockerId = newIssue({ source: "linear", externalId: blockerExternalId });
  assert.equal(startWorkflow(blockerId).ok, true);

  // Linear already shows Done (e.g. marked at PR-approval time) but the code has not
  // landed — the dependent must keep waiting on the dealer issue's live status.
  const blocker = {
    id: blockerExternalId,
    identifier: "NOT-186",
    stateName: "Done",
    stateType: "completed",
  };
  const verdict = blockerVerdict(blocker);
  assert.equal(verdict.satisfied, false);
  assert.equal(verdict.state, getIssue(blockerId)!.status);
  assert.ok(unsatisfiedBlockerReason([blocker])?.includes("NOT-186"));
});
