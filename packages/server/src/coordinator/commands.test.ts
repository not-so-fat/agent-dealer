// packages/server/src/coordinator/commands.test.ts
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-cmds-"));

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, getIssue, updateIssue } = await import("../repository/issues.js");
const { listWorkflowEventsForIssue, getActiveWorkflowInstance } = await import(
  "../repository/workflow-events.js"
);
const { createHumanAction, listHumanActionsForIssue } = await import("../repository/human-actions.js");
const { listFindingsForIssue, reconcileFinding } = await import("../repository/findings.js");
const { claimWorkItem, listWorkItemsForIssue, getWorkItem } = await import("../repository/work-items.js");
const { createWorkerSession, startSession, listWorkerSessionsForIssue } = await import(
  "../repository/worker-sessions.js"
);
const {
  startWorkflow,
  applyCompletion,
  resolveHumanActionAndAdvance,
  resolveHumanActionAndAdvanceAsync,
  getTaskSnapshot,
  TASK_SNAPSHOT_ARTIFACT_KIND,
  checkIssueReadiness,
  abortIssue} = await import("./commands.js");
const { ReviewerResult } = await import("./reviewer-result.js");
const { listArtifactsForIssue } = await import("../repository/artifacts-for-issue.js");
const { setMergePrForTests, clearFinalizeInflightForTests } = await import("./auto-merge.js");
const { stubManagedCloneForTests } = await import("../adapters/managed-repo.js");

before(() => migrate());
beforeEach(() => {
  getDb().exec("DELETE FROM work_items");
  clearFinalizeInflightForTests();
  setMergePrForTests(async () => ({ ok: true }));
  stubManagedCloneForTests("acme/app");
});

interface Opts {
  acceptanceCriteria?: string | null;
  maxReviewRounds?: number;
  maxInfraAttempts?: number;
}
function newIssue(opts: Opts = {}): string {
  return createIssue({
    title: "Coordinate me",
    description: "d",
    acceptanceCriteria: opts.acceptanceCriteria === undefined ? "It works" : opts.acceptanceCriteria ?? undefined,
    repo: "acme/app",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: opts.maxReviewRounds ?? 3,
    maxInfraAttempts: opts.maxInfraAttempts ?? 3,
    source: "manual"}).id;
}

/** Claim the issue's single queued work item (what the effect worker does) and return it. */
function claim(issueId: string) {
  const item = claimWorkItem(`test-${issueId}`, { leaseMs: 60_000 });
  assert.ok(item && item.issueId === issueId, "expected to lease this issue's work item");
  return item!;
}

/** Claim + apply the issue's current work item's outcome. */
async function complete(issueId: string, outcome: Parameters<typeof applyCompletion>[2]) {
  const item = claim(issueId);
  return { item, result: await applyCompletion(item.id, item.leaseToken!, outcome) };
}

const okReview = (verdict: "approved" | "changes_requested" | "escalated") =>
  ReviewerResult.parse({
    verdict,
    baseSha: "b",
    headSha: "h",
    acceptanceCriteriaAssessment: "ok",
    evidenceAssessment: "ok",
    findings: [],
    risks: []});
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

test("checkIssueReadiness reports missing acceptance criteria and is silent once satisfied", () => {
  const issueId = newIssue({ acceptanceCriteria: null });
  const before = checkIssueReadiness(getIssue(issueId)!);
  assert.equal(before.ok, false);
  assert.deepEqual(before.missing, ["acceptance criteria"]);

  const ready = checkIssueReadiness(getIssue(newIssue())!);
  assert.deepEqual(ready, { ok: true, missing: [] });
});

test("NOT-118: startWorkflow with no acceptance criteria fails the precondition and opens no product_scope_decision", () => {
  const issueId = newIssue({ acceptanceCriteria: null });
  const res = startWorkflow(issueId);
  assert.equal(res.ok, false);
  if (res.ok === false) {
    assert.equal(res.code, 400);
    assert.match(res.error, /acceptance criteria/i);
  }
  assert.equal(getActiveWorkflowInstance(issueId), null);
  assert.equal(getIssue(issueId)!.status, "ready");
  // Under-specified issues wait in the admission queue with a reason — they never open a
  // human action nobody asked for (NOT-118 reverses the pre-start scope gate).
  assert.equal(listHumanActionsForIssue(issueId).length, 0);
});

