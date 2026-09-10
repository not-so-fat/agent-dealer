// packages/server/src/repository/worker-sessions.test.ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-sessions-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("./issues.js");
const { createWorkerSession, getWorkerSession, listWorkerSessionsForIssue } =
  await import("./worker-sessions.js");

let issueId: string;

before(() => {
  migrate();
  issueId = createIssue({
    title: "Session host issue",
    repo: "/repo",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    source: "manual",
  }).id;
});

test("creates a queued session", () => {
  const session = createWorkerSession({
    issueId,
    role: "developer",
    round: 1,
    agentId: BUILTIN_AGENT_CLAUDE_ID,
    runtime: "claude_code",
  });
  assert.equal(session.status, "queued");
  assert.deepStrictEqual(getWorkerSession(session.id), session);
});

test("lists sessions for an issue in creation order", () => {
  const s1 = createWorkerSession({ issueId, role: "developer", round: 1, agentId: BUILTIN_AGENT_CLAUDE_ID, runtime: "claude_code" });
  const s2 = createWorkerSession({ issueId, role: "reviewer", round: 1, agentId: BUILTIN_AGENT_CLAUDE_ID, runtime: "claude_code" });
  const ids = listWorkerSessionsForIssue(issueId).map((s) => s.id);
  assert.ok(ids.indexOf(s1.id) < ids.indexOf(s2.id));
});

test("a fresh session starts queued with no worktree path", () => {
  const session = createWorkerSession({ issueId, role: "reviewer", round: 1, agentId: BUILTIN_AGENT_CLAUDE_ID, runtime: "claude_code" });
  assert.equal(session.status, "queued");
  assert.equal(session.worktreePath, null);
  assert.equal(session.startedAt, null);
});
