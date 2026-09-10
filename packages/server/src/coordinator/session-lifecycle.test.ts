// packages/server/src/coordinator/session-lifecycle.test.ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-lifecycle-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, getIssue } = await import("../repository/issues.js");
const { listWorkerSessionsForIssue } = await import("../repository/worker-sessions.js");
const { listOpenHumanActions } = await import("../repository/human-actions.js");
const { listWorkflowEventsForIssue } = await import("../repository/workflow-events.js");
const { startIssueWorkflow, advanceIssue } = await import("./session-lifecycle.js");
const { ReviewerResult } = await import("./reviewer-result.js");

before(() => {
  migrate();
});

function seedIssue(title: string) {
  return createIssue({
    title,
    description: "test issue",
    acceptanceCriteria: "works",
    repo: "/tmp/fake-repo",
    baseBranch: "main",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    maxReviewRounds: 3,
    source: "manual",
  });
}

/** Fake deps: no real git/gh/spawn — deterministic canned responses per test. */
function fakeDeps(overrides: Partial<{
  addWorktree: () => Promise<void>;
  isWorktreeClean: () => Promise<boolean>;
  mergeBase: () => Promise<string>;
  viewPr: () => Promise<{ number: number; url: string; headRefOid: string; baseRefName: string; headRefName: string; reviews: Array<{ author: string; state: string; body: string; submittedAt: string }> }>;
  publishReview: () => Promise<{ ok: true; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" } | { ok: false; error: string }>;
  spawnDeveloper: () => Promise<{ exitCode: number; transcript: string; logPath: string; timedOut?: boolean }>;
  spawnReviewer: () => Promise<{ exitCode: number; transcript: string; logPath: string; timedOut?: boolean }>;
}> = {}) {
  return {
    worktree: {
      addWorktree: overrides.addWorktree ?? (async () => {}),
      removeWorktree: async () => {},
      isWorktreeClean: overrides.isWorktreeClean ?? (async () => true),
      mergeBase: overrides.mergeBase ?? (async () => "base-sha-1"),
    },
    github: {
      viewPr:
        overrides.viewPr ??
        (async () => ({ number: 1, url: "https://github.com/x/y/pull/1", headRefOid: "head-sha-1", baseRefName: "main", headRefName: "issue-branch", reviews: [] })),
      publishReview: overrides.publishReview ?? (async () => ({ ok: true as const, event: "APPROVE" as const })),
    },
    spawnDeveloper: overrides.spawnDeveloper ?? (async () => ({ exitCode: 0, transcript: "done", logPath: "/tmp/log" })),
    spawnReviewer: overrides.spawnReviewer ?? (async () => ({ exitCode: 0, transcript: "reviewed", logPath: "/tmp/log" })),
  };
}

test("starting a workflow creates one instance and one queued developer session for round 1", async () => {
  const issue = seedIssue("Start workflow");
  await startIssueWorkflow(issue.id, fakeDeps());
  const sessions = listWorkerSessionsForIssue(issue.id);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].role, "developer");
  assert.equal(sessions[0].round, 1);
  assert.equal(getIssue(issue.id)?.status, "developing");
});

test("clean developer handoff advances to a queued reviewer session", async () => {
  const issue = seedIssue("Clean handoff");
  await startIssueWorkflow(issue.id, fakeDeps());
  await advanceIssue(issue.id, fakeDeps());
  const sessions = listWorkerSessionsForIssue(issue.id);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[1].role, "reviewer");
  assert.equal(sessions[1].inputSha, "head-sha-1");
  assert.equal(getIssue(issue.id)?.status, "reviewing");
  assert.equal(getIssue(issue.id)?.headSha, "head-sha-1");
});

test("approved review creates a final_review human action", async () => {
  const issue = seedIssue("Approved review");
  const approvedResult: unknown = { verdict: "approved", baseSha: "base-sha-1", headSha: "head-sha-1", acceptanceCriteriaAssessment: "met", evidenceAssessment: "ok", findings: [], risks: [] };
  await startIssueWorkflow(issue.id, fakeDeps());
  await advanceIssue(issue.id, fakeDeps()); // developer -> reviewer queued
  await advanceIssue(
    issue.id,
    fakeDeps({
      spawnReviewer: async () => ({ exitCode: 0, transcript: "```json\n" + JSON.stringify(approvedResult) + "\n```", logPath: "/tmp/log" }),
    })
  ); // reviewer runs -> approved
  assert.equal(getIssue(issue.id)?.status, "final_review");
  const actions = listOpenHumanActions();
  assert.ok(actions.some((a) => a.issueId === issue.id && a.actionType === "final_review"));
});

test("changes_requested with rounds remaining queues a round-2 developer session with findings context", async () => {
  const issue = seedIssue("Changes requested");
  const crResult: unknown = {
    verdict: "changes_requested",
    baseSha: "base-sha-1",
    headSha: "head-sha-1",
    acceptanceCriteriaAssessment: "partial",
    evidenceAssessment: "ok",
    findings: [{ fingerprint: "fp1", severity: "blocking", title: "Missing check", rationale: "r" }],
    risks: [],
  };
  await startIssueWorkflow(issue.id, fakeDeps());
  await advanceIssue(issue.id, fakeDeps());
  await advanceIssue(
    issue.id,
    fakeDeps({ spawnReviewer: async () => ({ exitCode: 0, transcript: "```json\n" + JSON.stringify(crResult) + "\n```", logPath: "/tmp/log" }) })
  );
  const sessions = listWorkerSessionsForIssue(issue.id);
  assert.equal(sessions.length, 3);
  assert.equal(sessions[2].role, "developer");
  assert.equal(sessions[2].round, 2);
  assert.equal(getIssue(issue.id)?.status, "repairing");
  assert.equal(getIssue(issue.id)?.currentRound, 2);
});

test("dirty worktree after developer session creates policy_escalation without consuming a round", async () => {
  const issue = seedIssue("Dirty worktree");
  await startIssueWorkflow(issue.id, fakeDeps());
  await advanceIssue(issue.id, fakeDeps({ isWorktreeClean: async () => false }));
  assert.equal(getIssue(issue.id)?.status, "needs_human");
  assert.equal(getIssue(issue.id)?.currentRound, 1);
  const actions = listOpenHumanActions();
  assert.ok(actions.some((a) => a.issueId === issue.id && a.actionType === "policy_escalation"));
});

test("every completed round emits workflow_events with the issue and round attached", async () => {
  const issue = seedIssue("Events issue");
  await startIssueWorkflow(issue.id, fakeDeps());
  await advanceIssue(issue.id, fakeDeps());
  const events = listWorkflowEventsForIssue(issue.id);
  assert.ok(events.some((e) => e.type === "workflow.started"));
  assert.ok(events.some((e) => e.type === "worker.started"));
  assert.ok(events.some((e) => e.type === "worker.completed"));
  assert.ok(events.some((e) => e.type === "pull_request.opened"));
});
