// NOT-314: `[operator]` gate — approved reviews block before merge until a
// human records the result, then merge on verified/waive and repair on repair.
// DB-backed (same harness shape as auto-merge.integration.test.ts).
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not314-"));

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, getIssue, updateIssue } = await import("../repository/issues.js");
const { listHumanActionsForIssue } = await import("../repository/human-actions.js");
const { listArtifactsForIssueByKind } = await import("../repository/artifacts-for-issue.js");
const { listWorkflowEventsForIssue, getActiveWorkflowInstance } = await import(
  "../repository/workflow-events.js"
);
const { claimWorkItem, getWorkItem } = await import("../repository/work-items.js");
const {
  startWorkflow,
  applyCompletion,
  resolveHumanActionAndAdvance,
  resolveHumanActionAndAdvanceAsync,
  responseOptionsFor,
} = await import("./commands.js");
const { ReviewerResult } = await import("./reviewer-result.js");
const {
  setMergePrForTests,
  clearFinalizeInflightForTests,
  finalizeAutoMerge,
  OPERATOR_VERIFICATION_INTENT,
} = await import("./auto-merge.js");
const { stubManagedCloneForTests } = await import("../adapters/managed-repo.js");

const OPERATOR_AC = [
  "- [ ] Agent can list sessions from the registry",
  "- [ ] Operator can sign in with SSO and see the org dashboard [operator]",
  "  - `npm run probe:sso -- --env staging`",
  "- [ ] Docs describe the probe",
].join("\n");

let managedCwd = "";

before(() => {
  migrate();
  managedCwd = stubManagedCloneForTests("acme/app");
});
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

function newIssue(acceptanceCriteria = OPERATOR_AC): string {
  return createIssue({
    title: "Coordinate me",
    description: "d",
    acceptanceCriteria,
    repo: "acme/app",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
    autoMerge: true,
  }).id;
}

function claim(issueId: string) {
  const item = claimWorkItem(`test-${issueId}`, { leaseMs: 60_000 });
  assert.ok(item && item.issueId === issueId, "expected to lease this issue's work item");
  return item!;
}

const okReview = ReviewerResult.parse({
  verdict: "approved",
  baseSha: "b",
  headSha: "h",
  acceptanceCriteriaAssessment: "ok",
  evidenceAssessment: "ok",
  findings: [],
  risks: [],
});

const cleanHandoff: {
  kind: "clean_handoff";
  branch: string;
  headSha: string;
  baseSha: string;
  prNumber: number;
  prUrl: string;
} = {
  kind: "clean_handoff",
  branch: "issue-1",
  headSha: "abc123",
  baseSha: "base1",
  prNumber: 42,
  prUrl: "https://gh/pr/42",
};

/** Developer handoff + approved review with autoMerge on (routes into finalize). */
async function approve(issueId: string, handoff = cleanHandoff) {
  const dev = claim(issueId);
  await applyCompletion(dev.id, dev.leaseToken!, handoff);
  const rev = claim(issueId);
  return applyCompletion(rev.id, rev.leaseToken!, { kind: "verdict", result: okReview });
}

function openOperatorAction(issueId: string) {
  const action = listHumanActionsForIssue(issueId).find(
    (a) => a.actionType === "operator_verification" && a.status === "open"
  );
  assert.ok(action, "expected an open operator_verification action");
  return action!;
}