test("starting after criteria are added closes out a stale product_scope_decision instead of leaving it open", () => {
  const issueId = newIssue({ acceptanceCriteria: null });
  // A reviewer-escalated scope gate (routing.ts) that the operator answered by editing the
  // issue: it must not stay open beside a running workflow.
  const action = createHumanAction({
    issueId,
    actionType: "product_scope_decision",
    reason: "no acceptance criteria",
    question: "Add acceptance criteria",
    responseOptions: [{ choice: "resume", label: "Added — start" }]});

  updateIssue(issueId, { acceptanceCriteria: "It works now" });
  const started = startWorkflow(issueId);
  assert.equal(started.ok, true);

  assert.equal(listHumanActionsForIssue(issueId).find((a) => a.id === action.id)!.status, "resolved");
  assert.equal(getIssue(issueId)!.status, "developing");
});

test("a second startWorkflow while active is rejected with 409", () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  const again = startWorkflow(issueId);
  assert.equal(again.ok, false);
  if (again.ok === false) assert.equal(again.code, 409);
});

test("NOT-88: startWorkflow's 409 while an open human action is blocking names it, instead of an opaque dead end", async () => {
  const issueId = newIssue({ maxInfraAttempts: 0 });
  startWorkflow(issueId);
  await complete(issueId, { kind: "session_failed" }); // infra-exhausted on the first attempt -> policy_escalation

  const action = listHumanActionsForIssue(issueId).find((a) => a.status === "open")!;
  assert.equal(action.actionType, "policy_escalation");

  const again = startWorkflow(issueId);
  assert.equal(again.ok, false);
  if (again.ok === false) {
    assert.equal(again.code, 409);
    assert.match(again.error, /policy_escalation/);
    assert.match(again.error, new RegExp(action.id));
    assert.match(again.error, /resolve/i);
  }
});

test("developer clean handoff → reviewing + a reviewer work item + PR recorded on the issue", async () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  const { result } = await complete(issueId, cleanHandoff);
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

test("applyCompletion is idempotent — a duplicate completion (same or stale token) advances the issue once", async () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  const item = claim(issueId);

  const first = await applyCompletion(item.id, item.leaseToken!, cleanHandoff);
  assert.equal(first.applied, true);
  const second = await applyCompletion(item.id, item.leaseToken!, cleanHandoff);
  assert.equal(second.applied, false);
  if (second.applied === false) assert.equal(second.reason, "already_terminal");
  const third = await applyCompletion(item.id, "some-other-token", cleanHandoff);
  assert.equal(third.applied, false);

  assert.equal(listWorkItemsForIssue(issueId).filter((i) => i.kind === "reviewer").length, 1);
  assert.equal(
    listWorkflowEventsForIssue(issueId).filter((e) => e.type === "pull_request.opened").length,
    1
  );
});

test("reviewer approved → final_review human action; resolving complete merges and finishes the workflow", async () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await complete(issueId, { kind: "verdict", result: okReview("approved") });

  assert.equal(getIssue(issueId)!.status, "final_review");
  const action = listHumanActionsForIssue(issueId).find((a) => a.actionType === "final_review")!;
  assert.ok(action);

  const resolved = await resolveHumanActionAndAdvanceAsync(action.id, "yusuke", "complete");
  assert.equal(resolved.ok, true);
  assert.equal(getIssue(issueId)!.status, "done");
  assert.equal(getActiveWorkflowInstance(issueId), null);
  assert.equal((resolved as { triggerReflect: boolean }).triggerReflect, true);
  const types = listWorkflowEventsForIssue(issueId).map((e) => e.type);
  assert.ok(types.includes("human_action.resolved") && types.includes("issue.completed"));
});

test("resolving final_review as repair never sets triggerReflect", async () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await complete(issueId, { kind: "verdict", result: okReview("approved") });
  const action = listHumanActionsForIssue(issueId).find((a) => a.actionType === "final_review")!;

  const resolved = resolveHumanActionAndAdvance(action.id, "yusuke", "repair");
  assert.equal(resolved.ok, true);
  assert.equal((resolved as { triggerReflect: boolean }).triggerReflect, false);
});

