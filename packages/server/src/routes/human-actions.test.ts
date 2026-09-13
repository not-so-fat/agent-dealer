import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-action-routes-"));

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, transitionIssue, getIssue } = await import("../repository/issues.js");
const { createHumanAction, getHumanAction, listHumanActionsForIssue } = await import("../repository/human-actions.js");
const { registerHumanActionRoutes } = await import("./human-actions.js");
const { startWorkflow, applyCompletion } = await import("../coordinator/commands.js");
const { ReviewerResult } = await import("../coordinator/reviewer-result.js");
const { claimWorkItem } = await import("../repository/work-items.js");
const { listArtifactsForIssue } = await import("../repository/artifacts-for-issue.js");

before(() => {
  migrate();
});
// claimWorkItem is global FIFO, not issue-scoped — a leftover queued item from an earlier
// test would otherwise be claimed instead of the issue this test just started.
beforeEach(() => getDb().exec("DELETE FROM work_items"));

async function buildApp() {
  const app = Fastify();
  await registerHumanActionRoutes(app);
  return app;
}

function seedIssueAwaitingFinalReview() {
  const issue = createIssue({ title: "Awaiting review", repo: "/repo", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID, maxReviewRounds: 3, maxInfraAttempts: 3, source: "manual" });
  transitionIssue(issue.id, "developing");
  transitionIssue(issue.id, "reviewing");
  transitionIssue(issue.id, "final_review", { currentOwner: "human" });
  const action = createHumanAction({ issueId: issue.id, actionType: "final_review", reason: "Reviewer approved", question: "Accept?" });
  return { issue, action };
}

/** Drives a real issue through startWorkflow → clean developer handoff → reviewer
 * approval, so the resulting final_review human action carries a real workflow instance
 * (unlike seedIssueAwaitingFinalReview's hand-crafted transitions) — needed to exercise
 * resolveHumanActionAndAdvance's actual transactional path through the route. */
function seedRealIssueAwaitingFinalReview(): { issueId: string; actionId: string } {
  const issue = createIssue({ title: "Real workflow", repo: "/repo", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID, acceptanceCriteria: "Works", maxReviewRounds: 3, maxInfraAttempts: 3, source: "manual" });
  const start = startWorkflow(issue.id);
  assert.equal(start.ok, true);

  const devItem = claimWorkItem(`route-test-${issue.id}-dev`, { leaseMs: 60_000 })!;
  applyCompletion(devItem.id, devItem.leaseToken!, {
    kind: "clean_handoff",
    branch: `issue-${issue.id}`,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    prNumber: 1,
    prUrl: "https://gh/pr/1",
  });

  const reviewItem = claimWorkItem(`route-test-${issue.id}-rev`, { leaseMs: 60_000 })!;
  applyCompletion(reviewItem.id, reviewItem.leaseToken!, {
    kind: "verdict",
    result: ReviewerResult.parse({
      verdict: "approved",
      baseSha: "b".repeat(40),
      headSha: "a".repeat(40),
      acceptanceCriteriaAssessment: "met",
      evidenceAssessment: "fine",
      findings: [],
      risks: [],
    }),
  });

  assert.ok(getIssue(issue.id));
  const humanAction = listHumanActionsForIssue(issue.id).find((a) => a.actionType === "final_review")!;
  assert.ok(humanAction, "expected a final_review human action");
  return { issueId: issue.id, actionId: humanAction.id };
}

// NOT-58: the global queue is read-only. Typed resolution + continuation land in NOT-64.
test("GET /api/human-actions lists only open actions", async () => {
  const app = await buildApp();
  const { action } = seedIssueAwaitingFinalReview();
  const res = await app.inject({ method: "GET", url: "/api/human-actions" });
  const list = res.json() as Array<{ id: string; status: string }>;
  assert.ok(list.some((a) => a.id === action.id && a.status === "open"));
  await app.close();
});

