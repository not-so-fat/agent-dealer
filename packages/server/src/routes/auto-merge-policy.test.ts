// NOT-490: auto-merge policy changes on queued and in-flight issues — the policy-only
// PATCH path, its audit event, the frozen-input guard for mixed patches, and the
// linearization against reviewer-approval routing.
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Fastify from "fastify";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not490-"));

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CODEX_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { registerIssueRoutes } = await import("./issues.js");
const { createIssue, getIssue } = await import("../repository/issues.js");
const { listHumanActionsForIssue } = await import("../repository/human-actions.js");
const { listWorkflowEventsForIssue } = await import("../repository/workflow-events.js");
const { claimWorkItem } = await import("../repository/work-items.js");
const { enqueueIssue, getQueuedEntryForIssue, listQueuedEntries } = await import("../repository/queue-entries.js");
const { queueStatusForIssue, setAdmissionHealthCheckerForTests } = await import("../coordinator/admission.js");
const { startWorkflow, applyCompletion, getTaskSnapshot } = await import("../coordinator/commands.js");
const { ReviewerResult } = await import("../coordinator/reviewer-result.js");
const { setMergePrForTests, clearFinalizeInflightForTests } = await import("../coordinator/auto-merge.js");

let fixtureRepo = "";

before(() => {
  migrate();
  setAdmissionHealthCheckerForTests(async () => ({ ok: true }));
  // A real local checkout so the auto-merge finalizer resolves its cwd.
  fixtureRepo = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not490-repo-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: fixtureRepo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: fixtureRepo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: fixtureRepo });
  fs.writeFileSync(path.join(fixtureRepo, "README.md"), "hi\n");
  execFileSync("git", ["add", "."], { cwd: fixtureRepo });
  execFileSync("git", ["commit", "-m", "init"], { cwd: fixtureRepo });
});

