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
const { startWorkflow, applyCompletion, resolveHumanActionAndAdvance, getTaskSnapshot, TASK_SNAPSHOT_ARTIFACT_KIND } = await import("./commands.js");
const { ReviewerResult } = await import("./reviewer-result.js");
const { listArtifactsForIssue } = await import("../repository/artifacts-for-issue.js");

before(() => migrate());
beforeEach(() => getDb().exec("DELETE FROM work_items"));

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

/** Claim the issue's single queued work item (what the effect worker does) and return it. */
function claim(issueId: string) {
  const item = claimWorkItem(`test-${issueId}`, { leaseMs: 60_000 });
  assert.ok(item && item.issueId === issueId, "expected to lease this issue's work item");
  return item!;
}

/** Claim + apply the issue's current work item's outcome. */
function complete(issueId: string, outcome: Parameters<typeof applyCompletion>[2]) {
  const item = claim(issueId);
  return { item, result: applyCompletion(item.id, item.leaseToken!, outcome) };
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
const cleanHandoff = { kind: "clean_handoff", branch: "issue-1", headSha: "abc123", baseSha: "base1", prNumber: 42, prUrl: "https://gh/pr/42" } as const;

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
  assert.deepEqual(listWorkflowEventsForIssue(issueId).map((e) => e.type), ["workflow.started"]);
  assert.equal(listWorkflowEventsForIssue(issueId)[0].workflowInstanceId, res.instance.id);
});

test("startWorkflow freezes a task_snapshot artifact; getTaskSnapshot reads it back over live issue fields", () => {
  const issueId = newIssue();
  startWorkflow(issueId);

  const artifacts = listArtifactsForIssue(issueId).filter((a) => a.kind === TASK_SNAPSHOT_ARTIFACT_KIND);
  assert.equal(artifacts.length, 1);
  const content = JSON.parse(artifacts[0].contentJson!);
  assert.equal(content.title, "Coordinate me");
  assert.equal(content.acceptanceCriteria, "It works");

  const snapshot = getTaskSnapshot(getIssue(issueId)!);
  assert.equal(snapshot.title, "Coordinate me");
  assert.equal(snapshot.baseBranch, "main");
  assert.equal(snapshot.workflowVersion, "dev_reviewer_v1");
});

test("getTaskSnapshot falls back to live issue fields when no snapshot artifact exists", () => {
  const issueId = newIssue();
  const snapshot = getTaskSnapshot(getIssue(issueId)!);
  assert.equal(snapshot.title, "Coordinate me");
  assert.equal(snapshot.acceptanceCriteria, "It works");
});

test("startWorkflow with no acceptance criteria asks for a product scope decision and starts nothing", () => {
  const issueId = newIssue({ acceptanceCriteria: null });
  const res = startWorkflow(issueId);
  assert.equal(res.ok, "needs_scope_decision");
  assert.equal(getActiveWorkflowInstance(issueId), null);
  assert.equal(getIssue(issueId)!.status, "ready");
  assert.equal(listHumanActionsForIssue(issueId)[0].actionType, "product_scope_decision");
});

test("a second startWorkflow while active is rejected with 409", () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  const again = startWorkflow(issueId);
  assert.equal(again.ok, false);
  if (again.ok === false) assert.equal(again.code, 409);
});

test("developer clean handoff → reviewing + a reviewer work item + PR recorded on the issue", () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  const { result } = complete(issueId, cleanHandoff);
  assert.equal(result.applied, true);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "reviewing");
  assert.equal(issue.headSha, "abc123");
  assert.equal(issue.prNumber, 42);
  const reviewerItems = listWorkItemsForIssue(issueId).filter((i) => i.status === "pending" && i.kind === "reviewer");
  assert.equal(reviewerItems.length, 1);
  // The reviewer must be pinned to the coordinator-verified head SHA, not left to a live
  // resolve — a review round found the initial spawn_reviewer projection omitted this.
  assert.deepEqual(JSON.parse(reviewerItems[0].payloadJson!).inputSha, "abc123");
  const types = listWorkflowEventsForIssue(issueId).map((e) => e.type);
  assert.ok(types.includes("worker.completed") && types.includes("pull_request.opened"));
});

test("applyCompletion is idempotent — a duplicate completion (same or stale token) advances the issue once", () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  const item = claim(issueId);

  const first = applyCompletion(item.id, item.leaseToken!, cleanHandoff);
  assert.equal(first.applied, true);
  const second = applyCompletion(item.id, item.leaseToken!, cleanHandoff);
  assert.equal(second.applied, false);
  if (second.applied === false) assert.equal(second.reason, "already_terminal");
  const third = applyCompletion(item.id, "some-other-token", cleanHandoff);
  assert.equal(third.applied, false);

  assert.equal(listWorkItemsForIssue(issueId).filter((i) => i.kind === "reviewer").length, 1);
  assert.equal(
    listWorkflowEventsForIssue(issueId).filter((e) => e.type === "pull_request.opened").length,
    1
  );
});