test("approved review with an [operator] AC raises operator_verification and never merges", async () => {
  const calls: Array<{ cwd: string; number: number }> = [];
  setMergePrForTests(async (opts) => {
    calls.push(opts);
    return { ok: true };
  });

  const issueId = newIssue();
  startWorkflow(issueId);
  const result = await approve(issueId);

  assert.equal(result.applied, true);
  if (result.applied) assert.equal(result.issueStatus, "needs_human");
  assert.equal(calls.length, 0, "the merge adapter must not run behind the gate");

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human");
  assert.equal(issue.currentOwner, "human");
  assert.equal(issue.currentIntent, OPERATOR_VERIFICATION_INTENT);
  assert.ok(getActiveWorkflowInstance(issueId), "workflow stays active for the human decision");

  const action = openOperatorAction(issueId);
  assert.match(action.question, /sign in with SSO/);
  assert.match(action.question, /npm run probe:sso -- --env staging/);
  const evidence = JSON.parse(action.evidenceJson!) as {
    operatorVerification: { headSha: string; criteria: Array<{ text: string; commands: string[] }> };
  };
  assert.equal(evidence.operatorVerification.headSha, "abc123");
  assert.equal(evidence.operatorVerification.criteria.length, 1);
  assert.deepEqual(evidence.operatorVerification.criteria[0]!.commands, [
    "`npm run probe:sso -- --env staging`",
  ]);
  const options = JSON.parse(action.responseOptionsJson!) as Array<{ choice: string; label: string }>;
  assert.deepEqual(
    options.map((o) => o.choice),
    ["verified", "waive", "repair"]
  );
});

test("a second finalize for the same head reuses the open action — still no merge", async () => {
  let merges = 0;
  setMergePrForTests(async () => {
    merges += 1;
    return { ok: true };
  });

  const issueId = newIssue();
  startWorkflow(issueId);
  await approve(issueId);
  const first = openOperatorAction(issueId).id;

  const again = await finalizeAutoMerge(issueId);
  assert.equal(again.humanActionId, first);
  assert.equal(again.issueStatus, "needs_human");
  assert.equal(merges, 0);
  assert.equal(
    listHumanActionsForIssue(issueId).filter(
      (a) => a.actionType === "operator_verification" && a.status === "open"
    ).length,
    1
  );
});

test("no [operator] AC: the existing auto-merge path is unchanged", async () => {
  const calls: Array<{ cwd: string; number: number }> = [];
  setMergePrForTests(async (opts) => {
    calls.push(opts);
    return { ok: true };
  });

  const issueId = newIssue("It works");
  startWorkflow(issueId);
  const result = await approve(issueId);

  assert.equal(result.applied, true);
  if (result.applied) {
    assert.equal(result.issueStatus, "done");
    assert.equal(result.instanceCompleted, true);
  }
  assert.deepEqual(calls, [{ cwd: managedCwd, number: 42 }]);
  assert.equal(getIssue(issueId)!.status, "done");
});

test("the gate reads the frozen snapshot, not live edits after start", async () => {
  const calls: Array<{ cwd: string; number: number }> = [];
  setMergePrForTests(async (opts) => {
    calls.push(opts);
    return { ok: true };
  });

  const issueId = newIssue("It works");
  startWorkflow(issueId);
  updateIssue(issueId, { acceptanceCriteria: OPERATOR_AC });
  await approve(issueId);

  assert.equal(getIssue(issueId)!.status, "done", "a tag added after freeze must not gate");
  assert.equal(calls.length, 1);
});

test("verified with a note stores the artifact and merges", async () => {
  const calls: Array<{ cwd: string; number: number }> = [];
  setMergePrForTests(async (opts) => {
    calls.push(opts);
    return { ok: true };
  });

  const issueId = newIssue();
  startWorkflow(issueId);
  await approve(issueId);
  const action = openOperatorAction(issueId);

  const resolved = await resolveHumanActionAndAdvanceAsync(action.id, "op", "verified", {
    note: "SSO login OK — org dashboard listed 3 orgs (probe output pasted).",
  });
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.issueStatus, "done");
    assert.equal(resolved.instanceCompleted, true);
    assert.equal(resolved.triggerReflect, true);
  }
  assert.deepEqual(calls, [{ cwd: managedCwd, number: 42 }]);
  assert.equal(getIssue(issueId)!.status, "done");

  const stored = listArtifactsForIssueByKind(issueId, "operator_verification");
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.author, "human");
  const content = JSON.parse(stored[0]!.contentJson!) as {
    headSha: string;
    note: string;
    verifiedBy: string;
  };
  assert.equal(content.headSha, "abc123");
  assert.match(content.note, /SSO login OK/);
  assert.equal(content.verifiedBy, "op");
  assert.equal(
    listHumanActionsForIssue(issueId).filter((a) => a.status === "open").length,
    0
  );
});