test("reviewer changes_requested with rounds left → repair round with a fresh developer work item", async () => {
  const issueId = newIssue({ maxReviewRounds: 3 });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await complete(issueId, {
    kind: "verdict",
    result: {
      ...okReview("changes_requested"),
      findings: [{ fingerprint: "f1", severity: "blocking", title: "Bug", rationale: "why" }]}});

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "repairing");
  assert.equal(issue.currentRound, 2);
  const pending = listWorkItemsForIssue(issueId).filter((i) => i.status === "pending");
  assert.deepEqual(pending.map((i) => [i.kind, i.round]), [["developer", 2]]);
  assert.equal(listFindingsForIssue(issueId).length, 1);
  assert.ok(listWorkflowEventsForIssue(issueId).map((e) => e.type).includes("repair.started"));
});

test("a later completed review resolves findings it no longer reports and keeps re-reported ones", async () => {
  const issueId = newIssue({ maxReviewRounds: 4 });
  const otherId = newIssue({ maxReviewRounds: 4 });
  reconcileFinding({ issueId: otherId, fingerprint: "f1", severity: "blocking", title: "Other", rationale: "r", round: 1 });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  const finding = (fingerprint: string) => ({ fingerprint, severity: "blocking" as const, title: fingerprint, rationale: "why" });
  await complete(issueId, {
    kind: "verdict",
    result: { ...okReview("changes_requested"), findings: [finding("f1"), finding("f2")] }});
  await complete(issueId, cleanHandoff);
  await complete(issueId, {
    kind: "verdict",
    result: { ...okReview("changes_requested"), findings: [finding("f2"), finding("f3")] }});

  const byFp = Object.fromEntries(listFindingsForIssue(issueId).map((f) => [f.fingerprint, f]));
  assert.equal(byFp.f1.status, "resolved");
  assert.equal(byFp.f2.status, "recurring");
  assert.equal(byFp.f2.lastRound, 2);
  assert.equal(byFp.f3.status, "open");
  assert.equal(listFindingsForIssue(otherId)[0].status, "open", "other issues' findings are untouched");
});

test("a failed or verdict-less reviewer session resolves no findings", async () => {
  const issueId = newIssue({ maxReviewRounds: 4, maxInfraAttempts: 5 });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await complete(issueId, {
    kind: "verdict",
    result: { ...okReview("changes_requested"), findings: [{ fingerprint: "f1", severity: "blocking", title: "Bug", rationale: "why" }] }});
  await complete(issueId, cleanHandoff);
  await complete(issueId, { kind: "session_failed" });
  await complete(issueId, { kind: "stale", currentHeadSha: "head-B" });

  assert.deepEqual(listFindingsForIssue(issueId).map((f) => f.status), ["open"]);
});

test("reviewer changes_requested at the round limit → attempts_exhausted", async () => {
  const issueId = newIssue({ maxReviewRounds: 1 });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await complete(issueId, { kind: "verdict", result: okReview("changes_requested") });

  assert.equal(getIssue(issueId)!.status, "needs_human");
  assert.equal(
    listHumanActionsForIssue(issueId).find((a) => a.status === "open")!.actionType,
    "attempts_exhausted"
  );
  assert.equal(listWorkItemsForIssue(issueId).filter((i) => i.status === "pending").length, 0);
});

test("developer infra failure retries on the infra budget, not the review-round budget; the reviewer is never involved", async () => {
  const issueId = newIssue({ maxReviewRounds: 3 });
  startWorkflow(issueId);
  await complete(issueId, { kind: "session_failed" });

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "developing");
  assert.equal(issue.currentRound, 1, "an infra failure must not spend a review round");
  assert.equal(issue.infraAttempts, 1);
  const pending = listWorkItemsForIssue(issueId).filter((i) => i.status === "pending");
  assert.deepEqual(pending.map((i) => [i.kind, i.round]), [["developer", 1]]);
});

test("developer infra failures escalate as policy_escalation (not attempts_exhausted) once the infra-attempt limit is reached", async () => {
  const issueId = newIssue({ maxInfraAttempts: 0 });
  startWorkflow(issueId);
  await complete(issueId, { kind: "session_failed" });

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human");
  assert.equal(issue.currentRound, 1, "review-round budget is untouched by infra exhaustion");
  assert.equal(
    listHumanActionsForIssue(issueId).find((a) => a.status === "open")!.actionType,
    "policy_escalation"
  );
});

