// packages/server/src/coordinator/workflow-instances.test.ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-wfinst-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("../repository/issues.js");
const {
  startWorkflowInstance,
  completeWorkflowInstance,
  getActiveWorkflowInstance,
  getWorkflowInstance,
  listWorkflowInstancesForIssue,
  WorkflowAlreadyActiveError,
} = await import("../repository/workflow-events.js");

before(() => migrate());

function newIssue(): string {
  return createIssue({
    title: "WF host",
    repo: "/repo",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
  }).id;
}

test("startWorkflowInstance creates one active instance", () => {
  const issueId = newIssue();
  const inst = startWorkflowInstance(issueId, "dev_reviewer_v1");
  assert.equal(inst.completedAt, null);
  assert.equal(getActiveWorkflowInstance(issueId)!.id, inst.id);
  assert.deepEqual(getWorkflowInstance(inst.id), inst);
});

test("a second start throws WorkflowAlreadyActiveError", () => {
  const issueId = newIssue();
  startWorkflowInstance(issueId, "dev_reviewer_v1");
  assert.throws(
    () => startWorkflowInstance(issueId, "dev_reviewer_v1"),
    (err) => err instanceof WorkflowAlreadyActiveError
  );
});

test("completing an instance frees the issue for a new one", () => {
  const issueId = newIssue();
  const first = startWorkflowInstance(issueId, "dev_reviewer_v1");
  completeWorkflowInstance(first.id, "done");
  assert.equal(getActiveWorkflowInstance(issueId), null);
  const second = startWorkflowInstance(issueId, "dev_reviewer_v1");
  assert.equal(listWorkflowInstancesForIssue(issueId).length, 2);
  assert.equal(getActiveWorkflowInstance(issueId)!.id, second.id);
});
