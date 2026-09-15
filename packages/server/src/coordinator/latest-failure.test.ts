// packages/server/src/coordinator/latest-failure.test.ts
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } from "@agent-dealer/shared";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-latest-failure-"));

const { migrate, getDb } = await import("../db/index.js");
const { createIssue, getIssue } = await import("../repository/issues.js");
const { startWorkflowInstance, appendWorkflowEvent } = await import("../repository/workflow-events.js");
const { createWorkerSession, startSession, completeSession } = await import("../repository/worker-sessions.js");
const { latestSessionFailureForIssue } = await import("./latest-failure.js");
const { PRESUMED_DEAD_REASON } = await import("./failure-reason.js");

before(() => migrate());
beforeEach(() => {
  getDb().exec(`
    DELETE FROM workflow_events;
    DELETE FROM worker_sessions;
    DELETE FROM workflow_instances;
    DELETE FROM issues;
  `);
});

function makeIssue() {
  return createIssue({
    title: "Latest failure strip",
    acceptanceCriteria: "Strip works",
    repo: "/repo",
    baseBranch: "main",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
  });
}

test("session-fallback strip clears when worker.completed shares the same ms timestamp (rowid > ts)", () => {
  const issue = makeIssue();
  const instance = startWorkflowInstance(issue.id, "dev_reviewer_v1");
  const session = createWorkerSession({
    issueId: issue.id,
    role: "developer",
    round: 1,
    agentId: BUILTIN_AGENT_CLAUDE_ID,
    runtime: "cursor_local",
  });
  startSession(session.id);
  appendWorkflowEvent({
    issueId: issue.id,
    workflowInstanceId: instance.id,
    workerSessionId: session.id,
    type: "worker.started",
    actorType: "developer",
    stage: "developing",
    round: 1,
    payload: {},
  });

  // Force identical wall-clock stamps across session completion and a later handoff event —
  // the exact collision that made `e.ts > when` leave a stale strip.
  const stamped = "2026-09-15T12:00:00.000Z";
  completeSession(session.id, {
    status: "failed",
    errorJson: JSON.stringify({ reason: PRESUMED_DEAD_REASON }),
    logPath: "/tmp/stale-strip.log",
  });
  getDb()
    .prepare("UPDATE worker_sessions SET completed_at = ?, updated_at = ? WHERE id = ?")
    .run(stamped, stamped, session.id);

  // No worker.failed event → session-fallback path.
  const completed = appendWorkflowEvent({
    issueId: issue.id,
    workflowInstanceId: instance.id,
    workerSessionId: session.id,
    type: "worker.completed",
    actorType: "developer",
    stage: "reviewing",
    round: 1,
    payload: { outcome: "clean_handoff" },
  });
  getDb().prepare("UPDATE workflow_events SET ts = ? WHERE id = ?").run(stamped, completed.id);

  const fresh = getIssue(issue.id)!;
  // With ts-only comparison this would still show the failure (completed.ts === when).
  assert.equal(latestSessionFailureForIssue(fresh), null);
});

test("worker.failed strip clears via rowid when a later completed shares the same ts", () => {
  const issue = makeIssue();
  const instance = startWorkflowInstance(issue.id, "dev_reviewer_v1");
  const session = createWorkerSession({
    issueId: issue.id,
    role: "developer",
    round: 1,
    agentId: BUILTIN_AGENT_CLAUDE_ID,
    runtime: "cursor_local",
  });
  startSession(session.id);
  const stamped = "2026-09-15T12:00:00.000Z";

  const failed = appendWorkflowEvent({
    issueId: issue.id,
    workflowInstanceId: instance.id,
    workerSessionId: session.id,
    type: "worker.failed",
    actorType: "developer",
    stage: "developing",
    round: 1,
    payload: {
      sessionId: session.id,
      outcome: "session_failed",
      reason: PRESUMED_DEAD_REASON,
    },
  });
  const completed = appendWorkflowEvent({
    issueId: issue.id,
    workflowInstanceId: instance.id,
    workerSessionId: session.id,
    type: "worker.completed",
    actorType: "developer",
    stage: "reviewing",
    round: 1,
    payload: { outcome: "clean_handoff" },
  });
  getDb().prepare("UPDATE workflow_events SET ts = ? WHERE id IN (?, ?)").run(stamped, failed.id, completed.id);

  completeSession(session.id, {
    status: "failed",
    errorJson: JSON.stringify({ reason: PRESUMED_DEAD_REASON }),
    logPath: "/tmp/stale-strip.log",
  });

  assert.equal(latestSessionFailureForIssue(getIssue(issue.id)!), null);
});