test("resolving attempts_exhausted:retry grants one more round instead of instantly re-exhausting", async () => {
  const issueId = newIssue({ maxReviewRounds: 1 });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await complete(issueId, { kind: "verdict", result: okReview("changes_requested") });
  assert.equal(getIssue(issueId)!.status, "needs_human");
  assert.deepEqual([getIssue(issueId)!.currentRound, getIssue(issueId)!.maxReviewRounds], [1, 1]);

  const action = listHumanActionsForIssue(issueId).find((a) => a.actionType === "attempts_exhausted")!;
  const resolved = resolveHumanActionAndAdvance(action.id, "yusuke", "retry");
  assert.equal(resolved.ok, true);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "repairing");
  // A "retry" must grant a fresh round, not just re-spend the one that was already
  // exhausted — otherwise the very next changes_requested re-creates attempts_exhausted.
  assert.deepEqual([issue.currentRound, issue.maxReviewRounds], [2, 2]);
  const pending = listWorkItemsForIssue(issueId).filter((i) => i.status === "pending");
  assert.deepEqual(pending.map((i) => [i.kind, i.round]), [["developer", 2]]);
  // currentIntent's round number must match the round the queued item actually carries.
  assert.equal(issue.currentIntent, "Developer implementing round 2");
});

test("resolving policy_escalation:resume resets the infra-attempt budget without spending a review round", async () => {
  const issueId = newIssue({ maxInfraAttempts: 1 });
  startWorkflow(issueId);
  await complete(issueId, { kind: "session_failed" }); // attempt 1: retries (0 < 1)
  await complete(issueId, { kind: "session_failed" }); // attempt 2: exhausts (1 < 1 is false)
  const before = getIssue(issueId)!;
  assert.equal(before.status, "needs_human");
  assert.equal(before.infraAttempts, 1);

  const action = listHumanActionsForIssue(issueId).find((a) => a.actionType === "policy_escalation")!;
  const resolved = resolveHumanActionAndAdvance(action.id, "yusuke", "resume");
  assert.equal(resolved.ok, true);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "developing");
  assert.equal(issue.infraAttempts, 0, "resuming past an infra escalation resets the infra budget");
  assert.equal(issue.currentRound, before.currentRound, "an infra resume must not spend a review round");
  const pending = listWorkItemsForIssue(issueId).filter((i) => i.status === "pending");
  assert.deepEqual(pending.map((i) => i.kind), ["developer"]);
  // currentIntent must say the round that's actually queued (unchanged), not currentRound + 1.
  assert.equal(issue.currentIntent, `Developer implementing round ${before.currentRound}`);
});

test("resolving policy_escalation:resume after a reviewer-side infra exhaustion re-queues a REVIEWER at the pinned head, not a developer", async () => {
  const issueId = newIssue({ maxInfraAttempts: 0 });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff); // -> reviewing, headSha pinned to cleanHandoff.headSha
  await complete(issueId, { kind: "session_failed" }); // 0 infra attempts allowed -> exhausts immediately

  const before = getIssue(issueId)!;
  assert.equal(before.status, "needs_human");
  const action = listHumanActionsForIssue(issueId).find((a) => a.actionType === "policy_escalation")!;
  assert.deepEqual(JSON.parse(action.continuationPreviewJson!), {
    resumeRole: "reviewer",
    resumeHeadSha: cleanHandoff.headSha});

  const resolved = resolveHumanActionAndAdvance(action.id, "yusuke", "resume");
  assert.equal(resolved.ok, true);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "reviewing", "nothing was wrong with the code — resuming re-reviews, it doesn't restart development");
  assert.equal(issue.currentOwner, "reviewer");
  assert.equal(issue.currentRound, before.currentRound, "an infra resume must not spend a review round");
  const pending = listWorkItemsForIssue(issueId).filter((i) => i.status === "pending");
  assert.deepEqual(pending.map((i) => i.kind), ["reviewer"]);
  assert.equal(JSON.parse(pending[0].payloadJson!).inputSha, cleanHandoff.headSha);
  // The action's own labels must match the operation it actually resumes.
  assert.match(action.question, /Retry the review/);
  assert.deepEqual(JSON.parse(action.responseOptionsJson!), [
    { choice: "resume", label: "Retry review" },
    { choice: "close", label: "Close" },
  ]);
});

