// NOT-102 acceptance: auto-merge on/off, merge failure escalation, recent repos.
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not102-"));

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, getIssue, listRecentRepos } = await import("../repository/issues.js");
const { listHumanActionsForIssue } = await import("../repository/human-actions.js");
const { getActiveWorkflowInstance, listWorkflowEventsForIssue } = await import(
  "../repository/workflow-events.js"
);
const { claimWorkItem, listWorkItemsForIssue } = await import("../repository/work-items.js");
const { startWorkflow, applyCompletion } = await import("./commands.js");
const { ReviewerResult } = await import("./reviewer-result.js");
const { setMergePrForTests, clearFinalizeInflightForTests } = await import("./auto-merge.js");

before(() => migrate());
beforeEach(() => {
  getDb().exec(`
    DELETE FROM work_items;
    DELETE FROM human_actions;
    DELETE FROM workflow_events;
    DELETE FROM findings;
    DELETE FROM review_publications;
    DELETE FROM worker_sessions;
    DELETE FROM artifacts;
    DELETE FROM usage_events;
    DELETE FROM workflow_instances;
    DELETE FROM issues;
  `);
  clearFinalizeInflightForTests();
  setMergePrForTests(async () => ({ ok: true }));
});
afterEach(() => {
  setMergePrForTests(null);
  clearFinalizeInflightForTests();
});

function newIssue(opts: { autoMerge?: boolean; repo?: string } = {}): string {
  return createIssue({
    title: "Coordinate me",
    description: "d",
    acceptanceCriteria: "It works",
    repo: opts.repo ?? "/repo/a",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
    autoMerge: opts.autoMerge ?? false,
  }).id;
}

function claim(issueId: string) {
  const item = claimWorkItem(`test-${issueId}`, { leaseMs: 60_000 });
  assert.ok(item && item.issueId === issueId, "expected to lease this issue's work item");
  return item!;
}

async function complete(issueId: string, outcome: Parameters<typeof applyCompletion>[2]) {
  const item = claim(issueId);
  return applyCompletion(item.id, item.leaseToken!, outcome);
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

const cleanHandoff = {
  kind: "clean_handoff",
  branch: "issue-1",
  headSha: "abc123",
  baseSha: "base1",
  prNumber: 42,
  prUrl: "https://gh/pr/42",
} as const;

test("autoMerge off: reviewer approve opens final_review and does not merge yet", async () => {
  const calls: Array<{ cwd: string; number: number }> = [];
  setMergePrForTests(async (opts) => {
    calls.push(opts);
    return { ok: true };
  });

  const issueId = newIssue({ autoMerge: false });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await complete(issueId, { kind: "verdict", result: okReview("approved") });

  assert.equal(getIssue(issueId)!.status, "final_review");
  assert.equal(getIssue(issueId)!.currentOwner, "human");
  assert.ok(listHumanActionsForIssue(issueId).find((a) => a.actionType === "final_review"));
  assert.equal(calls.length, 0);
});

test("autoMerge off: final_review complete undrafts+merges then marks done", async () => {
  const { resolveHumanActionAndAdvanceAsync } = await import("./commands.js");
  const calls: Array<{ cwd: string; number: number }> = [];
  setMergePrForTests(async (opts) => {
    calls.push(opts);
    return { ok: true };
  });

  const issueId = newIssue({ autoMerge: false });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await complete(issueId, { kind: "verdict", result: okReview("approved") });
  const action = listHumanActionsForIssue(issueId).find((a) => a.actionType === "final_review")!;

  const resolved = await resolveHumanActionAndAdvanceAsync(action.id, "yusuke", "complete");
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.issueStatus, "done");
    assert.equal(resolved.instanceCompleted, true);
    assert.equal(resolved.triggerReflect, true);
  }
  assert.deepEqual(calls, [{ cwd: "/repo/a", number: 42 }]);
  assert.equal(getIssue(issueId)!.status, "done");
  assert.equal(getActiveWorkflowInstance(issueId), null);
  assert.equal(listHumanActionsForIssue(issueId).filter((a) => a.status === "open").length, 0);
});

