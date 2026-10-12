// NOT-422: the NOT-405-like product-scope sequence end to end — reviewer
// escalation → amended Linear ticket adopted at the pause → Resume → next
// developer and reviewer enforce only the amended snapshot, on the same
// workflow, PR, branch, and worktree.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-scope-contract-"));

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, getIssue } = await import("../repository/issues.js");
const {
  startWorkflow,
  applyCompletion,
  resolveHumanActionAndAdvance,
  getTaskSnapshot,
  diffTaskSnapshotFromLive,
  TASK_SNAPSHOT_ARTIFACT_KIND,
} = await import("./commands.js");
const { reloadIssueSourceFromLinear } = await import("./source-reload.js");
const { claimWorkItem, listWorkItemsForIssue } = await import("../repository/work-items.js");
const { listHumanActionsForIssue } = await import("../repository/human-actions.js");
const { getActiveWorkflowInstance, listWorkflowEventsForIssue } = await import("../repository/workflow-events.js");
const { listArtifactsForIssue } = await import("../repository/artifacts-for-issue.js");
const { listWorkerSessionsForIssue } = await import("../repository/worker-sessions.js");
const { ReviewerResult } = await import("./reviewer-result.js");
const { buildDeveloperPrompt, buildReviewerPrompt } = await import("./prompts.js");
const { stubManagedCloneForTests } = await import("../adapters/managed-repo.js");

before(() => migrate());
beforeEach(() => {
  getDb().exec(`
    DELETE FROM work_items;
    DELETE FROM human_actions;
    DELETE FROM workflow_events;
    DELETE FROM worker_sessions;
    DELETE FROM artifacts;
    DELETE FROM workflow_instances;
    DELETE FROM queue_entries;
    DELETE FROM issues;
  `);
  stubManagedCloneForTests("acme/app");
});

// The ticket as frozen at workflow start: clean-machine proof is still an
// [operator] criterion the reviewer escalates on.
const CONTRACT_V1 = [
  "Ship the friend-path run command.",
  "",
  "## Builder execution mode",
  "feature",
  "",
  "## Non-goals",
  "- Rewriting the installer",
  "",
  "## Exit predicate",
  "The friend-path run command works on a clean machine with operator proof.",
  "",
  "## One-PR stopping point",
  "Stop after the run command lands with its regression test.",
  "",
  "## Acceptance criteria",
  "- [ ] Friend-path run works",
  "  Evidence: run fixtures | run the tests | green",
  "- [ ] [operator] Clean-machine proof attached",
  "  Evidence: operator run | paste the output | reviewed",
  "",
].join("\n");

// The amended ticket: clean-machine proof moved out, simulator proof in.
const CONTRACT_V2 = [
  "Ship the friend-path run command.",
  "",
  "## Builder execution mode",
  "feature",
  "",
  "## Non-goals",
  "- Rewriting the installer",
  "",
  "## Exit predicate",
  "The friend-path run command works with simulator proof; clean-machine proof moved out.",
  "",
  "## One-PR stopping point",
  "Stop after the run command lands with its regression test.",
  "",
  "## Acceptance criteria",
  "- [ ] Friend-path run works",
  "  Evidence: run fixtures | run the tests | green",
  "- [ ] Simulator proof attached",
  "  Evidence: simulator run | paste the output | reviewed",
  "",
].join("\n");

const REMOVED_CRITERION = "[operator] Clean-machine proof attached";
const AMENDED_EXIT = "The friend-path run command works with simulator proof; clean-machine proof moved out.";

