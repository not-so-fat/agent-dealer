import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-events-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("./issues.js");
const { appendWorkflowEvent, listWorkflowEventsForIssue } =
  await import("./workflow-events.js");

before(() => {
  migrate();
});

function seedIssue(title: string): string {
  return createIssue({
    title,
    repo: "/repo",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    source: "manual",
  }).id;
}

test("appends and lists events in timestamp order", () => {
  const issueId = seedIssue("Event issue");
  appendWorkflowEvent({
    issueId,
    type: "issue.created",
    actorType: "system",
    stage: "ready",
    payload: { note: "created" },
  });
  appendWorkflowEvent({
    issueId,
    type: "guidance.added",
    actorType: "human",
    stage: "ready",
  });
  const events = listWorkflowEventsForIssue(issueId);
  assert.deepStrictEqual(events.map((e) => e.type), ["issue.created", "guidance.added"]);
  assert.deepStrictEqual(JSON.parse(events[0].payloadJson!), { note: "created" });
});