test("autoMerge off: final_review complete with merge failure escalates (never done with draft)", async () => {
  const { resolveHumanActionAndAdvanceAsync } = await import("./commands.js");
  setMergePrForTests(async () => ({ ok: false, reason: "protected branch" }));

  const issueId = newIssue({ autoMerge: false });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await complete(issueId, { kind: "verdict", result: okReview("approved") });
  const action = listHumanActionsForIssue(issueId).find((a) => a.actionType === "final_review")!;

  const resolved = await resolveHumanActionAndAdvanceAsync(action.id, "yusuke", "complete");
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.issueStatus, "needs_human");
    assert.equal(resolved.instanceCompleted, false);
  }
  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human");
  assert.match(issue.currentIntent ?? "", /protected branch/);
  assert.ok(listHumanActionsForIssue(issueId).some((a) => a.actionType === "policy_escalation" && a.status === "open"));
});

test("autoMerge on: reviewer approve merges PR, marks done, skips final_review human action", async () => {
  const calls: Array<{ cwd: string; number: number }> = [];
  setMergePrForTests(async (opts) => {
    calls.push(opts);
    return { ok: true };
  });

  const issueId = newIssue({ autoMerge: true });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  const result = await complete(issueId, { kind: "verdict", result: okReview("approved") });

  assert.equal(result.applied, true);
  if (result.applied) {
    assert.equal(result.instanceCompleted, true);
    assert.equal(result.triggerReflect, true);
  }
  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "done");
  assert.equal(getActiveWorkflowInstance(issueId), null);
  assert.equal(
    listHumanActionsForIssue(issueId).filter((a) => a.actionType === "final_review").length,
    0
  );
  assert.deepEqual(calls, [{ cwd: "/repo/a", number: 42 }]);
  assert.ok(listWorkflowEventsForIssue(issueId).some((e) => e.type === "issue.completed"));
});

test("autoMerge on: merge failure escalates to policy_escalation; issue not left half-done as final_review", async () => {
  setMergePrForTests(async () => ({ ok: false, reason: "required status checks failed" }));

  const issueId = newIssue({ autoMerge: true });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await complete(issueId, { kind: "verdict", result: okReview("approved") });

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human");
  assert.equal(issue.currentOwner, "human");
  assert.match(issue.currentIntent ?? "", /Auto-merge failed/);
  const action = listHumanActionsForIssue(issueId).find(
    (a) => a.actionType === "policy_escalation" && a.status === "open"
  );
  assert.ok(action, "expected open policy_escalation after merge failure");
  assert.match(action!.reason, /required status checks failed/);
  assert.ok(getActiveWorkflowInstance(issueId), "workflow stays active for human resume");
  assert.equal(listWorkItemsForIssue(issueId).filter((i) => i.status === "pending").length, 0);
});

test("autoMerge on: gh timeout reason escalates (bounded hang must not leave final_review park)", async () => {
  const { GH_MERGE_TIMEOUT_MS } = await import("./auto-merge.js");
  setMergePrForTests(async () => ({
    ok: false,
    reason: `gh timed out after ${GH_MERGE_TIMEOUT_MS}ms`,
  }));

  const issueId = newIssue({ autoMerge: true });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await complete(issueId, { kind: "verdict", result: okReview("approved") });

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human");
  const action = listHumanActionsForIssue(issueId).find(
    (a) => a.actionType === "policy_escalation" && a.status === "open"
  );
  assert.ok(action);
  assert.match(action!.reason, /timed out after/);
});

