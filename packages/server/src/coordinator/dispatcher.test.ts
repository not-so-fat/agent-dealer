import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-dispatcher-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, getIssue } = await import("../repository/issues.js");
const { createWorkerSession, getWorkerSession, listWorkerSessionsForIssue } = await import("../repository/worker-sessions.js");
const { createHumanAction } = await import("../repository/human-actions.js");
const { pollAndDispatch, reconcileStaleSessions } = await import("./dispatcher.js");
const { startIssueWorkflow } = await import("./session-lifecycle.js");

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

/** Fake deps: no real git/gh/spawn — mirrors session-lifecycle.test.ts's fakeDeps. */
function fakeDeps() {
  return {
    worktree: {
      addWorktree: async () => {},
      removeWorktree: async () => {},
      isWorktreeClean: async () => true,
      mergeBase: async () => "base-sha-1",
    },
    github: {
      viewPr: async () => ({ number: 1, url: "https://github.com/x/y/pull/1", headRefOid: "head-sha-1", baseRefName: "main", headRefName: "issue-branch", reviews: [] }),
      publishReview: async () => ({ ok: true as const, event: "APPROVE" as const }),
    },
    spawnDeveloper: async () => ({ exitCode: 0, transcript: "done", logPath: "/tmp/log" }),
    spawnReviewer: async () => ({ exitCode: 0, transcript: "reviewed", logPath: "/tmp/log" }),
  };
}

// Reviewer finding #1: nothing previously proved that starting an issue actually gets
// dispatched — pollAndDispatch (what index.ts wires into the server's poll timer) must
// pick up the queued round-1 developer session created by startIssueWorkflow and run it.
test("pollAndDispatch advances a freshly started issue's queued developer session", async () => {
  const issue = seedIssue();
  await startIssueWorkflow(issue.id, fakeDeps());

  const before = listWorkerSessionsForIssue(issue.id);
  assert.equal(before.length, 1);
  assert.equal(before[0].status, "queued");

  await pollAndDispatch(fakeDeps());

  const after = listWorkerSessionsForIssue(issue.id);
  assert.equal(after[0].status, "done");
  assert.equal(after.length, 2);
  assert.equal(after[1].role, "reviewer");
  assert.equal(getIssue(issue.id)?.status, "reviewing");
});

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