test("reviewer approved → final_review human action; resolving complete finishes the workflow", () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  complete(issueId, cleanHandoff);
  complete(issueId, { kind: "verdict", result: okReview("approved") });

  assert.equal(getIssue(issueId)!.status, "final_review");
  const action = listHumanActionsForIssue(issueId).find((a) => a.actionType === "final_review")!;
  assert.ok(action);

  const resolved = resolveHumanActionAndAdvance(action.id, "yusuke", "complete");
  assert.equal(resolved.ok, true);
  assert.equal(getIssue(issueId)!.status, "done");
  assert.equal(getActiveWorkflowInstance(issueId), null);
  const types = listWorkflowEventsForIssue(issueId).map((e) => e.type);
  assert.ok(types.includes("human_action.resolved") && types.includes("issue.completed"));
});

test("reviewer changes_requested with rounds left → repair round with a fresh developer work item", () => {
  const issueId = newIssue({ maxReviewRounds: 3 });
  startWorkflow(issueId);
  complete(issueId, cleanHandoff);
  complete(issueId, {
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
  assert.deepEqual(pending.map((i) => [i.kind, i.round]), [["developer", 2]]);
  assert.equal(listFindingsForIssue(issueId).length, 1);
  assert.ok(listWorkflowEventsForIssue(issueId).map((e) => e.type).includes("repair.started"));
});

test("reviewer changes_requested at the round limit → attempts_exhausted", () => {
  const issueId = newIssue({ maxReviewRounds: 1 });
  startWorkflow(issueId);
  complete(issueId, cleanHandoff);
  complete(issueId, { kind: "verdict", result: okReview("changes_requested") });

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
  complete(issueId, { kind: "session_failed" });

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "developing");
  assert.equal(issue.currentRound, 2);
  const pending = listWorkItemsForIssue(issueId).filter((i) => i.status === "pending");
  assert.deepEqual(pending.map((i) => [i.kind, i.round]), [["developer", 2]]);
});

test("a stale review re-queues a reviewer at the new head without consuming a round", () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  complete(issueId, cleanHandoff);
  const before = getIssue(issueId)!.currentRound;
  complete(issueId, { kind: "stale", currentHeadSha: "newhead9" });

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "reviewing");
  assert.equal(issue.currentRound, before);
  assert.equal(issue.headSha, "newhead9");
  assert.deepEqual(
    listWorkItemsForIssue(issueId).filter((i) => i.status === "pending").map((i) => i.kind),
    ["reviewer"]
  );
});

test("applyCompletion on an unknown / never-leased work item is a no-op", () => {
  assert.deepEqual(applyCompletion("missing", "tok", { kind: "no_pr" }), {
    applied: false,
    reason: "not_found",
  });

  const issueId = newIssue();
  startWorkflow(issueId);
  const pendingId = listWorkItemsForIssue(issueId)[0].id; // never leased
  const res = applyCompletion(pendingId, "tok", { kind: "no_pr" });
  assert.equal(res.applied, false);
  if (res.applied === false) assert.equal(res.reason, "lease_lost");
  assert.equal(getWorkItem(pendingId)!.status, "pending");
});

test("pre-start product_scope_decision: resolving without criteria leaves the action open", () => {
  const issueId = newIssue({ acceptanceCriteria: null });
  const started = startWorkflow(issueId);
  assert.equal(started.ok, "needs_scope_decision");
  const actionId = listHumanActionsForIssue(issueId)[0].id;

  const bad = resolveHumanActionAndAdvance(actionId, "yusuke", "resume");
  assert.equal(bad.ok, false);
  assert.equal(listHumanActionsForIssue(issueId)[0].status, "open");
  assert.equal(getActiveWorkflowInstance(issueId), null);

  // criteria added → resolve now starts the workflow atomically
  getDb().prepare("UPDATE issues SET acceptance_criteria = 'Now testable' WHERE id = ?").run(issueId);
  const good = resolveHumanActionAndAdvance(actionId, "yusuke", "resume");
  assert.equal(good.ok, true);
  if (good.ok) assert.equal(good.restarted, true);
  assert.equal(listHumanActionsForIssue(issueId)[0].status, "resolved");
  assert.equal(getActiveWorkflowInstance(issueId)!.workflowVersion, "dev_reviewer_v1");
});