test("listRecentRepos returns distinct local paths newest-first", () => {
  const base = {
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main" as const,
    source: "manual" as const,
    acceptanceCriteria: "x",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
  };
  createIssue({ ...base, title: "old", repo: "/repos/alpha" });
  const later = createIssue({ ...base, title: "new", repo: "/repos/beta" });
  createIssue({ ...base, title: "alpha again", repo: "/repos/alpha" });
  getDb().prepare("UPDATE issues SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), later.id);

  const repos = listRecentRepos();
  assert.equal(repos[0], "/repos/beta");
  assert.ok(repos.includes("/repos/alpha"));
  assert.equal(repos.filter((r) => r === "/repos/alpha").length, 1);
});

test("recoverStrandedAutoMerges finalizes a parked auto-merge after a simulated crash", async () => {
  const { recoverStrandedAutoMerges, AUTO_MERGE_INTENT } = await import("./auto-merge.js");
  const { transitionIssue } = await import("../repository/issues.js");

  setMergePrForTests(async () => ({ ok: true }));
  const issueId = newIssue({ autoMerge: true });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  // Simulate crash after approve routing parked for auto-merge but before finalize.
  // reviewing → final_review is legal; park with the recovery intent key.
  transitionIssue(issueId, "reviewing", { currentOwner: "reviewer", currentIntent: "reviewing" });
  // Need a pending reviewer item completed first — simplify: just set park state after handoff
  // left us in reviewing with a pending reviewer. Cancel that path and force the park.
  getDb().exec("DELETE FROM work_items");
  transitionIssue(issueId, "final_review", {
    currentOwner: "system",
    currentIntent: AUTO_MERGE_INTENT,
    prNumber: 42,
    prUrl: "https://gh/pr/42",
  });

  assert.equal(getIssue(issueId)!.status, "final_review");
  assert.equal(getIssue(issueId)!.currentIntent, AUTO_MERGE_INTENT);
  assert.ok(getActiveWorkflowInstance(issueId));

  const recovered = await recoverStrandedAutoMerges();
  assert.ok(recovered.finalized.includes(issueId));
  assert.equal(getIssue(issueId)!.status, "done");
});

test("recoverStrandedAutoMerges recovers human-complete park even when autoMerge is off", async () => {
  const { recoverStrandedAutoMerges, AUTO_MERGE_INTENT } = await import("./auto-merge.js");
  const { transitionIssue } = await import("../repository/issues.js");

  setMergePrForTests(async () => ({ ok: true }));
  const issueId = newIssue({ autoMerge: false });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  transitionIssue(issueId, "reviewing", { currentOwner: "reviewer", currentIntent: "reviewing" });
  getDb().exec("DELETE FROM work_items");
  transitionIssue(issueId, "final_review", {
    currentOwner: "system",
    currentIntent: AUTO_MERGE_INTENT,
    prNumber: 42,
    prUrl: "https://gh/pr/42",
  });

  const recovered = await recoverStrandedAutoMerges();
  assert.ok(recovered.finalized.includes(issueId));
  assert.equal(getIssue(issueId)!.status, "done");
});

/** Park an auto-merge issue at final_review/system/AUTO_MERGE_INTENT with an active workflow. */
async function parkForAutoMerge(issueId: string): Promise<void> {
  const { AUTO_MERGE_INTENT } = await import("./auto-merge.js");
  const { transitionIssue } = await import("../repository/issues.js");
  transitionIssue(issueId, "reviewing", { currentOwner: "reviewer", currentIntent: "reviewing" });
  getDb().exec("DELETE FROM work_items");
  transitionIssue(issueId, "final_review", {
    currentOwner: "system",
    currentIntent: AUTO_MERGE_INTENT,
    prNumber: 42,
    prUrl: "https://gh/pr/42",
  });
}

test("concurrent finalizeAutoMerge calls coalesce: one merge, done, no dangling policy_escalation", async () => {
  const { finalizeAutoMerge, recoverStrandedAutoMerges } = await import("./auto-merge.js");

  let merges = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  setMergePrForTests(async () => {
    merges += 1;
    await gate;
    return { ok: true };
  });

  const issueId = newIssue({ autoMerge: true });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await parkForAutoMerge(issueId);

  const p1 = finalizeAutoMerge(issueId);
  const p2 = finalizeAutoMerge(issueId);
  const p3 = recoverStrandedAutoMerges();
  // Give the first finalize a chance to register inflight before recover lists stranded.
  await Promise.resolve();
  release();
  const [r1, r2, recovered] = await Promise.all([p1, p2, p3]);

  assert.equal(merges, 1, "concurrent callers must share one gh merge");
  assert.equal(r1.issueStatus, "done");
  assert.equal(r2.issueStatus, "done");
  assert.equal(getIssue(issueId)!.status, "done");
  assert.equal(getActiveWorkflowInstance(issueId), null);
  assert.equal(
    listHumanActionsForIssue(issueId).filter((a) => a.status === "open").length,
    0,
    "must not leave an open policy_escalation on a done issue"
  );
  // recover may skip (inflight filter) or coalesce — either way no error and issue is done.
  assert.equal(recovered.errors.length, 0);
});

test("success txn dismisses stale needs_human policy_escalation from a racing failure", async () => {
  const { finalizeAutoMerge } = await import("./auto-merge.js");
  const { transitionIssue } = await import("../repository/issues.js");
  const { createHumanAction } = await import("../repository/human-actions.js");

  let issueId = "";
  setMergePrForTests(async () => {
    // Simulate a racing escalateMergeFailure that wrote needs_human + open action
    // before this success path's DB transaction runs.
    const inst = getActiveWorkflowInstance(issueId)!;
    transitionIssue(issueId, "needs_human", {
      currentOwner: "human",
      currentIntent: "Auto-merge failed: transient rate limit",
    });
    createHumanAction({
      issueId,
      workflowInstanceId: inst.id,
      actionType: "policy_escalation",
      reason: "Auto-merge failed: transient rate limit",
      question: "Auto-merge failed: transient rate limit Resume development, or close the issue?",
      responseOptions: [
        { choice: "resume", label: "Resume development" },
        { choice: "close", label: "Close" },
      ],
    });
    return { ok: true };
  });

  issueId = newIssue({ autoMerge: true });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await parkForAutoMerge(issueId);

  const result = await finalizeAutoMerge(issueId);
  assert.equal(result.issueStatus, "done");
  assert.equal(getIssue(issueId)!.status, "done");
  const open = listHumanActionsForIssue(issueId).filter(
    (a) => a.actionType === "policy_escalation" && a.status === "open"
  );
  assert.equal(open.length, 0, "stale policy_escalation must be resolved on success");
  const resolved = listHumanActionsForIssue(issueId).find(
    (a) => a.actionType === "policy_escalation" && a.status === "resolved"
  );
  assert.ok(resolved, "expected the racing escalation to be marked resolved");
});

test("escalate txn no-ops when a racing success already marked the issue done", async () => {
  const { finalizeAutoMerge } = await import("./auto-merge.js");
  const { transitionIssue } = await import("../repository/issues.js");
  const { completeWorkflowInstance } = await import("../repository/workflow-events.js");

  let issueId = "";
  setMergePrForTests(async () => {
    // Simulate a racing success that completed the issue before this failure path escalates.
    const inst = getActiveWorkflowInstance(issueId)!;
    transitionIssue(issueId, "done", {
      currentOwner: "system",
      currentIntent: "Auto-merged after reviewer approval",
    });
    completeWorkflowInstance(inst.id, "done");
    return { ok: false, reason: "transient rate limit" };
  });

  issueId = newIssue({ autoMerge: true });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await parkForAutoMerge(issueId);

  const result = await finalizeAutoMerge(issueId);
  assert.equal(result.issueStatus, "done");
  assert.equal(getIssue(issueId)!.status, "done");
  assert.equal(
    listHumanActionsForIssue(issueId).filter((a) => a.status === "open").length,
    0,
    "must not open policy_escalation on an already-done issue"
  );
});
