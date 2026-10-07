// NOT-362 acceptance: after Dealer merges a PR for a `source = linear` issue,
// the coordinator re-reads the Linear issue and either confirms it advanced,
// advances it once via the conditional fallback, or raises the one human action.
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not362-"));
process.env.LINEAR_API_KEY = "test-key";

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, getIssue } = await import("../repository/issues.js");
const { listArtifactsForIssueByKind } = await import("../repository/artifacts-for-issue.js");
const { listHumanActionsForIssue } = await import("../repository/human-actions.js");
const { claimWorkItem } = await import("../repository/work-items.js");
const { startWorkflow, applyCompletion } = await import("./commands.js");
const { ReviewerResult } = await import("./reviewer-result.js");
const { setMergePrForTests, clearFinalizeInflightForTests } = await import("./auto-merge.js");
const { clearWorkflowStateCacheForTests } = await import("../adapters/linear-sync.js");
const {
  verifyLinearPostMerge,
  setPostMergeDelaysForTests,
  LINEAR_MERGE_VERIFY_ARTIFACT_KIND,
  linearMergeStaleRequestId,
} = await import("./linear-merge-verify.js");

/** Real local checkout so resolveAutoMergeCwd accepts the default legacy repo. */
let fixtureRepo = "";

function initFixtureRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not362-repo-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "hi\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

before(() => {
  migrate();
  fixtureRepo = initFixtureRepo();
  setPostMergeDelaysForTests([0, 0]);
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
  clearWorkflowStateCacheForTests();
  setMergePrForTests(async () => ({ ok: true }));
});

const realFetch = globalThis.fetch;

afterEach(() => {
  setMergePrForTests(null);
  clearFinalizeInflightForTests();
  globalThis.fetch = realFetch;
});

const PR_URL = "https://github.com/o/r/pull/42";

function newLinearIssue(): string {
  return createIssue({
    title: "NOT-362: linear work",
    description: "d",
    acceptanceCriteria: "It works",
    repo: fixtureRepo,
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "linear",
    externalId: "lin-uuid-1",
    externalLabel: "NOT-362",
    externalUrl: "https://linear.app/not-so-fat/issue/NOT-362/work",
    autoMerge: true,
  }).id;
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

/** Drive the full merged transition: developer handoff + reviewer approve → merge → done. */
async function mergeThroughReview(issueId: string) {
  startWorkflow(issueId);
  const handoff = claimWorkItem(`test-${issueId}`, { leaseMs: 60_000 });
  assert.ok(handoff && handoff.issueId === issueId);
  await applyCompletion(handoff.id, handoff.leaseToken!, {
    kind: "clean_handoff",
    branch: "issue-1",
    headSha: "abc123",
    baseSha: "base1",
    prNumber: 42,
    prUrl: PR_URL,
  });
  const review = claimWorkItem(`test-${issueId}-r`, { leaseMs: 60_000 });
  assert.ok(review && review.issueId === issueId);
  return applyCompletion(review.id, review.leaseToken!, { kind: "verdict", result: okReview });
}

interface StubState {
  /** Payload for the PostMergeState read. */
  linearIssue: unknown;
  /** When set, the issueUpdate mutation rejects with this message. */
  failStateWriteWith: string | null;
  /** When true, the team reports no completed (Done) state. */
  noCompletedState: boolean;
  calls: { reads: number; comments: number; stateWrites: number };
}

function stubLinear(state: StubState): void {
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String((init as { body?: string })?.body ?? "{}")) as {
      query?: string;
    };
    const query = body.query ?? "";
    if (query.includes("PostMergeState")) {
      state.calls.reads += 1;
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify({ data: { issue: state.linearIssue } }),
      };
    }
    if (query.includes("TeamStates")) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () =>
          JSON.stringify({
            data: {
              team: {
                states: {
                  nodes: state.noCompletedState
                    ? [{ id: "s-todo", name: "Todo" }]
                    : [{ id: "s-done", name: "Done" }],
                },
              },
            },
          }),
      };
    }
    if (query.includes("commentCreate")) {
      state.calls.comments += 1;
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify({ data: { commentCreate: { success: true } } }),
      };
    }
    if (query.includes("issueUpdate")) {
      state.calls.stateWrites += 1;
      if (state.failStateWriteWith) throw new Error(state.failStateWriteWith);
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify({ data: { issueUpdate: { success: true } } }),
      };
    }
    throw new Error(`unexpected Linear query: ${query.slice(0, 80)}`);
  }) as typeof fetch;
}

function freshStub(linearIssue: unknown): StubState {
  return { linearIssue, failStateWriteWith: null, noCompletedState: false, calls: { reads: 0, comments: 0, stateWrites: 0 } };
}

const startedIssue = () => ({
  identifier: "NOT-362",
  url: "https://linear.app/not-so-fat/issue/NOT-362/work",
  state: { name: "In Progress", type: "started" },
  team: { id: "team-1" },
  attachments: { nodes: [] },
});