test("NOT-422: reviewer escalation → scope-pause reload → Resume → both roles enforce only the amended snapshot", async () => {
  const issueId = createIssue({
    title: "NOT-405: friend-path run",
    description: CONTRACT_V1,
    repo: "acme/app",
    baseBranch: "main",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    source: "linear",
    externalId: "linear-uuid-405",
    externalLabel: "NOT-405",
    externalUrl: "https://linear.app/not-so-fat/issue/NOT-405/x",
  }).id;
  assert.equal(startWorkflow(issueId).ok, true);

  // Round 1: developer hands off, reviewer escalates a product-scope question.
  const dev1 = claimWorkItem("scope-contract-test", { leaseMs: 60_000 })!;
  await applyCompletion(dev1.id, dev1.leaseToken!, {
    kind: "clean_handoff",
    branch: "dealer/not-405",
    headSha: "abc123",
    baseSha: "base1",
    prNumber: 42,
    prUrl: "https://gh/pr/42",
  });
  const rev1 = claimWorkItem("scope-contract-test", { leaseMs: 60_000 })!;
  await applyCompletion(rev1.id, rev1.leaseToken!, {
    kind: "verdict",
    result: ReviewerResult.parse({
      verdict: "escalated",
      productScopeQuestion: "Is clean-machine operator proof still required?",
      baseSha: "b",
      headSha: "h",
      acceptanceCriteriaAssessment: "ok",
      evidenceAssessment: "ok",
      findings: [],
      risks: [],
    }),
  });
  const action = listHumanActionsForIssue(issueId).find((a) => a.actionType === "product_scope_decision")!;
  const instanceBefore = getActiveWorkflowInstance(issueId)!;
  const issueBefore = getIssue(issueId)!;
  assert.equal(issueBefore.status, "needs_human");
  // The frozen snapshot still enforces the old operator criterion.
  assert.ok(getTaskSnapshot(issueBefore).acceptanceCriteria.includes(REMOVED_CRITERION));

  // The operator reloads the amended Linear ticket at the pause (injected
  // fetch — no network; the CommonJS fetch mock lives in the route suites).
  const reloaded = await reloadIssueSourceFromLinear(issueId, {
    fetchLinearIssue: async (externalId: string) => ({
      id: externalId,
      identifier: "NOT-405",
      title: "Friend-path run, rescoped",
      description: CONTRACT_V2,
      url: "https://linear.app/not-so-fat/issue/NOT-405/x",
      attachments: [],
    }),
  });
  assert.equal(reloaded.ok, true);
  // The amended task is pending inspection: live rows changed, the open
  // action and every workflow identity preserved, the snapshot untouched.
  const parked = getIssue(issueId)!;
  assert.equal(parked.description, CONTRACT_V2);
  assert.equal(parked.executionContract?.exitPredicate, AMENDED_EXIT);
  assert.equal(listHumanActionsForIssue(issueId).find((a) => a.id === action.id)!.status, "open");
  assert.equal(getActiveWorkflowInstance(issueId)!.id, instanceBefore.id);
  assert.equal(parked.prNumber, 42);
  assert.equal(parked.branch, "dealer/not-405");
  assert.ok(getTaskSnapshot(parked).acceptanceCriteria.includes(REMOVED_CRITERION));
  assert.ok(diffTaskSnapshotFromLive(parked).length > 0);

  // Resume freezes exactly one new snapshot before the next developer item.
  const sessionsBeforeResume = listWorkerSessionsForIssue(issueId);
  const snapshotsBefore = listArtifactsForIssue(issueId).filter((a) => a.kind === TASK_SNAPSHOT_ARTIFACT_KIND).length;
  const resolved = resolveHumanActionAndAdvance(action.id, "operator", "resume", {
    note: "Clean-machine proof moved to NOT-421; enforce simulator proof.",
  });
  assert.equal(resolved.ok, true);
  const snapshotsAfter = listArtifactsForIssue(issueId).filter((a) => a.kind === TASK_SNAPSHOT_ARTIFACT_KIND);
  assert.equal(snapshotsAfter.length, snapshotsBefore + 1);
  const events = listWorkflowEventsForIssue(issueId);
  const refreshed = events.filter((e) => e.type === "task_snapshot.refreshed");
  assert.equal(refreshed.length, 1);
  const types = events.map((e) => e.type);
  assert.ok(types.indexOf("task_snapshot.refreshed") < types.lastIndexOf("repair.started"));

  const resumed = getIssue(issueId)!;
  assert.equal(getActiveWorkflowInstance(issueId)!.id, instanceBefore.id);
  assert.equal(resumed.prNumber, issueBefore.prNumber);
  assert.equal(resumed.prUrl, issueBefore.prUrl);
  assert.equal(resumed.branch, issueBefore.branch);
  assert.deepEqual(listWorkerSessionsForIssue(issueId), sessionsBeforeResume);
  const pendingDev = listWorkItemsForIssue(issueId).filter((i) => i.status === "pending");
  assert.equal(pendingDev.length, 1);
  assert.equal(pendingDev[0]!.kind, "developer");
  assert.equal(
    (JSON.parse(pendingDev[0]!.payloadJson!) as { scopeDecisionNote?: string }).scopeDecisionNote,
    "Clean-machine proof moved to NOT-421; enforce simulator proof."
  );

  // The next developer prompt enforces only the amended snapshot.
  const developerPrompt = buildDeveloperPrompt({ taskSnapshot: getTaskSnapshot(resumed), round: resumed.currentRound });
  assert.ok(developerPrompt.includes(AMENDED_EXIT));
  assert.ok(developerPrompt.includes("Simulator proof attached"));
  assert.ok(!developerPrompt.includes(REMOVED_CRITERION));
  assert.ok(!developerPrompt.includes("clean machine with operator proof"));

  // The developer completes; the following reviewer prompt enforces the same
  // amended snapshot — no escalation for the removed criterion can recur.
  const dev2 = claimWorkItem("scope-contract-test", { leaseMs: 60_000 })!;
  assert.equal(dev2.id, pendingDev[0]!.id);
  await applyCompletion(dev2.id, dev2.leaseToken!, {
    kind: "clean_handoff",
    branch: "dealer/not-405",
    headSha: "def456",
    baseSha: "base1",
    prNumber: 42,
    prUrl: "https://gh/pr/42",
  });
  const reviewRound = getIssue(issueId)!;
  assert.equal(reviewRound.status, "reviewing");
  assert.equal(getActiveWorkflowInstance(issueId)!.id, instanceBefore.id);
  assert.equal(reviewRound.branch, "dealer/not-405");
  const reviewerPrompt = buildReviewerPrompt({
    taskSnapshot: getTaskSnapshot(reviewRound),
    round: reviewRound.currentRound,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    diff: "diff --git a/x b/x\n+added line\n",
  });
  assert.ok(reviewerPrompt.includes(AMENDED_EXIT));
  assert.ok(reviewerPrompt.includes("Simulator proof attached"));
  assert.ok(!reviewerPrompt.includes(REMOVED_CRITERION));
  assert.ok(!reviewerPrompt.includes("clean machine with operator proof"));
});