test("resolving a reviewer-origin escalation records human_action.resolved under 'reviewing' and never emits repair.started", async () => {
  const issueId = newIssue({ maxInfraAttempts: 0 });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await complete(issueId, { kind: "session_failed" });
  const action = listHumanActionsForIssue(issueId).find((a) => a.actionType === "policy_escalation")!;
  resolveHumanActionAndAdvance(action.id, "yusuke", "resume");

  const events = listWorkflowEventsForIssue(issueId);
  const resolvedEvent = [...events].reverse().find((e) => e.type === "human_action.resolved")!;
  assert.equal(resolvedEvent.stage, "reviewing", "the resume's own events must reflect the status it actually resumes to");
  assert.ok(!events.some((e) => e.type === "repair.started"), "a reviewer resume is a review retry, not a repair round");
});

test("a reviewer head that cycles A→B→A does not collide with the original A enqueue's idempotency key", async () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff); // reviewer queued pinned to cleanHandoff.headSha ("A")
  await complete(issueId, { kind: "stale", currentHeadSha: "head-B" }); // -> reviewing at B, infraAttempts 1

  const afterB = getIssue(issueId)!;
  assert.equal(afterB.headSha, "head-B");
  assert.equal(afterB.infraAttempts, 1);

  await complete(issueId, { kind: "stale", currentHeadSha: cleanHandoff.headSha }); // cycles back to A
  const afterA = getIssue(issueId)!;
  assert.equal(afterA.headSha, cleanHandoff.headSha);
  assert.equal(afterA.infraAttempts, 2);
  assert.equal(afterA.status, "reviewing");

  // Without an attempt number in the key, this enqueue would derive the SAME idempotency
  // key as the original A enqueue (same instance/round/head) and collide with that now-
  // terminal work item, silently returning it instead of creating a new pending one.
  const pending = listWorkItemsForIssue(issueId).filter((i) => i.kind === "reviewer" && i.status === "pending");
  assert.equal(pending.length, 1, "a fresh reviewer item must be queued at the re-cycled head, not dropped via a key collision");
  assert.equal(JSON.parse(pending[0].payloadJson!).inputSha, cleanHandoff.headSha);
});

test("a stale review that exhausts the infra budget still records the newly observed head; resuming queues the reviewer there, not at the old pinned SHA", async () => {
  const issueId = newIssue({ maxInfraAttempts: 0 });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff); // reviewing at cleanHandoff.headSha ("A")
  await complete(issueId, { kind: "stale", currentHeadSha: "head-B" }); // 0 infra attempts allowed -> exhausts on this very stale event

  const before = getIssue(issueId)!;
  assert.equal(before.status, "needs_human");
  assert.equal(before.headSha, "head-B", "the newly observed head must be recorded even though no reviewer ran there yet");
  const action = listHumanActionsForIssue(issueId).find((a) => a.actionType === "policy_escalation")!;
  assert.deepEqual(JSON.parse(action.continuationPreviewJson!), { resumeRole: "reviewer", resumeHeadSha: "head-B" });

  const resolved = resolveHumanActionAndAdvance(action.id, "yusuke", "resume");
  assert.equal(resolved.ok, true);
  const pending = listWorkItemsForIssue(issueId).filter((i) => i.status === "pending");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, "reviewer");
  assert.equal(
    JSON.parse(pending[0].payloadJson!).inputSha,
    "head-B",
    "resuming must review the newly observed head, not the stale SHA that was pinned before the head moved"
  );
});

