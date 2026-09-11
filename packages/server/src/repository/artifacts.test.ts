// packages/server/src/repository/artifacts.test.ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-artifacts-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("./issues.js");
const { createIssueArtifact, latestIssueArtifact } = await import("./artifacts.js");
const { listArtifactsForIssue } = await import("./artifacts-for-issue.js");

before(() => migrate());

function issue(): string {
  return createIssue({
    title: "T",
    repo: "/repo",
    baseBranch: "main",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    maxReviewRounds: 3,
    source: "manual",
  }).id;
}

test("createIssueArtifact writes a row readable via listArtifactsForIssue", () => {
  const issueId = issue();
  const created = createIssueArtifact({ issueId, kind: "task_snapshot", author: "system", content: { title: "T" } });
  const listed = listArtifactsForIssue(issueId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, created.id);
  assert.equal(listed[0].kind, "task_snapshot");
  assert.deepEqual(JSON.parse(listed[0].contentJson!), { title: "T" });
  assert.equal(listed[0].workerSessionId, null);
});

test("latestIssueArtifact returns the newest row of that kind, ignoring other kinds", async () => {
  const issueId = issue();
  createIssueArtifact({ issueId, kind: "task_snapshot", author: "system", content: { v: 1 } });
  // created_at is millisecond-resolution — sleep past a tie so ordering is deterministic.
  await new Promise((r) => setTimeout(r, 5));
  const later = createIssueArtifact({ issueId, kind: "task_snapshot", author: "system", content: { v: 2 } });
  createIssueArtifact({ issueId, kind: "implementation_conclusion", author: "agent", content: { text: "done" } });

  const latest = latestIssueArtifact(issueId, "task_snapshot");
  assert.ok(latest);
  assert.equal(latest!.id, later.id);
  assert.equal(latest!.kind, "task_snapshot");

  assert.equal(latestIssueArtifact(issueId, "no_such_kind"), null);
});
