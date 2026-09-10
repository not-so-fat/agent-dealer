import { test } from "node:test";
import assert from "node:assert/strict";
import { canTransitionIssue, CreateIssueInput, Issue } from "./issues.js";

test("issue transitions: ready to developing is allowed", () => {
  assert.equal(canTransitionIssue("ready", "developing"), true);
});

test("issue transitions: done is terminal", () => {
  assert.equal(canTransitionIssue("done", "developing"), false);
  assert.equal(canTransitionIssue("done", "closed"), false);
});

test("issue transitions: cannot skip straight from ready to final_review", () => {
  assert.equal(canTransitionIssue("ready", "final_review"), false);
});

test("issue transitions: final_review can send back to repairing", () => {
  assert.equal(canTransitionIssue("final_review", "repairing"), true);
});

test("Issue schema parses a well-formed issue", () => {
  const issue: Issue = {
    id: "11111111-1111-1111-1111-111111111111",
    source: "manual",
    externalId: null,
    externalLabel: null,
    externalUrl: null,
    title: "Fix login bug",
    description: null,
    acceptanceCriteria: null,
    repo: "/repo",
    baseBranch: "main",
    status: "ready",
    currentOwner: "system",
    currentIntent: null,
    developerAgentId: "22222222-2222-2222-2222-222222222222",
    reviewerAgentId: "33333333-3333-3333-3333-333333333333",
    maxReviewRounds: 3,
    currentRound: 1,
    branch: null,
    baseSha: null,
    headSha: null,
    prNumber: null,
    prUrl: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  assert.deepStrictEqual(Issue.parse(issue), issue);
});

test("CreateIssueInput defaults baseBranch to main and maxReviewRounds to 3", () => {
  const parsed = CreateIssueInput.parse({
    title: "Fix login bug",
    repo: "/repo",
    developerAgentId: "22222222-2222-2222-2222-222222222222",
    reviewerAgentId: "33333333-3333-3333-3333-333333333333",
  });
  assert.equal(parsed.baseBranch, "main");
  assert.equal(parsed.maxReviewRounds, 3);
  assert.equal(parsed.source, "manual");
});