test("fail → retry → exhaust → resume → fail again does not collide with the pre-escalation retry's idempotency key", async () => {
  // Reproduces the reviewer's report: policy_escalation:resume resets infraAttempts to 0,
  // so an automatic retry after resuming can re-derive the exact (round, infraAttempts)
  // pair an earlier, now-terminal, PRE-escalation retry already used — an
  // infraAttempts-keyed enqueue would then collide and silently return that old row.
  const issueId = newIssue({ maxInfraAttempts: 1 });
  startWorkflow(issueId);

  await complete(issueId, { kind: "session_failed" }); // attempt 1: retries (infraAttempts 0 -> 1)
  const firstRetryItem = listWorkItemsForIssue(issueId).find((i) => i.status === "pending")!;
  assert.equal(getIssue(issueId)!.infraAttempts, 1);

  await complete(issueId, { kind: "session_failed" }); // attempt 2: exhausts (1 < 1 is false) -> policy_escalation
  assert.equal(getIssue(issueId)!.status, "needs_human");

  const action = listHumanActionsForIssue(issueId).find((a) => a.actionType === "policy_escalation")!;
  resolveHumanActionAndAdvance(action.id, "yusuke", "resume"); // resets infraAttempts to 0
  assert.equal(getIssue(issueId)!.infraAttempts, 0);

  await complete(issueId, { kind: "session_failed" }); // attempt after resume: retries again (0 -> 1) — SAME (round, infraAttempts) pair as the very first retry above

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "developing", "must still have live work, not silently stranded");
  assert.equal(issue.infraAttempts, 1);
  const pending = listWorkItemsForIssue(issueId).filter((i) => i.status === "pending");
  assert.equal(pending.length, 1, "a fresh item must be enqueued — the old (round, infraAttempts)-keyed row must not be silently reused");
  assert.notEqual(pending[0].id, firstRetryItem.id, "must be a NEW work item, not the pre-escalation retry's now-terminal row");
});

test("resolving product_scope_decision:resume after a reviewer's escalated+question resumes as the developer", async () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await complete(issueId, {
    kind: "verdict",
    result: { ...okReview("escalated"), productScopeQuestion: "Should deleted users retain sessions?" },
  });

  const action = listHumanActionsForIssue(issueId).find((a) => a.actionType === "product_scope_decision")!;
  assert.ok(action, "true product escalate opens product_scope_decision, not policy_escalation");

  const resolved = resolveHumanActionAndAdvance(action.id, "yusuke", "resume");
  assert.equal(resolved.ok, true);
  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "developing");
  const pending = listWorkItemsForIssue(issueId).filter((i) => i.status === "pending");
  assert.deepEqual(pending.map((i) => i.kind), ["developer"]);
});

test("NOT-150: bare escalated verdict remaps to automatic repair, not policy_escalation", async () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await complete(issueId, { kind: "verdict", result: okReview("escalated") });

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "repairing");
  assert.ok(!listHumanActionsForIssue(issueId).find((a) => a.actionType === "policy_escalation"));
  assert.equal(listWorkItemsForIssue(issueId).filter((i) => i.kind === "developer" && i.status === "pending").length, 1);
  const findings = listFindingsForIssue(issueId);
  assert.ok(
    findings.some((f) => f.severity === "blocking"),
    "bare escalate remap must thread a blocking finding into repair"
  );
});

test("a stale review re-queues a reviewer at the new head without consuming a round", async () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  const before = getIssue(issueId)!.currentRound;
  await complete(issueId, { kind: "stale", currentHeadSha: "newhead9" });

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "reviewing");
  assert.equal(issue.currentRound, before);
  assert.equal(issue.headSha, "newhead9");
  assert.deepEqual(
    listWorkItemsForIssue(issueId).filter((i) => i.status === "pending").map((i) => i.kind),
    ["reviewer"]
  );
});

test("applyCompletion on an unknown / never-leased work item is a no-op", async () => {
  assert.deepEqual(await applyCompletion("missing", "tok", { kind: "no_pr" }), {
    applied: false,
    reason: "not_found"});

  const issueId = newIssue();
  startWorkflow(issueId);
  const pendingId = listWorkItemsForIssue(issueId)[0].id; // never leased
  const res = await applyCompletion(pendingId, "tok", { kind: "no_pr" });
  assert.equal(res.applied, false);
  if (res.applied === false) assert.equal(res.reason, "lease_lost");
  assert.equal(getWorkItem(pendingId)!.status, "pending");
});