test("waive with a note records the waiver event and merges", async () => {
  const calls: Array<{ cwd: string; number: number }> = [];
  setMergePrForTests(async (opts) => {
    calls.push(opts);
    return { ok: true };
  });

  const issueId = newIssue();
  startWorkflow(issueId);
  await approve(issueId);
  const action = openOperatorAction(issueId);

  const resolved = await resolveHumanActionAndAdvanceAsync(action.id, "op", "waive", {
    note: "Staging SSO is down today; shipping behind the flag, will verify tomorrow.",
  });
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.equal(resolved.issueStatus, "done");
  assert.equal(calls.length, 1);
  assert.equal(getIssue(issueId)!.status, "done");

  const waived = listWorkflowEventsForIssue(issueId).filter(
    (e) => e.type === "operator_verification.waived"
  );
  assert.equal(waived.length, 1);
  const payload = JSON.parse(waived[0]!.payloadJson!) as { headSha: string; note: string };
  assert.equal(payload.headSha, "abc123");
  assert.match(payload.note, /Staging SSO is down/);
});

test("repair starts a repair round, threads the note, and a new head re-blocks the gate", async () => {
  const calls: Array<{ cwd: string; number: number }> = [];
  setMergePrForTests(async (opts) => {
    calls.push(opts);
    return { ok: true };
  });

  const issueId = newIssue();
  startWorkflow(issueId);
  await approve(issueId);
  const first = openOperatorAction(issueId);

  const repaired = resolveHumanActionAndAdvance(first.id, "op", "repair", {
    note: "The probe 404s — its path moved; fix the script and the doc.",
  });
  assert.equal(repaired.ok, true);
  if (repaired.ok) {
    assert.equal(repaired.issueStatus, "repairing");
    assert.ok(repaired.nextWorkItemId, "a repair round must be queued");
  }
  assert.equal(calls.length, 0, "repair must not merge");
  const next = getWorkItem(repaired.ok ? repaired.nextWorkItemId! : "");
  assert.ok(next, "expected the queued repair work item");
  const repairPayload = JSON.parse(next!.payloadJson!) as { operatorRepairNote?: string };
  assert.equal(
    repairPayload.operatorRepairNote,
    "The probe 404s — its path moved; fix the script and the doc."
  );

  // The repair round ships a new head; approving it must gate again on the new SHA.
  const secondHandoff = { ...cleanHandoff, headSha: "new999" };
  await approve(issueId, secondHandoff);
  assert.equal(calls.length, 0, "the new head must not merge unverified");
  const second = openOperatorAction(issueId);
  assert.notEqual(second.id, first.id, "a moved head gets a fresh gate action");
  const evidence = JSON.parse(second.evidenceJson!) as {
    operatorVerification: { headSha: string };
  };
  assert.equal(evidence.operatorVerification.headSha, "new999");
});

test("an empty note is rejected with 400 for every choice and leaves the action open", () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  return approve(issueId).then(() => {
    const action = openOperatorAction(issueId);
    for (const choice of ["verified", "waive", "repair"] as const) {
      for (const note of [undefined, "", "   "]) {
        const result = resolveHumanActionAndAdvance(action.id, "op", choice, { note });
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.code, 400, `${choice} with empty note must 400`);
      }
    }
    assert.equal(openOperatorAction(issueId).id, action.id, "the action must stay open");
  });
});

test("an unknown choice on operator_verification is rejected with 400", () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  return approve(issueId).then(() => {
    const action = openOperatorAction(issueId);
    const result = resolveHumanActionAndAdvance(action.id, "op", "merge", {
      note: "has a note but wrong choice",
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 400);
  });
});

test("responseOptionsFor(operator_verification) matches the gate's stored options", () => {
  assert.deepEqual(
    responseOptionsFor("operator_verification"),
    [
      { choice: "verified", label: "Verified — merge" },
      { choice: "waive", label: "Waive — merge without it" },
      { choice: "repair", label: "Another repair round" },
    ]
  );
});
