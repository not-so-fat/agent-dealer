import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-issues-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, getIssue, listIssues, transitionIssue, incrementIssueRound } = await import("./issues.js");

before(() => {
  migrate();
});

function makeInput(title: string) {
  return {
    title,
    repo: "/repo",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    source: "manual" as const,
  };
}

test("creates an issue with defaults", () => {
  const issue = createIssue(makeInput("Fix login bug"));
  assert.equal(issue.status, "ready");
  assert.equal(issue.currentOwner, "system");
  assert.equal(issue.currentRound, 1);
  assert.deepStrictEqual(getIssue(issue.id), issue);
});

test("lists issues filtered by status", () => {
  const issue = createIssue(makeInput("Filterable issue"));
  assert.ok(listIssues("ready").some((i) => i.id === issue.id));
  assert.equal(listIssues("done").some((i) => i.id === issue.id), false);
});

test("transitions an issue and rejects an invalid transition", () => {
  const issue = createIssue(makeInput("Transition me"));
  const developing = transitionIssue(issue.id, "developing", { currentOwner: "developer" });
  assert.equal(developing.status, "developing");
  assert.equal(developing.currentOwner, "developer");
  assert.throws(() => transitionIssue(issue.id, "final_review"), /Invalid transition/);
});

test("increments the round counter", () => {
  const issue = createIssue(makeInput("Round me"));
  const bumped = incrementIssueRound(issue.id);
  assert.equal(bumped.currentRound, 2);
});
