// NOT-310: conflict-failure classifier + the conflict-repair episode bound.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not310-"));
process.env.AGENT_DEALER_SKIP_GITHUB_HEALTH = "1";
process.env.AGENT_DEALER_SKIP_AGENT_HEALTH = "1";

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("../repository/issues.js");
const { startWorkflow } = await import("./commands.js");
const { appendWorkflowEvent, getActiveWorkflowInstance } = await import(
  "../repository/workflow-events.js"
);
const { conflictRepairSpent, isMergeConflictFailure } = await import("./merge-conflict-sync.js");

before(() => {
  migrate();
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
});

test("isMergeConflictFailure classifies gh conflict text, not infra failures", () => {
  assert.equal(
    isMergeConflictFailure(
      "Pull request #42 is not mergeable: the merge commit cannot be cleanly created"
    ),
    true
  );
  assert.equal(isMergeConflictFailure("merge conflict: CONFLICTING"), true);
  assert.equal(isMergeConflictFailure("CONFLICTING"), true);
  // Deliberately broad: a policy "not mergeable" still enters the sync, which
  // then escalates directly once the branch proves up to date (integration:
  // "up-to-date branch that stays not mergeable").
  assert.equal(
    isMergeConflictFailure("Pull request #42 is not mergeable: base branch policy prohibits the merge"),
    true
  );
  assert.equal(isMergeConflictFailure("required status checks failed"), false);
  assert.equal(isMergeConflictFailure("gh timed out after 20000ms"), false);
  assert.equal(isMergeConflictFailure("protected branch"), false);
  assert.equal(isMergeConflictFailure("Managed clone missing for github.com/a/b (/x)"), false);
  assert.equal(
    isMergeConflictFailure("gh not on PATH — install GitHub CLI (`gh`) and ensure the daemon can see it"),
    false
  );
  assert.equal(
    isMergeConflictFailure("invalid merge cwd (/x) — path does not exist (portable issue.repo must not be used as cwd)"),
    false
  );
});

function newIssueWithWorkflow(): { issueId: string; instanceId: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not310bound-repo-"));
  const issueId = createIssue({
    title: "Bound me",
    description: "d",
    acceptanceCriteria: "It works",
    repo,
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
    autoMerge: true,
  }).id;
  startWorkflow(issueId);
  return { issueId, instanceId: getActiveWorkflowInstance(issueId)!.id };
}

function emitRepairQueued(issueId: string, instanceId: string, files: unknown): void {
  appendWorkflowEvent({
    issueId,
    workflowInstanceId: instanceId,
    workerSessionId: null,
    type: "auto_merge.conflict_repair_queued",
    actorType: "system",
    stage: "repairing",
    round: 2,
    payload: { baseBranch: "main", branch: "issue-1", files, round: 2, workItemId: "w" },
  });
}

function emitResolved(issueId: string, instanceId: string): void {
  appendWorkflowEvent({
    issueId,
    workflowInstanceId: instanceId,
    workerSessionId: null,
    type: "human_action.resolved",
    actorType: "human",
    stage: "needs_human",
    round: 2,
    payload: { actionType: "policy_escalation", choice: "retry_merge" },
  });
}

test("conflictRepairSpent is false with no repair event", () => {
  const { issueId, instanceId } = newIssueWithWorkflow();
  assert.deepEqual(conflictRepairSpent(issueId, instanceId), { spent: false, files: [] });
});

test("conflictRepairSpent is true after a repair round queued, carrying its files", () => {
  const { issueId, instanceId } = newIssueWithWorkflow();
  emitRepairQueued(issueId, instanceId, ["shared.txt"]);
  assert.deepEqual(conflictRepairSpent(issueId, instanceId), { spent: true, files: ["shared.txt"] });
});

test("conflictRepairSpent resets on a later human resolution (fresh episode)", () => {
  const { issueId, instanceId } = newIssueWithWorkflow();
  emitRepairQueued(issueId, instanceId, ["shared.txt"]);
  emitResolved(issueId, instanceId);
  assert.deepEqual(conflictRepairSpent(issueId, instanceId), { spent: false, files: [] });
});

test("conflictRepairSpent stays spent when the repair queued after the last resolution", () => {
  const { issueId, instanceId } = newIssueWithWorkflow();
  emitResolved(issueId, instanceId);
  emitRepairQueued(issueId, instanceId, []);
  assert.deepEqual(conflictRepairSpent(issueId, instanceId), { spent: true, files: [] });
});

test("conflictRepairSpent ignores other issues/instances and malformed file lists", () => {
  const { issueId, instanceId } = newIssueWithWorkflow();
  const other = newIssueWithWorkflow();
  emitRepairQueued(other.issueId, other.instanceId, ["other.txt"]);
  assert.deepEqual(conflictRepairSpent(issueId, instanceId), { spent: false, files: [] });
  assert.deepEqual(conflictRepairSpent(issueId, other.instanceId), { spent: false, files: [] });
  emitRepairQueued(issueId, instanceId, "not-a-list");
  const spent = conflictRepairSpent(issueId, instanceId);
  assert.equal(spent.spent, true);
  assert.deepEqual(spent.files, []);
});
