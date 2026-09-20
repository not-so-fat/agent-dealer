// NOT-194: merge failure after approval offers Retry merge / Another repair round /
// Close (never Resume development). Retry success completes like a final_review merge;
// retry failure leaves exactly one open action with the new reason; legacy open
// merge-failure actions still resolve through resume.
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not194-"));

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, getIssue, transitionIssue } = await import("../repository/issues.js");
const { createHumanAction, listHumanActionsForIssue } = await import("../repository/human-actions.js");
const { getActiveWorkflowInstance } = await import("../repository/workflow-events.js");
const { claimWorkItem, getWorkItem, listWorkItemsForIssue } = await import("../repository/work-items.js");
const { startWorkflow, applyCompletion, responseOptionsFor, resolveHumanActionAndAdvanceAsync } = await import(
  "./commands.js"
);
const { ReviewerResult } = await import("./reviewer-result.js");
const { GH_MERGE_TIMEOUT_MS, setMergePrForTests, clearFinalizeInflightForTests } = await import("./auto-merge.js");

let fixtureRepo = "";

function initFixtureRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not194-repo-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "hi\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

before(() => {
  migrate();
  fixtureRepo = initFixtureRepo();
});
beforeEach(() => {
  getDb().exec(`
    DELETE FROM work_items;
    DELETE FROM human_actions;
    DELETE FROM workflow_events;
    DELETE FROM findings;
    DELETE FROM review_publications;
    DELETE FROM worker_sessions;
    DELETE FROM artifacts;
    DELETE FROM usage_events;
    DELETE FROM workflow_instances;
    DELETE FROM issues;
  `);
  clearFinalizeInflightForTests();
  setMergePrForTests(async () => ({ ok: true }));
});
afterEach(() => {
  setMergePrForTests(null);
  clearFinalizeInflightForTests();
});

function newIssue(opts: { autoMerge?: boolean } = {}): string {
  return createIssue({
    title: "Coordinate me",
    description: "d",
    acceptanceCriteria: "It works",
    repo: fixtureRepo,
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
    autoMerge: opts.autoMerge ?? true,
  }).id;
}

function claim(issueId: string) {
  const item = claimWorkItem(`test-${issueId}`, { leaseMs: 60_000 });
  assert.ok(item && item.issueId === issueId, "expected to lease this issue's work item");
  return item!;
}

async function complete(issueId: string, outcome: Parameters<typeof applyCompletion>[2]) {
  const item = claim(issueId);
  return applyCompletion(item.id, item.leaseToken!, outcome);
}

const okReview = (verdict: "approved" | "changes_requested" | "escalated") =>
  ReviewerResult.parse({
    verdict,
    baseSha: "b",
    headSha: "h",
    acceptanceCriteriaAssessment: "ok",
    evidenceAssessment: "ok",
    findings: [],
    risks: [],
  });

const cleanHandoff = {
  kind: "clean_handoff",
  branch: "issue-1",
  headSha: "abc123",
  baseSha: "base1",
  prNumber: 42,
  prUrl: "https://gh/pr/42",
} as const;

/** Drive an autoMerge issue to an approved-then-failed merge; returns the open action. */
async function failMerge(issueId: string, reason: string) {
  setMergePrForTests(async () => ({ ok: false, reason }));
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await complete(issueId, { kind: "verdict", result: okReview("approved") });
  const action = listHumanActionsForIssue(issueId).find(
    (a) => a.actionType === "policy_escalation" && a.status === "open"
  );
  assert.ok(action, "expected open policy_escalation after merge failure");
  return action!;
}

test("merge failure opens Retry merge / Another repair round / Close, no Resume development", async () => {
  const failure = `gh timed out after ${GH_MERGE_TIMEOUT_MS}ms`;
  const issueId = newIssue();
  const action = await failMerge(issueId, failure);

  // Reason keeps the underlying failure text verbatim.
  assert.match(action.reason, /gh timed out after 20000ms/);
  assert.match(action.question, /Retry the merge/);
  assert.equal(getIssue(issueId)!.status, "needs_human");

  const options = JSON.parse(action.responseOptionsJson!);
  assert.deepEqual(options, [
    { choice: "retry_merge", label: "Retry merge" },
    { choice: "repair", label: "Another repair round" },
    { choice: "close", label: "Close" },
  ]);
});

