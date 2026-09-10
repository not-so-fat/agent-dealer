import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-reflect-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("../repository/issues.js");
const { listWorkflowEventsForIssue } = await import("../repository/workflow-events.js");
const { triggerReflectOnComplete } = await import("./reflect-trigger.js");

before(() => {
  migrate();
});

test("skips when no deck/playbook is configured for the developer profile", async () => {
  const issue = createIssue({
    title: "No deck",
    repo: "/tmp/fake-repo",
    baseBranch: "main",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    maxReviewRounds: 3,
    source: "manual",
  });
  const result = await triggerReflectOnComplete(issue.id, null, null);
  assert.equal(result, "skipped");
  assert.equal(listWorkflowEventsForIssue(issue.id).length, 0);
});