let mergeCalls = 0;
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
    DELETE FROM queue_entries;
    DELETE FROM issues;
  `);
  mergeCalls = 0;
  clearFinalizeInflightForTests();
  setMergePrForTests(async () => {
    mergeCalls++;
    return { ok: true };
  });
});
afterEach(() => {
  setMergePrForTests(null);
  clearFinalizeInflightForTests();
});

async function buildApp() {
  const app = Fastify();
  await registerIssueRoutes(app);
  return app;
}

function newIssue(opts: {
  autoMerge: boolean;
  maxReviewRounds?: number;
  title?: string;
  acceptanceCriteria?: string;
}): string {
  return createIssue({
    title: opts.title ?? "Policy target",
    description: "d",
    acceptanceCriteria: opts.acceptanceCriteria ?? "It works",
    repo: fixtureRepo,
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: opts.maxReviewRounds ?? 3,
    maxInfraAttempts: 3,
    source: "manual",
    autoMerge: opts.autoMerge,
  }).id;
}

async function complete(issueId: string, outcome: Parameters<typeof applyCompletion>[2]) {
  const item = claimWorkItem(`test-${issueId}`, { leaseMs: 60_000 });
  assert.ok(item && item.issueId === issueId, "expected to lease this issue's work item");
  return applyCompletion(item!.id, item!.leaseToken!, outcome);
}

const review = (verdict: "approved" | "changes_requested") =>
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
  branch: "issue-490",
  headSha: "abc123",
  baseSha: "base1",
  prNumber: 42,
  prUrl: "https://gh/pr/42",
} as const;

function policyEvents(issueId: string) {
  return listWorkflowEventsForIssue(issueId).filter((e) => e.type === "issue.reassigned");
}

/** Every issue column except the policy itself and the write timestamp. */
function frozenView(issueId: string) {
  const { autoMerge: _a, updatedAt: _u, ...rest } = getIssue(issueId)!;
  return rest;
}

/** Drives a fresh autoMerge issue into each eligible pre-decision state. */
const ELIGIBLE: Array<{ status: string; setup: (autoMerge: boolean) => Promise<string> }> = [
  {
    status: "developing",
    setup: async (autoMerge) => {
      const id = newIssue({ autoMerge });
      assert.equal(startWorkflow(id).ok, true);
      return id;
    },
  },
  {
    status: "reviewing",
    setup: async (autoMerge) => {
      const id = newIssue({ autoMerge });
      startWorkflow(id);
      await complete(id, cleanHandoff);
      return id;
    },
  },
  {
    status: "repairing",
    setup: async (autoMerge) => {
      const id = newIssue({ autoMerge });
      startWorkflow(id);
      await complete(id, cleanHandoff);
      await complete(id, { kind: "verdict", result: review("changes_requested") });
      return id;
    },
  },
  {
    status: "needs_human",
    setup: async (autoMerge) => {
      // Review-round budget of 1: changes_requested parks at attempts_exhausted, which a
      // human resume continues in the same workflow.
      const id = newIssue({ autoMerge, maxReviewRounds: 1 });
      startWorkflow(id);
      await complete(id, cleanHandoff);
      await complete(id, { kind: "verdict", result: review("changes_requested") });
      return id;
    },
  },
];

test("NOT-490: a queued ready issue accepts an autoMerge-only update with queue entry, wait reason and other fields untouched", async () => {
  const app = await buildApp();
  const first = newIssue({ autoMerge: true, title: "Ahead" });
  const id = newIssue({ autoMerge: false });
  const behind = newIssue({ autoMerge: true, title: "Behind" });
  for (const issueId of [first, id, behind]) enqueueIssue(issueId);
  const queueBefore = listQueuedEntries();
  const statusBefore = queueStatusForIssue(id);
  const entryBefore = getQueuedEntryForIssue(id);
  const issueBefore = frozenView(id);
  assert.ok(entryBefore, "precondition: queued");

  const detailBefore = (await app.inject({ method: "GET", url: `/api/issues/${id}` })).json() as {
    autoMergePolicy: { editable: boolean; reason: string | null };
  };
  assert.deepEqual(detailBefore.autoMergePolicy, { editable: true, reason: null });

  const res = await app.inject({ method: "PATCH", url: `/api/issues/${id}`, payload: { autoMerge: true, updatedBy: "operator-1" } });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as { autoMerge: boolean }).autoMerge, true);
  assert.equal(getIssue(id)!.autoMerge, true);
  assert.equal(getIssue(id)!.status, "ready");
  assert.deepEqual(frozenView(id), issueBefore, "every other issue field is unchanged");
  assert.deepEqual(getQueuedEntryForIssue(id), entryBefore, "same queue entry");
  assert.deepEqual(listQueuedEntries(), queueBefore, "queue order and entries are untouched");
  assert.deepEqual(queueStatusForIssue(id), statusBefore, "same position and wait reason");

  const events = policyEvents(id);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.actorType, "human");
  assert.deepEqual(JSON.parse(events[0]!.payloadJson!), { fromAutoMerge: false, toAutoMerge: true, actor: "operator-1" });

  // A queued issue also refuses coordinator-owned fields smuggled beside the policy.
  for (const mixed of [{ autoMerge: false, branch: "x" }, { autoMerge: false, status: "done" }, { autoMerge: false, headSha: "s" }]) {
    const refused = await app.inject({ method: "PATCH", url: `/api/issues/${id}`, payload: mixed });
    assert.equal(refused.statusCode, 409, `mixed ${JSON.stringify(mixed)} must be refused`);
    assert.equal(getIssue(id)!.autoMerge, true, "no partial write");
    assert.equal(policyEvents(id).length, 1);
    assert.deepEqual(listQueuedEntries(), queueBefore);
  }

  // Idempotent no-op: 200, no event.
  const again = await app.inject({ method: "PATCH", url: `/api/issues/${id}`, payload: { autoMerge: true } });
  assert.equal(again.statusCode, 200);
  assert.equal(policyEvents(id).length, 1, "a no-op update records nothing");

  // And back off, attributed to the default actor.
  await app.inject({ method: "PATCH", url: `/api/issues/${id}`, payload: { autoMerge: false } });
  const after = policyEvents(id);
  assert.equal(after.length, 2);
  assert.deepEqual(JSON.parse(after[1]!.payloadJson!), { fromAutoMerge: true, toAutoMerge: false, actor: "human" });
  assert.deepEqual(listQueuedEntries(), queueBefore);
  await app.close();
});

for (const { status, setup } of ELIGIBLE) {
  test(`NOT-490: an active ${status} issue accepts an autoMerge-only update; a mixed patch is 409 with no partial write`, async () => {
    const app = await buildApp();
    const id = await setup(false);
    assert.equal(getIssue(id)!.status, status, "precondition");
    const snapshotBefore = JSON.stringify(getTaskSnapshot(getIssue(id)!));
    const issueBefore = frozenView(id);
    const eventsBefore = listWorkflowEventsForIssue(id).length;

    const detail = (await app.inject({ method: "GET", url: `/api/issues/${id}` })).json() as {
      autoMergePolicy: { editable: boolean };
    };
    assert.equal(detail.autoMergePolicy.editable, true);

    // Mixed patches that carry a frozen field fail closed and write nothing.
    for (const mixed of [
      { autoMerge: true, title: "New title" },
      { autoMerge: true, repo: "acme/other" },
      { autoMerge: true, developerAgentId: BUILTIN_AGENT_CODEX_ID },
      { autoMerge: true, maxReviewRounds: 9 },
      // Coordinator-owned fields the schema does not declare: a non-strict parse would
      // strip them, so the route must refuse on the raw body keys.
      { autoMerge: true, branch: "other" },
      { autoMerge: true, status: "done" },
      { autoMerge: true, headSha: "deadbeef" },
      { autoMerge: true, prNumber: 7 },
      { autoMerge: true, prUrl: "https://gh/pr/7" },
      { autoMerge: true, queuePosition: 0 },
    ]) {
      const res = await app.inject({ method: "PATCH", url: `/api/issues/${id}`, payload: mixed });
      assert.equal(res.statusCode, 409, `mixed ${JSON.stringify(mixed)} must be refused`);
      assert.equal(getIssue(id)!.autoMerge, false, "no partial write of the policy");
      assert.deepEqual(frozenView(id), issueBefore);
      assert.equal(listWorkflowEventsForIssue(id).length, eventsBefore);
    }

    const ok = await app.inject({ method: "PATCH", url: `/api/issues/${id}`, payload: { autoMerge: true } });
    assert.equal(ok.statusCode, 200);
    assert.equal(getIssue(id)!.autoMerge, true);
    assert.equal(getIssue(id)!.status, status, "status is untouched");
    assert.deepEqual(frozenView(id), issueBefore, "frozen inputs, branch, PR, rounds untouched");
    assert.equal(JSON.stringify(getTaskSnapshot(getIssue(id)!)), snapshotBefore, "frozen task snapshot untouched");
    const events = policyEvents(id);
    assert.equal(events.length, 1);
    assert.deepEqual(JSON.parse(events[0]!.payloadJson!), { fromAutoMerge: false, toAutoMerge: true, actor: "human" });
    assert.ok(events[0]!.workflowInstanceId, "the event is scoped to the live workflow");

    const noop = await app.inject({ method: "PATCH", url: `/api/issues/${id}`, payload: { autoMerge: true } });
    assert.equal(noop.statusCode, 200);
    assert.equal(policyEvents(id).length, 1);
    await app.close();
  });
}

test("NOT-490: a policy update committed before reviewer routing turns approval into the guarded auto-merge", async () => {
  const app = await buildApp();
  const id = newIssue({ autoMerge: false });
  startWorkflow(id);
  await complete(id, cleanHandoff);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/issues/${id}`, payload: { autoMerge: true } })).statusCode, 200);

  await complete(id, { kind: "verdict", result: review("approved") });
  assert.equal(getIssue(id)!.status, "done");
  assert.equal(mergeCalls, 1, "exactly one merge");
  assert.equal(listHumanActionsForIssue(id).filter((a) => a.actionType === "final_review").length, 0, "no final_review action");
  assert.equal(listWorkflowEventsForIssue(id).filter((e) => e.type === "final_review.requested").length, 0);
  await app.close();
});

