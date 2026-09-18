import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-issues-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const {
  createIssue,
  getIssue,
  listIssues,
  transitionIssue,
  incrementIssueRound,
  findActiveIssueByExternalId,
  listIssuesByExternalId} = await import("./issues.js");

before(() => {
  migrate();
});

function makeInput(title: string) {
  return {
    title,
    repo: "acme/app",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual" as const};
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

test("NOT-141: the active-by-external-id lookup ignores terminal rows; the list keeps every pass", () => {
  const linear = { ...makeInput("Linear pass 1"), source: "linear" as const, externalId: "NOT-999" };
  const first = createIssue(linear);
  assert.equal(findActiveIssueByExternalId("linear", "NOT-999")?.id, first.id);

  transitionIssue(first.id, "closed");
  assert.equal(findActiveIssueByExternalId("linear", "NOT-999"), null, "a closed pass is not in flight");
  // The terminal pass is still on record — dependency verdicts read every pass.
  assert.deepEqual(listIssuesByExternalId("linear", "NOT-999").map((i) => i.id), [first.id]);

  // (source, external_id) is deliberately non-unique: a second pass is a second row.
  const second = createIssue({ ...linear, title: "Linear pass 2" });
  assert.notEqual(second.id, first.id);
  assert.equal(findActiveIssueByExternalId("linear", "NOT-999")?.id, second.id);
  // Newest first, so callers that want one answer get the current pass.
  assert.deepEqual(listIssuesByExternalId("linear", "NOT-999").map((i) => i.id), [second.id, first.id]);
});

test("terminal-scoped lookup is per (source, externalId) pair", () => {
  createIssue({ ...makeInput("Other source"), source: "agent" as const, externalId: "SHARED-1" });
  const linear = createIssue({ ...makeInput("Linear side"), source: "linear" as const, externalId: "SHARED-1" });
  assert.equal(findActiveIssueByExternalId("linear", "SHARED-1")?.id, linear.id);
  assert.equal(findActiveIssueByExternalId("manual", "SHARED-1"), null);
});
