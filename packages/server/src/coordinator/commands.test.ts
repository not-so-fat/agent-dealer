// packages/server/src/coordinator/commands.test.ts
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-cmds-"));

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, getIssue } = await import("../repository/issues.js");
const { listWorkflowEventsForIssue, getActiveWorkflowInstance } = await import(
  "../repository/workflow-events.js"
);
const { listHumanActionsForIssue } = await import("../repository/human-actions.js");
const { listFindingsForIssue } = await import("../repository/findings.js");
const { claimWorkItem, listWorkItemsForIssue, getWorkItem } = await import("../repository/work-items.js");
const { startWorkflow, applyCompletion, resolveHumanActionAndAdvance } = await import("./commands.js");
const { ReviewerResult } = await import("./reviewer-result.js");

before(() => migrate());

interface Opts {
  acceptanceCriteria?: string | null;
  maxReviewRounds?: number;
}
function newIssue(opts: Opts = {}): string {
  return createIssue({
    title: "Coordinate me",
    description: "d",
    acceptanceCriteria: opts.acceptanceCriteria === undefined ? "It works" : opts.acceptanceCriteria ?? undefined,
    repo: "/repo",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: opts.maxReviewRounds ?? 3,
    source: "manual",
  }).id;
}

/** Lease the issue's single queued work item (what the effect worker would do). */
function lease(issueId: string) {
  const item = claimWorkItem(`test-${issueId}`, { leaseMs: 60_000 });
  assert.ok(item && item.issueId === issueId, "expected to lease this issue's work item");
  return item!;
}

const okReview = (verdict: "approved" | "changes_requested" | "escalated") =>
  ReviewerResult.parse({
    verdict,
    baseSha: "b",
    headSha: "h",
    acceptanceCriteriaAssessment: "ok",
    evidenceAssessment: "ok",
    findings: [],
    risks: [],
  });
const cleanHandoff = { kind: "clean_handoff", headSha: "abc123", baseSha: "base1", prNumber: 42, prUrl: "https://gh/pr/42" } as const;

beforeEach(() => getDb().exec("DELETE FROM work_items"));

test("startWorkflow writes instance + workflow.started + a queued developer work item in one shot", () => {
  const issueId = newIssue();
  const res = startWorkflow(issueId);
  assert.equal(res.ok, true);
  if (res.ok !== true) return;

  assert.equal(getIssue(issueId)!.status, "developing");
  assert.equal(getActiveWorkflowInstance(issueId)!.id, res.instance.id);
  const items = listWorkItemsForIssue(issueId);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "developer");
  assert.equal(items[0].status, "pending");
  const types = listWorkflowEventsForIssue(issueId).map((e) => e.type);
  assert.deepEqual(types, ["workflow.started"]);
  assert.equal(listWorkflowEventsForIssue(issueId)[0].workflowInstanceId, res.instance.id);
});

test("startWorkflow with no acceptance criteria asks for a product scope decision and starts nothing", () => {
  const issueId = newIssue({ acceptanceCriteria: null });
  const res = startWorkflow(issueId);
  assert.equal(res.ok, "needs_scope_decision");
  assert.equal(getActiveWorkflowInstance(issueId), null);
  assert.equal(getIssue(issueId)!.status, "ready");
  const actions = listHumanActionsForIssue(issueId);
  assert.equal(actions[0].actionType, "product_scope_decision");
});

test("a second startWorkflow while active is rejected", () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  const again = startWorkflow(issueId);
  assert.equal(again.ok, false);
  if (again.ok === false) assert.equal(again.code, 409);
});

test("developer clean handoff → reviewing + a reviewer work item + PR recorded on the issue", () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  lease(issueId);
  const res = applyCompletion(listWorkItemsForIssue(issueId)[0].id, cleanHandoff);
  assert.equal(res.applied, true);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "reviewing");
  assert.equal(issue.headSha, "abc123");
  assert.equal(issue.prNumber, 42);
  const items = listWorkItemsForIssue(issueId);
  assert.equal(items.filter((i) => i.status === "pending" && i.kind === "reviewer").length, 1);
  const types = listWorkflowEventsForIssue(issueId).map((e) => e.type);
  assert.ok(types.includes("worker.completed") && types.includes("pull_request.opened"));
});

test("applyCompletion is idempotent — a duplicate completion advances the issue exactly once", () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  lease(issueId);
  const devItemId = listWorkItemsForIssue(issueId)[0].id;

  const first = applyCompletion(devItemId, cleanHandoff);
  assert.equal(first.applied, true);
  const second = applyCompletion(devItemId, cleanHandoff);
  assert.equal(second.applied, false);
  if (second.applied === false) assert.equal(second.reason, "already_done");

  assert.equal(listWorkItemsForIssue(issueId).filter((i) => i.kind === "reviewer").length, 1);
  assert.equal(
    listWorkflowEventsForIssue(issueId).filter((e) => e.type === "pull_request.opened").length,
    1
  );
});