const staleIssue = (attachments: Array<{ url: string }> = []) => ({
  identifier: "NOT-362",
  url: "https://linear.app/not-so-fat/issue/NOT-362/work",
  state: { name: "Backlog", type: "backlog" },
  team: { id: "team-1" },
  attachments: { nodes: attachments },
});

function verifyArtifacts(issueId: string) {
  return listArtifactsForIssueByKind(issueId, LINEAR_MERGE_VERIFY_ARTIFACT_KIND);
}

test("advanced via state type: merged transition records one artifact, no write, no action", async () => {
  const state = freshStub(startedIssue());
  stubLinear(state);

  const issueId = newLinearIssue();
  await mergeThroughReview(issueId);

  assert.equal(getIssue(issueId)!.status, "done");
  const artifacts = verifyArtifacts(issueId);
  assert.equal(artifacts.length, 1);
  const content = JSON.parse(artifacts[0]!.contentJson!);
  assert.equal(content.outcome, "advanced");
  assert.equal(content.advancedVia, "state");
  assert.equal(state.calls.stateWrites, 0);
  assert.equal(state.calls.comments, 0);
  assert.deepEqual(
    listHumanActionsForIssue(issueId).filter((a) => a.status === "open"),
    []
  );
});

test("advanced via attachment: Backlog state with the merged PR attached verifies", async () => {
  const state = freshStub(staleIssue([{ url: PR_URL }]));
  stubLinear(state);

  const issueId = newLinearIssue();
  await mergeThroughReview(issueId);

  assert.equal(getIssue(issueId)!.status, "done");
  const artifacts = verifyArtifacts(issueId);
  assert.equal(artifacts.length, 1);
  const content = JSON.parse(artifacts[0]!.contentJson!);
  assert.equal(content.outcome, "advanced");
  assert.equal(content.advancedVia, "attachment");
  assert.equal(state.calls.stateWrites, 0);
  assert.equal(state.calls.comments, 0);
  assert.deepEqual(
    listHumanActionsForIssue(issueId).filter((a) => a.status === "open"),
    []
  );
});

test("stale twice: exactly one completed-state write plus one comment, issue stays done", async () => {
  const state = freshStub(staleIssue());
  stubLinear(state);

  const issueId = newLinearIssue();
  const first = await mergeThroughReview(issueId);
  // The merged transition itself succeeds — the post-check never fails it.
  assert.equal(first.applied, true);
  assert.equal(getIssue(issueId)!.status, "done");

  // Re-running the check must not write twice (the completed issue has no
  // active workflow left, so the re-run goes through the check itself).
  const second = await verifyLinearPostMerge(issueId);
  assert.equal(second.checked, true);
  assert.equal(getIssue(issueId)!.status, "done");

  assert.equal(state.calls.stateWrites, 1);
  assert.equal(state.calls.comments, 1);
  const artifacts = verifyArtifacts(issueId);
  assert.equal(artifacts.length, 2);
  const contents = artifacts.map((a) => JSON.parse(a.contentJson!));
  assert.ok(contents.every((c) => c.outcome === "stale"));
  assert.ok(contents.some((c) => c.fallback === "written"));
});

test("failed fallback twice: exactly one open human action naming identifier, PR URL, state", async () => {
  const state = freshStub(staleIssue());
  state.failStateWriteWith = "no write access";
  stubLinear(state);

  const issueId = newLinearIssue();
  await mergeThroughReview(issueId);
  assert.equal(getIssue(issueId)!.status, "done");

  const rerun = await verifyLinearPostMerge(issueId);
  assert.equal(rerun.checked, true);
  assert.equal(getIssue(issueId)!.status, "done");

  const open = listHumanActionsForIssue(issueId).filter((a) => a.status === "open");
  assert.equal(open.length, 1);
  const action = open[0]!;
  assert.equal(action.actionType, "policy_escalation");
  assert.equal(action.requestId, linearMergeStaleRequestId(issueId));
  assert.match(action.reason, /NOT-362/);
  assert.ok(action.reason.includes(PR_URL), "names the merged PR URL");
  assert.match(action.reason, /Backlog/);
});

test("unavailable fallback (no completed state): one open human action, issue stays done", async () => {
  const state = freshStub(staleIssue());
  state.noCompletedState = true;
  stubLinear(state);

  const issueId = newLinearIssue();
  await mergeThroughReview(issueId);
  await verifyLinearPostMerge(issueId);

  assert.equal(getIssue(issueId)!.status, "done");
  assert.equal(state.calls.stateWrites, 0);
  const open = listHumanActionsForIssue(issueId).filter((a) => a.status === "open");
  assert.equal(open.length, 1);
  assert.match(open[0]!.reason, /NOT-362/);
  assert.ok(open[0]!.reason.includes(PR_URL));
});