test("POST resolve requires resolvedBy and choice", async () => {
  const app = await buildApp();
  const { action } = seedIssueAwaitingFinalReview();
  const res = await app.inject({ method: "POST", url: `/api/human-actions/${action.id}/resolve`, payload: {} });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test("POST resolve 400s (not 500) on non-string resolvedBy/choice values", async () => {
  const app = await buildApp();
  const { action } = seedIssueAwaitingFinalReview();
  const res = await app.inject({ method: "POST", url: `/api/human-actions/${action.id}/resolve`, payload: { resolvedBy: 123, choice: "complete" } });
  assert.equal(res.statusCode, 400);
  const res2 = await app.inject({ method: "POST", url: `/api/human-actions/${action.id}/resolve`, payload: { resolvedBy: "yusuke", choice: ["complete"] } });
  assert.equal(res2.statusCode, 400);
  await app.close();
});

test("POST resolve 404s for an unknown action", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "POST", url: `/api/human-actions/does-not-exist/resolve`, payload: { resolvedBy: "yusuke", choice: "complete" } });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("POST resolve 400s on a choice not valid for the action type", async () => {
  const app = await buildApp();
  const { action } = seedIssueAwaitingFinalReview();
  const res = await app.inject({ method: "POST", url: `/api/human-actions/${action.id}/resolve`, payload: { resolvedBy: "yusuke", choice: "retry" } });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test("POST resolve 409s on an already-resolved action", async () => {
  const app = await buildApp();
  const { actionId } = await seedRealIssueAwaitingFinalReview();
  const first = await app.inject({ method: "POST", url: `/api/human-actions/${actionId}/resolve`, payload: { resolvedBy: "yusuke", choice: "close" } });
  assert.equal(first.statusCode, 200);
  const second = await app.inject({ method: "POST", url: `/api/human-actions/${actionId}/resolve`, payload: { resolvedBy: "yusuke", choice: "close" } });
  assert.equal(second.statusCode, 409);
  await app.close();
});

test("POST resolve final_review:repair sends the issue back to a fresh developer round, no reflect artifact", async () => {
  const app = await buildApp();
  const { issueId, actionId } = await seedRealIssueAwaitingFinalReview();
  const res = await app.inject({ method: "POST", url: `/api/human-actions/${actionId}/resolve`, payload: { resolvedBy: "yusuke", choice: "repair" } });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { issueStatus: string; nextWorkItemId: string | null; instanceCompleted: boolean };
  assert.equal(body.issueStatus, "repairing");
  assert.ok(body.nextWorkItemId);
  assert.equal(body.instanceCompleted, false);
  assert.ok(!listArtifactsForIssue(issueId).some((a) => a.kind === "reflect_status" || a.kind === "playbook_patch"));
  await app.close();
});

test("POST resolve final_review:complete finishes the workflow and attempts reflect (skips: no deck configured)", async () => {
  const app = await buildApp();
  const { issueId, actionId } = await seedRealIssueAwaitingFinalReview();
  const res = await app.inject({ method: "POST", url: `/api/human-actions/${actionId}/resolve`, payload: { resolvedBy: "yusuke", choice: "complete" } });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { issueStatus: string; instanceCompleted: boolean };
  assert.equal(body.issueStatus, "done");
  assert.equal(body.instanceCompleted, true);
  const action = getHumanAction(actionId)!;
  assert.equal(action.status, "resolved");
  // The seeded issue uses the built-in developer agent, which has no deck configured —
  // triggerIssueReflect skips silently (no artifact) rather than throwing.
  assert.ok(!listArtifactsForIssue(issueId).some((a) => a.kind === "playbook_patch"));
  await app.close();
});

// NOT-94: a reflection_interaction_required action is raised against an issue that is
// already `done` with no active workflow instance — resolveHumanActionAndAdvance's normal
// path 409s on "no active workflow for this action" for any type but
// final_review/attempts_exhausted/product_scope_decision, so the route must dispatch this
// action type to resolveReflectionInteractionAction instead, never through that machine.
test("POST resolve on a reflection_interaction_required action bypasses the workflow state machine (issue already done, no active instance)", async () => {
  const app = await buildApp();
  const { issueId, actionId } = await seedRealIssueAwaitingFinalReview();
  const complete = await app.inject({ method: "POST", url: `/api/human-actions/${actionId}/resolve`, payload: { resolvedBy: "yusuke", choice: "complete" } });
  assert.equal(complete.statusCode, 200);
  assert.equal(getIssue(issueId)!.status, "done");

  const reflectAction = createHumanAction({
    issueId,
    actionType: "reflection_interaction_required",
    reason: "Approve the coordinator enrollment.",
    question: "Approve the coordinator enrollment. Retry the reflection, or dismiss?",
    responseOptions: [
      { choice: "retry", label: "Retry reflection" },
      { choice: "dismiss", label: "Dismiss" },
    ],
    requestId: "req_route_test",
  });

  const res = await app.inject({ method: "POST", url: `/api/human-actions/${reflectAction.id}/resolve`, payload: { resolvedBy: "yusuke", choice: "dismiss" } });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { issueStatus: string; nextWorkItemId: string | null; instanceCompleted: boolean; restarted: boolean };
  assert.equal(body.issueStatus, "done");
  assert.equal(body.nextWorkItemId, null);
  assert.equal(body.instanceCompleted, false);
  assert.equal(body.restarted, false);
  assert.equal(getHumanAction(reflectAction.id)!.status, "resolved");
  await app.close();
});

test("POST resolve 400s on a choice not valid for reflection_interaction_required", async () => {
  const app = await buildApp();
  const { issueId, actionId } = await seedRealIssueAwaitingFinalReview();
  await app.inject({ method: "POST", url: `/api/human-actions/${actionId}/resolve`, payload: { resolvedBy: "yusuke", choice: "complete" } });

  const reflectAction = createHumanAction({
    issueId,
    actionType: "reflection_interaction_required",
    reason: "Approve the coordinator enrollment.",
    question: "Retry the reflection, or dismiss?",
    responseOptions: [
      { choice: "retry", label: "Retry reflection" },
      { choice: "dismiss", label: "Dismiss" },
    ],
  });
  const res = await app.inject({ method: "POST", url: `/api/human-actions/${reflectAction.id}/resolve`, payload: { resolvedBy: "yusuke", choice: "close" } });
  assert.equal(res.statusCode, 400);
  await app.close();
});
