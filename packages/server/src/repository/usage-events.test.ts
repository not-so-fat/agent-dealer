import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-usage-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("./issues.js");
const { createWorkerSession } = await import("./worker-sessions.js");
const { recordUsageEvent, summarizeIssueUsage } = await import("./usage-events.js");

before(() => {
  migrate();
});

test("records events and sums them per issue", () => {
  const issue = createIssue({
    title: "Usage issue",
    repo: "/repo",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    source: "manual",
  });
  const session = createWorkerSession({
    issueId: issue.id,
    role: "developer",
    round: 1,
    agentId: BUILTIN_AGENT_CLAUDE_ID,
    runtime: "claude_code",
  });
  recordUsageEvent({
    issueId: issue.id,
    workerSessionId: session.id,
    role: "developer",
    costUsd: 1.5,
    durationMs: 1000,
    tokensIn: 100,
    tokensOut: 50,
  });
  recordUsageEvent({
    issueId: issue.id,
    workerSessionId: session.id,
    role: "developer",
    costUsd: 2.25,
    durationMs: 2000,
    tokensIn: 200,
    tokensOut: 75,
  });
  const summary = summarizeIssueUsage(issue.id);
  assert.ok(Math.abs(summary.totalCostUsd - 3.75) < 0.001);
  assert.equal(summary.totalDurationMs, 3000);
  assert.equal(summary.totalTokensIn, 300);
  assert.equal(summary.totalTokensOut, 125);
});
