import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-actions-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("./issues.js");
const { createHumanAction, resolveHumanAction, listOpenHumanActions, listHumanActionsForIssue } =
  await import("./human-actions.js");

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

test("creates an open action and lists it globally and per-issue", () => {
  const issueId = seedIssue("Action issue 1");
  const action = createHumanAction({
    issueId,
    actionType: "final_review",
    reason: "Reviewer approved",
    question: "Accept?",
    responseOptions: ["complete", "repair", "close"],
  });
  assert.equal(action.status, "open");
  assert.ok(listOpenHumanActions().some((a) => a.id === action.id));
  assert.deepStrictEqual(listHumanActionsForIssue(issueId).map((a) => a.id), [action.id]);
});

test("resolves an action and removes it from the open queue", () => {
  const issueId = seedIssue("Action issue 2");
  const action = createHumanAction({
    issueId,
    actionType: "final_review",
    reason: "Reviewer approved",
    question: "Accept?",
    responseOptions: ["complete", "repair", "close"],
  });
  const resolved = resolveHumanAction(action.id, "yusuke", { choice: "complete" });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolvedBy, "yusuke");
  assert.equal(
    listOpenHumanActions().some((a) => a.id === action.id),
    false
  );
});