test("reviewer approved → final_review human action; resolving complete finishes the workflow", () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  lease(issueId);
  applyCompletion(listWorkItemsForIssue(issueId)[0].id, cleanHandoff);
  const reviewerItem = lease(issueId);
  applyCompletion(reviewerItem.id, { kind: "verdict", result: okReview("approved") });

  assert.equal(getIssue(issueId)!.status, "final_review");
  const action = listHumanActionsForIssue(issueId).find((a) => a.actionType === "final_review");
  assert.ok(action);

  const resolved = resolveHumanActionAndAdvance(action!.id, "yusuke", "complete");
  assert.equal(resolved.ok, true);
  assert.equal(getIssue(issueId)!.status, "done");
  assert.equal(getActiveWorkflowInstance(issueId), null);
  const types = listWorkflowEventsForIssue(issueId).map((e) => e.type);
  assert.ok(types.includes("human_action.resolved") && types.includes("issue.completed"));
});

test("reviewer changes_requested with rounds left → repair round with a fresh developer work item", () => {
  const issueId = newIssue({ maxReviewRounds: 3 });
  startWorkflow(issueId);
  lease(issueId);
  applyCompletion(listWorkItemsForIssue(issueId)[0].id, cleanHandoff);
  const reviewerItem = lease(issueId);
  applyCompletion(reviewerItem.id, {
    kind: "verdict",
    result: {
      ...okReview("changes_requested"),
      findings: [{ fingerprint: "f1", severity: "blocking", title: "Bug", rationale: "why" }],
    },
  });

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "repairing");
  assert.equal(issue.currentRound, 2);
  const pending = listWorkItemsForIssue(issueId).filter((i) => i.status === "pending");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, "developer");
  assert.equal(pending[0].round, 2);
  assert.equal(listFindingsForIssue(issueId).length, 1);
  assert.ok(listWorkflowEventsForIssue(issueId).map((e) => e.type).includes("repair.started"));
});

test("reviewer changes_requested at the round limit → attempts_exhausted", () => {
  const issueId = newIssue({ maxReviewRounds: 1 });
  startWorkflow(issueId);
  lease(issueId);
  applyCompletion(listWorkItemsForIssue(issueId)[0].id, cleanHandoff);
  const reviewerItem = lease(issueId);
  applyCompletion(reviewerItem.id, { kind: "verdict", result: okReview("changes_requested") });

  assert.equal(getIssue(issueId)!.status, "needs_human");
  assert.equal(
    listHumanActionsForIssue(issueId).find((a) => a.status === "open")!.actionType,
    "attempts_exhausted"
  );
  assert.equal(listWorkItemsForIssue(issueId).filter((i) => i.status === "pending").length, 0);
});

test("developer failure with rounds left retries; the reviewer is never involved", () => {
  const issueId = newIssue({ maxReviewRounds: 3 });
  startWorkflow(issueId);
  lease(issueId);
  applyCompletion(listWorkItemsForIssue(issueId)[0].id, { kind: "session_failed" });

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "developing");
  assert.equal(issue.currentRound, 2);
  const pending = listWorkItemsForIssue(issueId).filter((i) => i.status === "pending");
  assert.deepEqual(pending.map((i) => [i.kind, i.round]), [["developer", 2]]);
});

test("a stale review re-queues a reviewer at the new head without consuming a round", () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  lease(issueId);
  applyCompletion(listWorkItemsForIssue(issueId)[0].id, cleanHandoff);
  const reviewerItem = lease(issueId);
  const before = getIssue(issueId)!.currentRound;
  applyCompletion(reviewerItem.id, { kind: "stale", currentHeadSha: "newhead9" });

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "reviewing");
  assert.equal(issue.currentRound, before);
  assert.equal(issue.headSha, "newhead9");
  const pending = listWorkItemsForIssue(issueId).filter((i) => i.status === "pending");
  assert.deepEqual(pending.map((i) => i.kind), ["reviewer"]);
});

test("applyCompletion on an unknown / non-leased work item is a no-op", () => {
  assert.deepEqual(applyCompletion("missing", { kind: "no_pr" }), { applied: false, reason: "not_found" });

  const issueId = newIssue();
  startWorkflow(issueId);
  const pendingId = listWorkItemsForIssue(issueId)[0].id; // never leased
  assert.deepEqual(applyCompletion(pendingId, { kind: "no_pr" }), { applied: false, reason: "not_leased" });
  assert.equal(getWorkItem(pendingId)!.status, "pending");
});
