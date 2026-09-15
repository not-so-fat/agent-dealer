// packages/server/src/coordinator/session-progress.test.ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-progress-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, getIssue, transitionIssue } = await import("../repository/issues.js");
const { startWorkflowInstance, listWorkflowEventsForIssue } = await import("../repository/workflow-events.js");
const { createWorkerSession, startSession } = await import("../repository/worker-sessions.js");
const {
  deriveActivityFromLog,
  emitSessionMilestone,
  shortWorktreePath,
  taskBriefIsComplete,
  workerSessionPayload,
} = await import("./session-progress.js");

before(() => migrate());

test("shortWorktreePath keeps the last two segments", () => {
  assert.equal(shortWorktreePath("/Users/me/.agent-dealer/worktrees/abc-developer"), "worktrees/abc-developer");
  assert.equal(shortWorktreePath(null), null);
});

test("taskBriefIsComplete requires both description and acceptance criteria", () => {
  assert.equal(taskBriefIsComplete({ description: "do it", acceptanceCriteria: "done" }), true);
  assert.equal(taskBriefIsComplete({ description: "do it", acceptanceCriteria: "  " }), false);
  assert.equal(taskBriefIsComplete({ description: "", acceptanceCriteria: "done" }), false);
});

test("workerSessionPayload includes runtime/model/session id", () => {
  assert.deepEqual(
    workerSessionPayload({
      runtime: "cursor_local",
      model: "composer",
      sessionId: "11111111-1111-1111-1111-111111111111",
      worktreePath: "/tmp/wt/issue-1",
    }),
    {
      runtime: "cursor_local",
      model: "composer",
      sessionId: "11111111-1111-1111-1111-111111111111",
      worktreePath: "wt/issue-1",
    }
  );
});

test("deriveActivityFromLog maps recent tool names to operator labels", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-progress-log-"));
  const logPath = path.join(dir, "session.ndjson");
  fs.writeFileSync(
    logPath,
    [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Shell" }] } }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Shell", input: { command: "npm test" } }] },
      }),
    ].join("\n") + "\n"
  );
  // Last event mentions npm test in the serialized payload → running tests
  assert.equal(deriveActivityFromLog(logPath), "running tests");
});

test("emitSessionMilestone appends a role-attributed event and refreshes currentIntent", () => {
  const issue = createIssue({
    title: "Progress",
    description: "Ship visibility",
    acceptanceCriteria: "Operators see last progress",
    repo: "/repo",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    source: "manual",
  });
  const instance = startWorkflowInstance(issue.id, "dev_reviewer_v1");
  transitionIssue(issue.id, "developing", {
    currentOwner: "developer",
    currentIntent: "Developer implementing round 1",
  });
  const session = createWorkerSession({
    issueId: issue.id,
    role: "developer",
    round: 1,
    agentId: BUILTIN_AGENT_CLAUDE_ID,
    runtime: "cursor_local",
  });
  startSession(session.id);

  emitSessionMilestone({
    issueId: issue.id,
    workflowInstanceId: instance.id,
    workerSessionId: session.id,
    role: "developer",
    stage: "developing",
    round: 1,
    type: "worktree.ready",
    intent: "Developer · worktree ready (round 1)",
    payload: { worktreePath: "wt/x" },
  });

  const events = listWorkflowEventsForIssue(issue.id);
  const milestone = events.find((e) => e.type === "worktree.ready");
  assert.ok(milestone);
  assert.equal(milestone!.actorType, "developer");
  assert.equal(getIssue(issue.id)!.currentIntent, "Developer · worktree ready (round 1)");
});