test("retry merge succeeding completes the issue exactly like a final_review merge", async () => {
  const calls: Array<{ cwd: string; number: number }> = [];
  const issueId = newIssue();
  const action = await failMerge(issueId, "required status checks failed");

  setMergePrForTests(async (opts) => {
    calls.push(opts);
    return { ok: true };
  });
  const resolved = await resolveHumanActionAndAdvanceAsync(action.id, "op", "retry_merge");

  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.issueStatus, "done");
    assert.equal(resolved.instanceCompleted, true);
    assert.equal(resolved.triggerReflect, true);
  }
  assert.deepEqual(calls, [{ cwd: fixtureRepo, number: 42 }]);
  assert.equal(getIssue(issueId)!.status, "done");
  assert.equal(getActiveWorkflowInstance(issueId), null);
  assert.equal(listHumanActionsForIssue(issueId).filter((a) => a.status === "open").length, 0);
});

test("retry merge failing leaves exactly one open action with the new reason", async () => {
  const issueId = newIssue();
  const action = await failMerge(issueId, "required status checks failed");

  setMergePrForTests(async () => ({ ok: false, reason: "merge conflict: CONFLICTING" }));
  const resolved = await resolveHumanActionAndAdvanceAsync(action.id, "op", "retry_merge");

  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.equal(resolved.issueStatus, "needs_human");
  const open = listHumanActionsForIssue(issueId).filter((a) => a.status === "open");
  assert.equal(open.length, 1);
  assert.notEqual(open[0]!.id, action.id);
  assert.equal(open[0]!.actionType, "policy_escalation");
  assert.match(open[0]!.reason, /merge conflict: CONFLICTING/);
  assert.deepEqual(JSON.parse(open[0]!.responseOptionsJson!), [
    { choice: "retry_merge", label: "Retry merge" },
    { choice: "repair", label: "Another repair round" },
    { choice: "close", label: "Close" },
  ]);
});

test("another repair round queues a developer round the way final_review repair does", async () => {
  const issueId = newIssue();
  const action = await failMerge(issueId, "merge conflict: CONFLICTING");
  const roundBefore = getIssue(issueId)!.currentRound;

  const resolved = await resolveHumanActionAndAdvanceAsync(action.id, "op", "repair");
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.equal(resolved.issueStatus, "repairing");
  assert.ok(resolved.ok && resolved.nextWorkItemId, "expected a queued developer round");
  const next = getWorkItem(resolved.ok ? resolved.nextWorkItemId! : "");
  assert.equal(next!.kind, "developer");
  assert.equal(getIssue(issueId)!.currentRound, roundBefore + 1);
  assert.equal(getIssue(issueId)!.status, "repairing");
});

test("merge-failure repair matches the final_review repair shape", async () => {
  const frIssue = newIssue({ autoMerge: false });
  startWorkflow(frIssue);
  await complete(frIssue, cleanHandoff);
  await complete(frIssue, { kind: "verdict", result: okReview("approved") });
  const frAction = listHumanActionsForIssue(frIssue).find((a) => a.actionType === "final_review")!;
  const frResolved = await resolveHumanActionAndAdvanceAsync(frAction.id, "op", "repair");
  assert.equal(frResolved.ok, true);
  if (frResolved.ok) {
    // Same outcome shape the merge-failure repair test above asserts: repairing status,
    // a queued developer round, and a spent review round.
    assert.equal(frResolved.issueStatus, "repairing");
    assert.ok(frResolved.nextWorkItemId, "expected a queued developer round");
    assert.equal(getWorkItem(frResolved.nextWorkItemId!)!.kind, "developer");
  }
});