test("NOT-490: a committed false policy routes approval to final_review and never merges", async () => {
  const app = await buildApp();
  const id = newIssue({ autoMerge: true });
  startWorkflow(id);
  await complete(id, cleanHandoff);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/issues/${id}`, payload: { autoMerge: false } })).statusCode, 200);

  await complete(id, { kind: "verdict", result: review("approved") });
  assert.equal(getIssue(id)!.status, "final_review");
  assert.equal(getIssue(id)!.currentOwner, "human");
  assert.equal(mergeCalls, 0);
  assert.equal(listHumanActionsForIssue(id).filter((a) => a.actionType === "final_review").length, 1);
  await app.close();
});

test("NOT-490: a reviewer decision committed first wins — the later update is 409 and creates no second effect", async () => {
  const app = await buildApp();
  const id = newIssue({ autoMerge: false });
  startWorkflow(id);
  await complete(id, cleanHandoff);
  await complete(id, { kind: "verdict", result: review("approved") });
  assert.equal(getIssue(id)!.status, "final_review");
  const eventsBefore = listWorkflowEventsForIssue(id).length;

  const detail = (await app.inject({ method: "GET", url: `/api/issues/${id}` })).json() as {
    autoMergePolicy: { editable: boolean; reason: string | null };
  };
  assert.equal(detail.autoMergePolicy.editable, false);
  assert.match(detail.autoMergePolicy.reason ?? "", /Merge/);

  const res = await app.inject({ method: "PATCH", url: `/api/issues/${id}`, payload: { autoMerge: true } });
  assert.equal(res.statusCode, 409);
  assert.match((res.json() as { error: string }).error, /no longer be changed/);
  assert.equal(getIssue(id)!.autoMerge, false);
  assert.equal(getIssue(id)!.status, "final_review");
  assert.equal(mergeCalls, 0, "no auto-merge effect");
  assert.equal(listHumanActionsForIssue(id).filter((a) => a.actionType === "final_review").length, 1, "one final_review action");
  assert.equal(listWorkflowEventsForIssue(id).length, eventsBefore, "no audit event for the losing update");
  await app.close();
});

test("NOT-490: while auto-merge finalization is in flight the policy is locked; the merge completes once", async () => {
  const app = await buildApp();
  let releaseMerge!: () => void;
  const mergeGate = new Promise<void>((resolve) => (releaseMerge = resolve));
  setMergePrForTests(async () => {
    mergeCalls++;
    await mergeGate;
    return { ok: true };
  });
  const id = newIssue({ autoMerge: true });
  startWorkflow(id);
  await complete(id, cleanHandoff);

  const approval = complete(id, { kind: "verdict", result: review("approved") });
  // The routing transaction commits before the async merge — wait for the park.
  for (let i = 0; i < 200 && getIssue(id)!.status !== "final_review"; i++) {
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(getIssue(id)!.status, "final_review");
  assert.equal(getIssue(id)!.currentOwner, "system");

  const detail = (await app.inject({ method: "GET", url: `/api/issues/${id}` })).json() as {
    autoMergePolicy: { editable: boolean; reason: string | null };
  };
  assert.equal(detail.autoMergePolicy.editable, false);
  assert.match(detail.autoMergePolicy.reason ?? "", /in flight/);
  const res = await app.inject({ method: "PATCH", url: `/api/issues/${id}`, payload: { autoMerge: false } });
  assert.equal(res.statusCode, 409);
  assert.equal(getIssue(id)!.autoMerge, true);

  releaseMerge();
  await approval;
  assert.equal(getIssue(id)!.status, "done");
  assert.equal(mergeCalls, 1);
  assert.equal(listHumanActionsForIssue(id).length, 0, "no human action created");
  assert.equal(policyEvents(id).length, 0);
  await app.close();
});

test("NOT-490: an operator-verification park after approval keeps the committed policy locked", async () => {
  const app = await buildApp();
  const id = newIssue({
    autoMerge: true,
    acceptanceCriteria: "- [ ] Operator signs in with SSO [operator]",
  });
  startWorkflow(id);
  await complete(id, cleanHandoff);
  await complete(id, { kind: "verdict", result: review("approved") });
  assert.equal(getIssue(id)!.status, "needs_human");
  const gate = listHumanActionsForIssue(id).filter((a) => a.status === "open");
  assert.deepEqual(gate.map((a) => a.actionType), ["operator_verification"], "precondition: parked at the gate");
  assert.equal(mergeCalls, 0);
  const eventsBefore = listWorkflowEventsForIssue(id).length;

  const detail = (await app.inject({ method: "GET", url: `/api/issues/${id}` })).json() as {
    autoMergePolicy: { editable: boolean; reason: string | null };
  };
  assert.equal(detail.autoMergePolicy.editable, false);
  assert.match(detail.autoMergePolicy.reason ?? "", /operator verification/);

  const res = await app.inject({ method: "PATCH", url: `/api/issues/${id}`, payload: { autoMerge: false } });
  assert.equal(res.statusCode, 409);
  assert.match((res.json() as { error: string }).error, /no longer be changed/);
  assert.equal(getIssue(id)!.autoMerge, true, "committed policy is unchanged");
  assert.equal(listWorkflowEventsForIssue(id).length, eventsBefore, "no audit event for the refused update");
  assert.equal(policyEvents(id).length, 0);
  await app.close();
});

test("NOT-490: a merge-failure park and terminal issues are read-only with an explanation", async () => {
  const app = await buildApp();
  setMergePrForTests(async () => ({ ok: false, reason: "protected branch" }));
  const id = newIssue({ autoMerge: true });
  startWorkflow(id);
  await complete(id, cleanHandoff);
  await complete(id, { kind: "verdict", result: review("approved") });
  assert.equal(getIssue(id)!.status, "needs_human");

  const parked = (await app.inject({ method: "GET", url: `/api/issues/${id}` })).json() as {
    autoMergePolicy: { editable: boolean; reason: string | null };
  };
  assert.equal(parked.autoMergePolicy.editable, false);
  assert.match(parked.autoMergePolicy.reason ?? "", /merge/);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/issues/${id}`, payload: { autoMerge: false } })).statusCode, 409);
  assert.equal(getIssue(id)!.autoMerge, true);

  setMergePrForTests(async () => ({ ok: true }));
  const done = newIssue({ autoMerge: true, title: "Done" });
  startWorkflow(done);
  await complete(done, cleanHandoff);
  await complete(done, { kind: "verdict", result: review("approved") });
  assert.equal(getIssue(done)!.status, "done");
  const doneDetail = (await app.inject({ method: "GET", url: `/api/issues/${done}` })).json() as {
    autoMergePolicy: { editable: boolean; reason: string | null };
  };
  assert.deepEqual(doneDetail.autoMergePolicy, { editable: false, reason: "The issue is done." });
  assert.equal((await app.inject({ method: "PATCH", url: `/api/issues/${done}`, payload: { autoMerge: false } })).statusCode, 409);
  assert.equal(policyEvents(done).length, 0);
  await app.close();
});
