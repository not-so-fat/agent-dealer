import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-artifacts-issue-"));

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("./issues.js");
const { listArtifactsForIssue } = await import("./artifacts-for-issue.js");
const { recordUsageEvent } = await import("./usage-events.js");
const { createWorkerSession } = await import("./worker-sessions.js");

before(() => {
  migrate();
});

test("lists artifacts for an issue newest first, respects limit", () => {
  const issue = createIssue({ title: "T", repo: "/repo", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID, maxReviewRounds: 3, maxInfraAttempts: 3, source: "manual" });
  const db = getDb();
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    db.prepare(
      `INSERT INTO artifacts (id, issue_id, run_id, kind, content_json, author, created_at) VALUES (?, ?, NULL, 'task_snapshot', '{}', 'system', ?)`
    ).run(`art-${i}`, issue.id, new Date(now + i * 1000).toISOString());
  }
  const all = listArtifactsForIssue(issue.id);
  assert.equal(all.length, 3);
  assert.equal(all[0].id, "art-2"); // newest first

  const limited = listArtifactsForIssue(issue.id, { limit: 2 });
  assert.equal(limited.length, 2);
});

test("listUsageEventsForIssue returns recorded events", async () => {
  const { listUsageEventsForIssue } = await import("./usage-events.js");
  const issue = createIssue({ title: "U", repo: "/repo", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID, maxReviewRounds: 3, maxInfraAttempts: 3, source: "manual" });
  const session = createWorkerSession({ issueId: issue.id, role: "developer", round: 1, agentId: BUILTIN_AGENT_CLAUDE_ID, runtime: "claude_code" });
  recordUsageEvent({ issueId: issue.id, workerSessionId: session.id, role: "developer", costUsd: 1 });
  const events = listUsageEventsForIssue(issue.id);
  assert.equal(events.length, 1);
});
