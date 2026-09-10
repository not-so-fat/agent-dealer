import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-dispatcher-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, getIssue } = await import("../repository/issues.js");
const { createWorkerSession, getWorkerSession } = await import("../repository/worker-sessions.js");
const { createHumanAction } = await import("../repository/human-actions.js");
const { reconcileStaleSessions } = await import("./dispatcher.js");

before(() => {
  migrate();
});

function seedIssue() {
  return createIssue({
    title: "Dispatcher issue",
    repo: "/tmp/fake-repo",
    baseBranch: "main",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    maxReviewRounds: 3,
    source: "manual",
  });
}

test("reconcileStaleSessions marks a stuck running developer session as failed", async () => {
  const issue = seedIssue();
  const session = createWorkerSession({ issueId: issue.id, role: "developer", round: 1, agentId: BUILTIN_AGENT_CLAUDE_ID, runtime: "claude_code" });

  // Simulate: claimed (running) a long time ago, heartbeat stale, process gone.
  const db = (await import("../db/index.js")).getDb();
  const staleTime = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  db.prepare("UPDATE worker_sessions SET status = 'running', started_at = ?, heartbeat_at = ? WHERE id = ?").run(staleTime, staleTime, session.id);

  const result = reconcileStaleSessions(60 * 60_000);
  assert.ok(result.reconciled.includes(session.id));
  assert.equal(getWorkerSession(session.id)?.status, "failed");
});

test("reconcileStaleSessions ignores sessions with a recent heartbeat", async () => {
  const issue = seedIssue();
  const session = createWorkerSession({ issueId: issue.id, role: "developer", round: 1, agentId: BUILTIN_AGENT_CLAUDE_ID, runtime: "claude_code" });
  const db = (await import("../db/index.js")).getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE worker_sessions SET status = 'running', started_at = ?, heartbeat_at = ? WHERE id = ?").run(now, now, session.id);

  const result = reconcileStaleSessions(60 * 60_000);
  assert.equal(result.reconciled.includes(session.id), false);
  assert.equal(getWorkerSession(session.id)?.status, "running");
});
