import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-issues-"));

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const {
  createIssue,
  getIssue,
  listIssues,
  transitionIssue,
  incrementIssueRound,
  findActiveIssueByExternalId,
  listIssuesByExternalId,
  queryIssues,
  ISSUES_LIST_DEFAULT_LIMIT,
  ISSUES_LIST_MAX_LIMIT} = await import("./issues.js");
const { createHumanAction, resolveHumanAction } = await import("./human-actions.js");

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

test("NOT-228: search matches title case-insensitively and ignores unrelated rows", () => {
  const hit = createIssue(makeInput("NOT228 Quokka migration wobble"));
  createIssue(makeInput("NOT228 unrelated zebra"));
  const res = queryIssues({ search: "  WOBBLE " });
  assert.ok(res.rows.some((i) => i.id === hit.id), "title match survives case/whitespace");
  assert.ok(res.rows.every((i) => !i.title.includes("unrelated zebra")));
  assert.equal(res.page, 1);
  assert.equal(res.limit, ISSUES_LIST_DEFAULT_LIMIT);
});

test("NOT-228: search matches the external label case-insensitively", () => {
  const labeled = createIssue({
    ...makeInput("A plain title with no ticket in it"),
    source: "linear" as const,
    externalId: "ext-228-label",
    externalLabel: "NOT-175",
  });
  const res = queryIssues({ search: "not-175" });
  assert.ok(res.rows.some((i) => i.id === labeled.id), "external label match");
  assert.ok(
    res.rows.every((i) => i.id === labeled.id || (i.title + (i.externalLabel ?? "")).toLowerCase().includes("not-175")),
    "unrelated rows are excluded"
  );
});

test("NOT-228: search treats LIKE metacharacters literally", () => {
  const literal = createIssue(makeInput("NOT228 100% literal percent"));
  createIssue(makeInput("NOT228 1000 literal thousand"));
  const res = queryIssues({ search: "100%" });
  assert.ok(res.rows.some((i) => i.id === literal.id));
  assert.ok(res.rows.every((i) => (i.title + (i.externalLabel ?? "")).toLowerCase().includes("100%")));
});

test("NOT-228: status, repo, and search combine before pagination; totals describe the cohort", () => {
  const repo = "github.com/not228/combo";
  const a = createIssue({ ...makeInput("NOT228 combo alpha"), repo });
  const b = createIssue({ ...makeInput("NOT228 combo beta"), repo });
  createIssue({ ...makeInput("NOT228 combo other-repo"), repo: "github.com/not228/other" });
  transitionIssue(b.id, "developing");
  const res = queryIssues({ search: "combo", status: "ready", repo, limit: 1, page: 1 });
  assert.equal(res.total, 1);
  assert.equal(res.totalPages, 1);
  assert.deepEqual(res.rows.map((i) => i.id), [a.id]);
  const both = queryIssues({ search: "combo", repo });
  assert.equal(both.total, 2, "status omitted: both statuses match");
});

test("NOT-228: equal updated_at rows paginate repeatably with rowid DESC as tiebreaker", () => {
  const stamp = "2026-09-01T00:00:00.000Z";
  const ids = ["NOT228 tie one", "NOT228 tie two", "NOT228 tie three"].map(
    (t) => createIssue(makeInput(t)).id
  );
  for (const id of ids) {
    getDb().prepare("UPDATE issues SET updated_at = ? WHERE id = ?").run(stamp, id);
  }
  const first = queryIssues({ search: "NOT228 tie", limit: 2, page: 1 });
  const second = queryIssues({ search: "NOT228 tie", limit: 2, page: 2 });
  assert.equal(first.total, 3);
  assert.equal(first.totalPages, 2);
  // Newest rowid first: creation order was one, two, three.
  assert.deepEqual(first.rows.map((i) => i.id), [ids[2], ids[1]]);
  assert.deepEqual(second.rows.map((i) => i.id), [ids[0]]);
  const again = queryIssues({ search: "NOT228 tie", limit: 2, page: 1 });
  assert.deepEqual(again.rows.map((i) => i.id), first.rows.map((i) => i.id), "repeatable");
});

test("NOT-228: page/limit bounds clamp instead of erroring", () => {
  const res = queryIssues({ search: "NOT228 tie", page: 0, limit: 0 });
  assert.equal(res.page, 1);
  assert.equal(res.limit, ISSUES_LIST_DEFAULT_LIMIT);
  const capped = queryIssues({ search: "NOT228 tie", limit: 10_000 });
  assert.equal(capped.limit, ISSUES_LIST_MAX_LIMIT);
  const pastEnd = queryIssues({ search: "NOT228 tie", limit: 2, page: 99 });
  assert.deepEqual(pastEnd.rows, []);
  assert.equal(pastEnd.total, 3, "an out-of-range page keeps the cohort total");
  assert.equal(pastEnd.page, 99);
  const empty = queryIssues({ search: "NOT228 no-such-title-xyz" });
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.total, 0);
  assert.equal(empty.totalPages, 0);
});

test("NOT-228: needsAttention returns only issues with an open human action", () => {
  const flagged = createIssue(makeInput("NOT228 flagged attention"));
  const quiet = createIssue(makeInput("NOT228 quiet no-action"));
  const action = createHumanAction({
    issueId: flagged.id,
    actionType: "final_review",
    reason: "Reviewer approved",
    question: "Accept?",
    responseOptions: ["complete", "repair", "close"],
  });
  let res = queryIssues({ search: "NOT228 flagged attention", needsAttention: true });
  assert.deepEqual(res.rows.map((i) => i.id), [flagged.id]);
  res = queryIssues({ search: "NOT228 quiet no-action", needsAttention: true });
  assert.deepEqual(res.rows, [], "issues without open actions are excluded");
  resolveHumanAction(action.id, "tester", { choice: "complete" });
  res = queryIssues({ search: "NOT228 flagged attention", needsAttention: true });
  assert.deepEqual(res.rows, [], "resolved actions no longer flag the issue");
  assert.ok(queryIssues({ search: "NOT228 quiet no-action" }).rows.some((i) => i.id === quiet.id));
});