test("pre-start product_scope_decision: resolving without criteria leaves the action open", () => {
  const issueId = newIssue({ acceptanceCriteria: null });
  const actionId = createHumanAction({
    issueId,
    actionType: "product_scope_decision",
    reason: "no acceptance criteria",
    question: "Add acceptance criteria",
    responseOptions: [{ choice: "resume", label: "Added — start" }]}).id;

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

test("abortIssue closes a pre-start issue with no active workflow", () => {
  const issueId = newIssue();
  const result = abortIssue(issueId, "yusuke");
  assert.deepEqual(result, { ok: true, issueStatus: "closed", alreadyClosed: false });
  assert.equal(getIssue(issueId)!.status, "closed");
  const events = listWorkflowEventsForIssue(issueId).filter((e) => e.type === "issue.closed");
  assert.equal(events.length, 1);
  assert.equal(events[0].payloadJson, JSON.stringify({ reason: "aborted_by_user" }));
});

test("abortIssue mid-workflow cancels the pending work item, closes the instance, and emits one issue.closed event", () => {
  const issueId = newIssue();
  const started = startWorkflow(issueId);
  assert.equal(started.ok, true);
  const pendingItemId = listWorkItemsForIssue(issueId)[0].id;

  const result = abortIssue(issueId, "yusuke");
  assert.deepEqual(result, { ok: true, issueStatus: "closed", alreadyClosed: false });

  assert.equal(getWorkItem(pendingItemId)!.status, "cancelled");
  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "closed");
  assert.equal(getActiveWorkflowInstance(issueId), null);
  assert.equal(events(issueId).filter((e) => e.type === "issue.closed").length, 1);
});

test("abortIssue resolves an open human action and drops it out of the open set", () => {
  const issueId = newIssue({ acceptanceCriteria: null });
  const action = createHumanAction({
    issueId,
    actionType: "product_scope_decision",
    reason: "no acceptance criteria",
    question: "Add acceptance criteria",
    responseOptions: [{ choice: "resume", label: "Added — start" }]});
  assert.equal(action.status, "open");

  const result = abortIssue(issueId, "yusuke");
  assert.deepEqual(result, { ok: true, issueStatus: "closed", alreadyClosed: false });
  assert.equal(listHumanActionsForIssue(issueId).every((a) => a.status !== "open"), true);
});

test("abortIssue is idempotent once the issue is already closed", () => {
  const issueId = newIssue();
  abortIssue(issueId, "yusuke");
  const before = events(issueId).length;

  const result = abortIssue(issueId, "yusuke");
  assert.deepEqual(result, { ok: true, issueStatus: "closed", alreadyClosed: true });
  assert.equal(events(issueId).length, before, "a repeated abort must not append another event");
});

test("abortIssue on an already-done issue is a no-op", async () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await complete(issueId, { kind: "verdict", result: okReview("approved") });
  const finalReviewAction = listHumanActionsForIssue(issueId).find((a) => a.actionType === "final_review" && a.status === "open")!;
  const resolved = await resolveHumanActionAndAdvanceAsync(finalReviewAction.id, "yusuke", "complete");
  assert.equal(resolved.ok, true);
  assert.equal(getIssue(issueId)!.status, "done");

  const result = abortIssue(issueId, "yusuke");
  assert.deepEqual(result, { ok: true, issueStatus: "done", alreadyClosed: true });
  assert.equal(getIssue(issueId)!.status, "done");
});

test("abortIssue cancels a running worker session and terminates its registered process", () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  const item = claim(issueId);
  const session = createWorkerSession({
    issueId,
    role: "developer",
    round: 1,
    agentId: null,
    runtime: "claude_code"});
  startSession(session.id);

  const killed: string[] = [];
  const result = abortIssue(issueId, "yusuke", { killProcess: (id) => (killed.push(id), true) });
  assert.deepEqual(result, { ok: true, issueStatus: "closed", alreadyClosed: false });
  assert.deepEqual(killed, [session.id]);
  assert.equal(listWorkerSessionsForIssue(issueId).find((s) => s.id === session.id)!.status, "cancelled");
  assert.equal(getWorkItem(item.id)!.status, "cancelled");
});

test("a late completion after abort is fenced — applyCompletion is a no-op", async () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  const item = claim(issueId); // simulates the effect worker already holding the lease

  abortIssue(issueId, "yusuke");
  assert.equal(getIssue(issueId)!.status, "closed");

  // The zombie attempt's own completion arrives after the abort already committed.
  const res = await applyCompletion(item.id, item.leaseToken!, cleanHandoff);
  assert.equal(res.applied, false);
  assert.equal(getIssue(issueId)!.status, "closed", "a late completion must never reopen or mutate a closed issue");
});

function events(issueId: string) {
  return listWorkflowEventsForIssue(issueId);
}