test("close on a merge-failure action closes the issue", async () => {
  const issueId = newIssue();
  const action = await failMerge(issueId, "required status checks failed");

  const resolved = await resolveHumanActionAndAdvanceAsync(action.id, "op", "close");
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.issueStatus, "closed");
    assert.equal(resolved.instanceCompleted, true);
  }
  assert.equal(getIssue(issueId)!.status, "closed");
});

test("non-merge policy_escalation options and labels are unchanged", () => {
  assert.deepEqual(responseOptionsFor("policy_escalation"), [
    { choice: "resume", label: "Resume development" },
    { choice: "close", label: "Close" },
  ]);
  assert.deepEqual(responseOptionsFor("policy_escalation", true), [
    { choice: "resume", label: "Retry review" },
    { choice: "close", label: "Close" },
  ]);
  assert.deepEqual(responseOptionsFor("policy_escalation", false, { mergeFailure: true }), [
    { choice: "retry_merge", label: "Retry merge" },
    { choice: "repair", label: "Another repair round" },
    { choice: "close", label: "Close" },
  ]);
});

test("a merge-failure action rejects resume; a non-merge escalation rejects retry/repair", async () => {
  const issueId = newIssue();
  const action = await failMerge(issueId, "required status checks failed");
  const resumeOnMerge = await resolveHumanActionAndAdvanceAsync(action.id, "op", "resume");
  assert.equal(resumeOnMerge.ok, false);
  if (!resumeOnMerge.ok) assert.equal(resumeOnMerge.code, 400);
  assert.equal(getIssue(issueId)!.status, "needs_human");

  // Non-merge escalation: infra-exhaustion style, no mergeFailure evidence.
  const otherId = newIssue();
  startWorkflow(otherId);
  transitionIssue(otherId, "needs_human", { currentOwner: "human", currentIntent: "infra spent" });
  const other = createHumanAction({
    issueId: otherId,
    workflowInstanceId: getActiveWorkflowInstance(otherId)!.id,
    actionType: "policy_escalation",
    reason: "Infra attempts exhausted",
    question: "Infra attempts exhausted Resume development, or close the issue?",
    responseOptions: responseOptionsFor("policy_escalation"),
  });
  const retryOnOther = await resolveHumanActionAndAdvanceAsync(other.id, "op", "retry_merge");
  assert.equal(retryOnOther.ok, false);
  if (!retryOnOther.ok) assert.equal(retryOnOther.code, 400);
});

test("legacy open merge-failure action (no evidence) still resolves with resume", async () => {
  const { cancelWorkItem } = await import("../repository/work-items.js");
  const issueId = newIssue();
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  // A real pre-NOT-194 merge failure happened after all work finished: no work item is
  // still pending (the coordinator enforces one pending/leased item per instance), so
  // cancel the reviewer round the handoff queued to reach that state.
  for (const item of listWorkItemsForIssue(issueId)) {
    if (item.status === "pending" || item.status === "leased") cancelWorkItem(item.id);
  }
  transitionIssue(issueId, "needs_human", {
    currentOwner: "human",
    currentIntent: "Auto-merge failed: gh timed out after 20000ms",
  });
  const legacy = createHumanAction({
    issueId,
    workflowInstanceId: getActiveWorkflowInstance(issueId)!.id,
    actionType: "policy_escalation",
    reason: "Auto-merge failed: gh timed out after 20000ms",
    question: "Auto-merge failed: gh timed out after 20000ms Resume development, or close the issue?",
    responseOptions: [
      { choice: "resume", label: "Resume development" },
      { choice: "close", label: "Close" },
    ],
  });

  const resolved = await resolveHumanActionAndAdvanceAsync(legacy.id, "op", "resume");
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.equal(resolved.issueStatus, "developing");
  assert.ok(resolved.ok && resolved.nextWorkItemId, "expected a queued developer round");
  const pending = listWorkItemsForIssue(issueId).filter((i) => i.status === "pending");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.kind, "developer");
});
