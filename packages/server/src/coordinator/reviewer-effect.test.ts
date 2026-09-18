// packages/server/src/coordinator/reviewer-effect.test.ts
//
// NOT-62 acceptance test: a real Git repository (temp repo + bare "origin" remote) drives
// the reviewer's detached-HEAD worktree, diff computation, and stale-head re-verification,
// while the agent session itself and GitHub publication are faked — the same confirmed
// scope as NOT-61 (no paid CLI spawn, no real GitHub calls). The developer half runs for
// real too (fake spawn, fake GitHub) so each test reaches a genuine coordinator-verified
// head SHA the reviewer is pinned to, exactly as it would end to end.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GithubAdapter, ReviewEvent } from "../adapters/github.js";
import type { EffectContext } from "./effect-registry.js";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-reveff-home-"));
process.env.MAX_COORDINATOR_CONCURRENCY = "2";
process.env.COORDINATOR_HEARTBEAT_MS = "20";
process.env.COORDINATOR_FAIL_BACKOFF_MS = "0";
process.env.CHECKS_POLL_TIMEOUT_MS = "60";
process.env.CHECKS_POLL_INTERVAL_MS = "10";
process.env.REVIEWER_TIMEOUT_MS = "5000";
process.env.REVIEWER_PUBLISH_WAIT_ATTEMPTS = "3";
process.env.REVIEWER_PUBLISH_WAIT_INTERVAL_MS = "10";

const { migrate, getDb } = await import("../db/index.js");
const { createAgent } = await import("../repository/agents.js");
const { createIssue, getIssue } = await import("../repository/issues.js");
const { listWorkerSessionsForIssue } = await import("../repository/worker-sessions.js");
const { listWorkItemsForIssue, cancelWorkItem } = await import("../repository/work-items.js");
const { listArtifactsForIssue } = await import("../repository/artifacts-for-issue.js");
const { listHumanActionsForIssue } = await import("../repository/human-actions.js");
const { listFindingsForIssue } = await import("../repository/findings.js");
const { listUsageEventsForIssue } = await import("../repository/usage-events.js");
const { getActiveWorkflowInstance } = await import("../repository/workflow-events.js");
const { createWorkerSession } = await import("../repository/worker-sessions.js");
const { claimReviewPublication, recordReviewPublishFailed } = await import("../repository/review-publications.js");
const { startWorkflow } = await import("./commands.js");
const { registerEffectHandler, resetEffectHandlers } = await import("./effect-registry.js");
const { runCoordinatorTick, drainCoordinator } = await import("./worker-loop.js");
const { runDeveloperEffect } = await import("./developer-effect.js");
const { runReviewerEffect } = await import("./reviewer-effect.js");
const { routeReviewerOutcome } = await import("./routing.js");
const { realDeveloperSpawn, realReviewerSpawn } = await import("./spawn.js");
const { realGithubAdapter } = await import("../adapters/github.js");
type SpawnFn = typeof realDeveloperSpawn;
type ReviewerSpawnFn = typeof realReviewerSpawn;
type GithubFn = typeof realGithubAdapter;

before(() => migrate());
// review_publications rows FK-reference work_items — deleted first, or the delete below
// (needed between tests since each makes its own issue/work items) fails the constraint.
beforeEach(() => getDb().exec("DELETE FROM review_publications; DELETE FROM work_items;"));
after(() => resetEffectHandlers());

let repo: string;
let remote: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-reveff-repo-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");

  remote = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-reveff-remote-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
});

after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(remote, { recursive: true, force: true });
});

function issueBranchName(issueId: string): string {
  return `issue-${issueId}`;
}


/** NOT-149: agents always carry a deckId; effect tests that do not exercise Deck failures
 * inject a get_bound_deck stub that reports the test deck as bound. */
const TEST_DECK_ID = "00000000-0000-4000-a000-000000000099";
const okDeckCallTool = async (name: string, _args: Record<string, unknown>) => ({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify({ id: TEST_DECK_ID, name: "test-deck" }),
    },
  ],
});

async function makeIssue(opts: {
  maxInfraAttempts?: number;
  reviewerDeck?: { deckId: string; playbookIds?: string[] };
} = {}): Promise<string> {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", deckId: "00000000-0000-4000-a000-000000000099" });
  const rev = createAgent({
    name: `rev-${Math.random()}`,
    runtime: "claude_code",
    deckId: opts.reviewerDeck?.deckId ?? "00000000-0000-4000-a000-000000000099",
  });
  if (opts.reviewerDeck?.playbookIds?.length) {
    getDb()
      .prepare("UPDATE agents SET playbook_ids_json = ? WHERE id = ?")
      .run(JSON.stringify(opts.reviewerDeck.playbookIds), rev.id);
  }
  return createIssue({
    title: "Add widget",
    description: "Build the widget.",
    acceptanceCriteria: "Widget renders.",
    repo,
    baseBranch: "main",
    developerAgentId: dev.id,
    reviewerAgentId: rev.id,
    maxReviewRounds: 3,
    maxInfraAttempts: opts.maxInfraAttempts ?? 3,
    source: "manual"}).id;
}

/**
 * Directly manipulates the work item's live lease, simulating what claim/recovery would
 * otherwise do. `expiresInMs` defaults far enough in the future for a live lease; pass a
 * negative value to simulate one that has expired but recovery hasn't swept yet — same
 * `status = 'leased'`, same token, just past its `lease_expires_at`.
 */
function setWorkItemLease(workItemId: string, leaseToken: string, expiresInMs = 60_000): void {
  const expiresAt = new Date(Date.now() + expiresInMs).toISOString();
  getDb()
    .prepare("UPDATE work_items SET lease_token = ?, status = 'leased', lease_expires_at = ? WHERE id = ?")
    .run(leaseToken, expiresAt, workItemId);
}

async function pump(max = 20): Promise<void> {
  for (let i = 0; i < max; i++) {
    const started = await runCoordinatorTick({ leaseOwner: "pump" });
    await drainCoordinator();
    if (started === 0) return;
  }
}

/** Commits a file in the developer worktree — the "agent implemented the task" fake. */
const commitingSpawn: SpawnFn = async (input) => {
  fs.writeFileSync(path.join(input.cwd, "feature.txt"), "implemented\n");
  git(input.cwd, "add", ".");
  git(input.cwd, "-c", "user.email=agent@test", "-c", "user.name=Agent", "commit", "-q", "-m", "implement");
  return { exitCode: 0, transcript: "Implementation conclusion: added the widget.", logPath: "/dev/null", timedOut: false };
};

type Verdict = "approved" | "changes_requested" | "escalated";

interface VerdictOpts {
  verdict: Verdict;
  findings?: Array<{ fingerprint: string; severity: "blocking" | "non_blocking"; title: string; rationale: string }>;
  productScopeQuestion?: string;
}

function reviewerTranscript(opts: VerdictOpts & { baseSha: string; headSha: string }): string {
  const body = {
    verdict: opts.verdict,
    baseSha: opts.baseSha,
    headSha: opts.headSha,
    acceptanceCriteriaAssessment: "Assessed.",
    evidenceAssessment: "Evidence checked.",
    findings: opts.findings ?? [],
    risks: [],
    ...(opts.productScopeQuestion ? { productScopeQuestion: opts.productScopeQuestion } : {})};
  return `Some preamble.\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\`\n`;
}

/** The reviewer prompt echoes the exact SHAs it must report (prompts.ts) — pulling them
 * back out of the prompt keeps this fake honest against reviewer-effect.ts's own SHA
 * validation, instead of hardcoding values that would now be rejected. */
function shasFromPrompt(prompt: string): { baseSha: string; headSha: string } {
  const baseSha = prompt.match(/"baseSha" to exactly "([0-9a-f]+)"/)?.[1];
  const headSha = prompt.match(/"headSha" to exactly "([0-9a-f]+)"/)?.[1];
  if (!baseSha || !headSha) throw new Error("could not extract SHAs from reviewer prompt");
  return { baseSha, headSha };
}

function verdictSpawn(opts: VerdictOpts): ReviewerSpawnFn {
  return async (input) => {
    const { baseSha, headSha } = shasFromPrompt(input.prompt);
    return { exitCode: 0, transcript: reviewerTranscript({ ...opts, baseSha, headSha }), logPath: "/dev/null", timedOut: false };
  };
}

/** Reports SHAs that do not match what the coordinator actually pinned/verified. */
const wrongShaSpawn: ReviewerSpawnFn = async () => ({
  exitCode: 0,
  transcript: reviewerTranscript({ verdict: "approved", baseSha: "0".repeat(40), headSha: "1".repeat(40) }),
  logPath: "/dev/null",
  timedOut: false});

const garbageSpawn: ReviewerSpawnFn = async () => ({ exitCode: 0, transcript: "not json at all", logPath: "/dev/null", timedOut: false });
const crashingReviewerSpawn: ReviewerSpawnFn = async () => ({ exitCode: 1, transcript: "boom", logPath: "/dev/null", timedOut: false });
const timedOutReviewerSpawn: ReviewerSpawnFn = async () => ({ exitCode: 1, transcript: "", logPath: "/dev/null", timedOut: true });

interface FakeGithubOpts {
  checks?: "success" | "failure" | "pending";
  publishFails?: boolean;
  rejectSelfReview?: boolean;
}

/**
 * In-memory PR store — real git tells it the branch/head, nothing hits real GitHub.
 *
 * `publishReview` always actually "submits" (increments `publishCallCount()`) — it does
 * NOT deduplicate on its own. That's deliberate: the real duplicate-submission guard now
 * lives entirely in `reviewer-effect.ts` (the durable `review_publications` claim,
 * gating entry before `publishReview` is ever called), not in the adapter — matching
 * round 3's fix removing the GitHub-side existence check from `github.ts` altogether.
 * Keeping the fake this simple means a test asserting `publishCallCount() === 1` after
 * two effect runs is actually exercising the caller's claim, not a dedup the fake would
 * have papered over on its own.
 */
function fakeGithub(opts: FakeGithubOpts = {}): GithubFn & { publishCallCount(): number } {
  const prsByBranch = new Map<string, { number: number; url: string; base: string }>();
  const branchByNumber = new Map<number, string>();
  let nextNumber = 100;
  let publishCalls = 0;
  const currentBranch = (cwd: string) => git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
  const remoteHead = (branch: string) => git(remote, "rev-parse", branch);
  const adapter: GithubAdapter = {
    async viewPr({ cwd, number }) {
      const branch = number != null ? branchByNumber.get(number) : currentBranch(cwd);
      if (!branch) return null;
      const pr = prsByBranch.get(branch);
      if (!pr) return null;
      return { number: pr.number, url: pr.url, baseRefName: pr.base, headRefName: branch, headRefOid: remoteHead(branch), isDraft: true };
    },
    async createDraftPr({ cwd, base }) {
      const branch = currentBranch(cwd);
      const number = nextNumber++;
      const url = `https://github.com/o/r/pull/${number}`;
      prsByBranch.set(branch, { number, url, base });
      branchByNumber.set(number, branch);
      return { ok: true, number, url };
    },
    async checksSnapshot() {
      return opts.checks ?? "success";
    },
    async publishReview({ event }) {
      publishCalls++;
      if (opts.publishFails) return { ok: false, reason: "boom" };
      const finalEvent: ReviewEvent = opts.rejectSelfReview && event !== "COMMENT" ? "COMMENT" : event;
      return { ok: true, event: finalEvent, usedCommentFallback: finalEvent !== event };
    }};
  return Object.assign(adapter, { publishCallCount: () => publishCalls });
}

/** Advances the issue to "reviewing" with a real coordinator-verified head SHA. */
async function advanceToReviewing(issueId: string, github: GithubFn): Promise<void> {
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: commitingSpawn, github }));
  startWorkflow(issueId);
  await pump(1);
  assert.equal(getIssue(issueId)!.status, "reviewing", "test setup: developer stage did not reach reviewing");
}

/** Builds an EffectContext for the pending reviewer work item with a specific (possibly stale) leaseToken, mimicking what worker-loop.ts's processWorkItem does per attempt. */
function reviewerCtxFactory(issueId: string) {
  const issue = getIssue(issueId)!;
  const instance = getActiveWorkflowInstance(issueId)!;
  const workItem = listWorkItemsForIssue(issueId).find((i) => i.kind === "reviewer" && i.status === "pending")!;
  const profileSnapshotJson = (() => {
    try {
      return (JSON.parse(workItem.payloadJson ?? "{}") as { profileSnapshot?: string }).profileSnapshot;
    } catch {
      return undefined;
    }
  })();
  return (leaseToken: string): EffectContext => {
    const session = createWorkerSession({
      issueId: issue.id,
      role: "reviewer",
      round: workItem.round,
      agentId: issue.reviewerAgentId,
      runtime: "claude_code",
      profileSnapshotJson});
    return {
      workItem: { ...workItem, workerSessionId: session.id, leaseToken },
      issue,
      instance,
      signal: new AbortController().signal};
  };
}

test("approved: the coordinator verifies the pinned SHA, publishes the review, and opens final_review", async () => {
  const issueId = await makeIssue();
  const github = fakeGithub();
  await advanceToReviewing(issueId, github);
  registerEffectHandler("reviewer", (ctx) => runReviewerEffect(ctx, { deckCallTool: okDeckCallTool, spawn: verdictSpawn({ verdict: "approved" }), github }));
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "final_review");
  const action = listHumanActionsForIssue(issueId).find((a) => a.actionType === "final_review");
  assert.ok(action, "expected a final_review human action");

  const revSession = listWorkerSessionsForIssue(issueId).find((s) => s.role === "reviewer")!;
  assert.equal(revSession.status, "done");

  const kinds = listArtifactsForIssue(issueId).map((a) => a.kind);
  assert.ok(kinds.includes("reviewer_transcript"));
  const published = listArtifactsForIssue(issueId).find((a) => a.kind === "review_published");
  assert.ok(published);
  assert.equal(JSON.parse(published!.contentJson!).event, "APPROVE");

  const usage = listUsageEventsForIssue(issueId).filter((u) => u.role === "reviewer");
  assert.equal(usage.length, 1);
  assert.equal(usage[0].workerSessionId, revSession.id);
});

test("same-identity fallback: GitHub rejecting APPROVE as a self-review still records the internal verdict and moves to final_review", async () => {
  const issueId = await makeIssue();
  const github = fakeGithub({ rejectSelfReview: true });
  await advanceToReviewing(issueId, github);
  registerEffectHandler("reviewer", (ctx) => runReviewerEffect(ctx, { deckCallTool: okDeckCallTool, spawn: verdictSpawn({ verdict: "approved" }), github }));
  await pump(1);

  assert.equal(getIssue(issueId)!.status, "final_review", "the internal verdict is the workflow authority, not the GitHub event");
  const published = listArtifactsForIssue(issueId).find((a) => a.kind === "review_published");
  assert.equal(JSON.parse(published!.contentJson!).event, "COMMENT");
  assert.equal(JSON.parse(published!.contentJson!).usedCommentFallback, true);
});

test("session_failed: a verdict reporting SHAs that don't match the coordinator-verified revision is rejected, not accepted", async () => {
  const issueId = await makeIssue({ maxInfraAttempts: 0 });
  const github = fakeGithub();
  await advanceToReviewing(issueId, github);
  registerEffectHandler("reviewer", (ctx) => runReviewerEffect(ctx, { deckCallTool: okDeckCallTool, spawn: wrongShaSpawn, github }));
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human", "a wrong-SHA verdict must never reach final_review");
  assert.equal(issue.currentRound, 1, "a rejected verdict never consumes a round");
  assert.equal(github.publishCallCount(), 0, "a rejected verdict is never published");
});

test("session_failed: bounded infra retry re-queues a fresh reviewer session at the SAME pinned head before any escalation", async () => {
  const issueId = await makeIssue(); // default maxInfraAttempts: 3
  const github = fakeGithub();
  await advanceToReviewing(issueId, github);
  const before = getIssue(issueId)!;
  registerEffectHandler("reviewer", (ctx) => runReviewerEffect(ctx, { deckCallTool: okDeckCallTool, spawn: garbageSpawn, github }));
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "reviewing", "one infra failure with attempts left retries, it does not escalate");
  assert.equal(issue.infraAttempts, 1);
  assert.equal(issue.currentRound, before.currentRound, "an infra retry never spends a review round");
  assert.equal(issue.headSha, before.headSha, "the retry is pinned to the SAME head, not a new one");
  assert.equal(
    listWorkItemsForIssue(issueId).filter((i) => i.kind === "reviewer" && i.status === "pending").length,
    1
  );

  // Cost is incurred the moment the process runs — recorded even though the transcript
  // could not be parsed as a verdict (see reviewer-effect.ts: recorded before that check).
  assert.equal(listUsageEventsForIssue(issueId).filter((u) => u.role === "reviewer").length, 1);
});

test("deck_failure: reviewer preflight preserves and routes the failing deck bind reason", async () => {
  const deckId = "11111111-1111-4111-a111-111111111111";
  const issueId = await makeIssue({
    reviewerDeck: { deckId },
  });
  const github = fakeGithub();
  await advanceToReviewing(issueId, github);
  const workItem = listWorkItemsForIssue(issueId).find((i) => i.kind === "reviewer" && i.status === "pending")!;
  const ctxWithLease = reviewerCtxFactory(issueId);
  setWorkItemLease(workItem.id, "token-deck-failure");

  let spawnCalled = false;
  const outcome = await runReviewerEffect(ctxWithLease("token-deck-failure"), {
    spawn: async (input) => {
      spawnCalled = true;
      return verdictSpawn({ verdict: "approved" })(input);
    },
    github,
    deckCallTool: async () => ({
      isError: true,
      content: [{ type: "text", text: "deck bind refused" }],
    }),
  });

  assert.equal(spawnCalled, false, "failed deck preflight must stop before reviewer spawn");
  assert.equal(outcome.kind, "deck_failure");
  if (outcome.kind === "deck_failure") {
    assert.match(outcome.reason ?? "", /deck bind refused|get_bound_deck/);
    const routed = routeReviewerOutcome(
      outcome,
      { currentRound: 1, maxReviewRounds: 3, infraAttempts: 0, maxInfraAttempts: 3 },
      getIssue(issueId)!.headSha!
    );
    assert.equal(routed.next, "retry_reviewer");
    if (routed.next === "retry_reviewer") {
      assert.equal(
        routed.reason,
        "Agent Deck preflight failed: get_bound_deck returned an error: deck bind refused"
      );
    }
  }
});

test("publish is idempotent: re-running the effect for the same PR/head (simulating a crash before the work item's completion CAS, then recovery) does not submit a second review", async () => {
  const issueId = await makeIssue();
  const github = fakeGithub();
  await advanceToReviewing(issueId, github);

  const workItem = listWorkItemsForIssue(issueId).find((i) => i.kind === "reviewer" && i.status === "pending")!;
  const ctxWithLease = reviewerCtxFactory(issueId);

  // Realistic: the first attempt holds "token-1" while it actually runs; recovery only
  // reclaims to "token-2" for the retry afterward (simulating the crash-and-recover).
  setWorkItemLease(workItem.id, "token-1");
  const first = await runReviewerEffect(ctxWithLease("token-1"), { deckCallTool: okDeckCallTool, spawn: verdictSpawn({ verdict: "approved" }), github });

  setWorkItemLease(workItem.id, "token-2");
  // Two genuinely independent reviewer sessions can disagree (they're two separate model
  // calls over the same diff) — this is exactly what round 3 found unhandled: the loser
  // must report what the winner actually published, not its own different verdict.
  const second = await runReviewerEffect(ctxWithLease("token-2"), { deckCallTool: okDeckCallTool,
    spawn: verdictSpawn({
      verdict: "changes_requested",
      findings: [{ fingerprint: "disagreement", severity: "blocking", title: "Second session found this", rationale: "..." }]}),
    github});

  assert.equal(first.kind, "verdict");
  assert.equal(second.kind, "verdict");
  assert.equal(github.publishCallCount(), 1, "GitHub must only actually be mutated once");
  if (first.kind === "verdict" && second.kind === "verdict") {
    assert.equal(second.result.verdict, first.result.verdict, "the loser must report the winner's verdict, not its own conflicting one");
    assert.deepEqual(second.result.findings, first.result.findings, "the loser must report the winner's findings, not its own");
  }
});

test("publish claim: a zombie holding a stale lease token can never win the publication claim — only the current lease holder can", async () => {
  const issueId = await makeIssue();
  const github = fakeGithub();
  await advanceToReviewing(issueId, github);
  const workItem = listWorkItemsForIssue(issueId).find((i) => i.kind === "reviewer" && i.status === "pending")!;
  const ctxWithLease = reviewerCtxFactory(issueId);

  // The zombie held "old-token" when its session started, but recovery has already
  // reclaimed the lease to "new-token" (the current holder) by the time the zombie
  // — delayed, e.g. a slow `gh` call earlier in its own flow — reaches the publish step.
  setWorkItemLease(workItem.id, "old-token");
  const zombieCtx = ctxWithLease("old-token");
  setWorkItemLease(workItem.id, "new-token");

  const zombieOutcome = await runReviewerEffect(zombieCtx, { deckCallTool: okDeckCallTool, spawn: verdictSpawn({ verdict: "approved" }), github });
  assert.equal(zombieOutcome.kind, "publish_failed", "a zombie whose lease was already reclaimed must never win the claim");
  assert.equal(github.publishCallCount(), 0, "the zombie must never actually call gh, no matter how the wall-clock timing falls");

  const currentOutcome = await runReviewerEffect(ctxWithLease("new-token"), { deckCallTool: okDeckCallTool, spawn: verdictSpawn({ verdict: "approved" }), github });
  assert.equal(currentOutcome.kind, "verdict", "the current lease holder — not the zombie — is the one that actually publishes");
  assert.equal(github.publishCallCount(), 1);
});

test("publish claim: a lease that has expired but recovery hasn't swept yet is not \"live\" just because status still says leased", async () => {
  const issueId = await makeIssue();
  const github = fakeGithub();
  await advanceToReviewing(issueId, github);
  const workItem = listWorkItemsForIssue(issueId).find((i) => i.kind === "reviewer" && i.status === "pending")!;
  const ctxWithLease = reviewerCtxFactory(issueId);

  // Same token, status still 'leased' — but lease_expires_at is already in the past.
  // Recovery's sweep hasn't run yet, so nothing has moved this row off 'leased', but the
  // lease itself is no longer actually held by anyone.
  setWorkItemLease(workItem.id, "expired-token", -60_000);
  const outcome = await runReviewerEffect(ctxWithLease("expired-token"), { deckCallTool: okDeckCallTool, spawn: verdictSpawn({ verdict: "approved" }), github });

  assert.equal(outcome.kind, "publish_failed", "an expired lease must never be treated as live, even with a matching token and status");
  assert.equal(github.publishCallCount(), 0, "an attempt resuming on an expired lease must never actually call gh");
});

test("publish claim: a stuck in-flight claim (prior holder never settles) is waited on, then given up on as publish_failed", async () => {
  const issueId = await makeIssue();
  const github = fakeGithub();
  await advanceToReviewing(issueId, github);
  const workItem = listWorkItemsForIssue(issueId).find((i) => i.kind === "reviewer" && i.status === "pending")!;
  const ctxWithLease = reviewerCtxFactory(issueId);

  // Simulates a prior lease holder that claimed publication and then never recorded any
  // outcome (crashed mid-flight, before ever calling `gh`) — the current holder must
  // wait, not immediately assume failure, but ultimately escalate rather than guess.
  setWorkItemLease(workItem.id, "old-token");
  assert.equal(claimReviewPublication(workItem.id, "old-token"), true);
  setWorkItemLease(workItem.id, "new-token");

  const outcome = await runReviewerEffect(ctxWithLease("new-token"), { deckCallTool: okDeckCallTool, spawn: verdictSpawn({ verdict: "approved" }), github });
  assert.equal(outcome.kind, "publish_failed", "a claim that never settles must escalate, never silently approve");
  assert.equal(github.publishCallCount(), 0, "this attempt must never call gh while the claim is held elsewhere");
});

test("publish claim: a prior claimant that recorded failure is safely reclaimed by the current lease holder and the review is published normally", async () => {
  const issueId = await makeIssue();
  const github = fakeGithub();
  await advanceToReviewing(issueId, github);
  const workItem = listWorkItemsForIssue(issueId).find((i) => i.kind === "reviewer" && i.status === "pending")!;
  const ctxWithLease = reviewerCtxFactory(issueId);

  // Simulates a prior lease holder that claimed publication and genuinely failed (its
  // own `gh` call errored) — the current holder taking over the lease must be able to
  // reclaim from `failed` and publish normally.
  setWorkItemLease(workItem.id, "old-token");
  assert.equal(claimReviewPublication(workItem.id, "old-token"), true);
  recordReviewPublishFailed(workItem.id);
  setWorkItemLease(workItem.id, "new-token");

  const outcome = await runReviewerEffect(ctxWithLease("new-token"), { deckCallTool: okDeckCallTool, spawn: verdictSpawn({ verdict: "approved" }), github });
  assert.equal(outcome.kind, "verdict", "reclaiming a failed prior claim must let publication proceed normally");
  assert.equal(github.publishCallCount(), 1);
});

test("diff truncated: an oversized diff forces the verdict to escalate in code, regardless of what the reviewer reports", async () => {
  const issueId = await makeIssue();
  const github = fakeGithub();

  // A single file whose diff alone exceeds prompts.ts's TOTAL_DIFF_LIMIT (300,000 chars).
  const bigFileSpawn: SpawnFn = async (input) => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i} of a very large generated file`);
    fs.writeFileSync(path.join(input.cwd, "big.txt"), `${lines.join("\n")}\n`);
    git(input.cwd, "add", ".");
    git(input.cwd, "-c", "user.email=agent@test", "-c", "user.name=Agent", "commit", "-q", "-m", "add a big file");
    return { exitCode: 0, transcript: "Implementation conclusion: added a big file.", logPath: "/dev/null", timedOut: false };
  };
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: bigFileSpawn, github }));
  startWorkflow(issueId);
  await pump(1);
  assert.equal(getIssue(issueId)!.status, "reviewing", "test setup: developer stage did not reach reviewing");

  registerEffectHandler("reviewer", (ctx) => runReviewerEffect(ctx, { deckCallTool: okDeckCallTool, spawn: verdictSpawn({ verdict: "approved" }), github }));
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human", "an oversized diff must never reach final_review, even though the reviewer reported approved");
  assert.ok(listArtifactsForIssue(issueId).find((a) => a.kind === "diff_truncated_evidence"));
  // The override still publishes — as a COMMENT (escalated's mapped event), never as the
  // reviewer's actually-reported APPROVE.
  const published = listArtifactsForIssue(issueId).find((a) => a.kind === "review_published");
  assert.equal(JSON.parse(published!.contentJson!).event, "COMMENT");
});

test("changes_requested: findings thread onto the issue and a fresh developer repair round is queued", async () => {
  const issueId = await makeIssue();
  const github = fakeGithub();
  await advanceToReviewing(issueId, github);
  const finding = { fingerprint: "missing-test", severity: "blocking" as const, title: "No test", rationale: "Add one." };
  registerEffectHandler("reviewer", (ctx) =>
    runReviewerEffect(ctx, { deckCallTool: okDeckCallTool, spawn: verdictSpawn({ verdict: "changes_requested", findings: [finding] }), github })
  );
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "repairing");
  assert.equal(issue.currentRound, 2);
  assert.equal(listWorkItemsForIssue(issueId).filter((i) => i.kind === "developer" && i.round === 2).length, 1);

  const findings = listFindingsForIssue(issueId);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].fingerprint, "missing-test");
  assert.equal(findings[0].status, "open");
});

test("escalated with a product scope question opens product_scope_decision", async () => {
  const issueId = await makeIssue();
  const github = fakeGithub();
  await advanceToReviewing(issueId, github);
  registerEffectHandler("reviewer", (ctx) =>
    runReviewerEffect(ctx, { deckCallTool: okDeckCallTool, spawn: verdictSpawn({ verdict: "escalated", productScopeQuestion: "Should this support X?" }), github })
  );
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human");
  const action = listHumanActionsForIssue(issueId).find((a) => a.actionType === "product_scope_decision");
  assert.ok(action);
  assert.equal(action!.reason, "Should this support X?");
});

test("escalated with no product scope question opens policy_escalation", async () => {
  const issueId = await makeIssue();
  const github = fakeGithub();
  await advanceToReviewing(issueId, github);
  registerEffectHandler("reviewer", (ctx) => runReviewerEffect(ctx, { deckCallTool: okDeckCallTool, spawn: verdictSpawn({ verdict: "escalated" }), github }));
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human");
  assert.ok(listHumanActionsForIssue(issueId).find((a) => a.actionType === "policy_escalation"));
});

test("stale: a head that moved since the reviewer was queued is re-reviewed at the new head, not silently published against the old one", async () => {
  const issueId = await makeIssue();
  const github = fakeGithub();
  await advanceToReviewing(issueId, github);
  const branch = issueBranchName(issueId);

  // Simulate a race: another push lands on the branch after this reviewer item was
  // enqueued (pinned to the old head) but before its session runs.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-reveff-race-"));
  execFileSync("git", ["clone", "-q", remote, other]);
  git(other, "checkout", "-q", branch);
  git(other, "config", "user.email", "test@example.com");
  git(other, "config", "user.name", "Test");
  fs.writeFileSync(path.join(other, "race.txt"), "x");
  git(other, "add", ".");
  git(other, "-c", "user.email=race@test", "-c", "user.name=Race", "commit", "-q", "-m", "concurrent push");
  git(other, "push", "-q", "origin", branch);
  const newHead = git(other, "rev-parse", "HEAD");
  fs.rmSync(other, { recursive: true, force: true });

  registerEffectHandler("reviewer", (ctx) => runReviewerEffect(ctx, { deckCallTool: okDeckCallTool, spawn: verdictSpawn({ verdict: "approved" }), github }));
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "reviewing", "a stale re-review stays in reviewing, not final_review");
  assert.equal(issue.headSha, newHead);
  const items = listWorkItemsForIssue(issueId).filter((i) => i.kind === "reviewer");
  assert.equal(items.filter((i) => i.status === "pending").length, 1, "a fresh reviewer item is queued at the new head");
  assert.ok(listArtifactsForIssue(issueId).find((a) => a.kind === "stale_review_evidence"));
});

test("session_failed: an unparseable transcript escalates without consuming a round", async () => {
  const issueId = await makeIssue({ maxInfraAttempts: 0 });
  const github = fakeGithub();
  await advanceToReviewing(issueId, github);
  registerEffectHandler("reviewer", (ctx) => runReviewerEffect(ctx, { deckCallTool: okDeckCallTool, spawn: garbageSpawn, github }));
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human");
  assert.equal(issue.currentRound, 1, "a failed reviewer session never consumes a round");
  assert.ok(listHumanActionsForIssue(issueId).find((a) => a.actionType === "policy_escalation"));
  const rev = listWorkerSessionsForIssue(issueId).find((s) => s.role === "reviewer")!;
  assert.equal(rev.status, "failed");
});

test("session_failed: the reviewer process exits non-zero", async () => {
  const issueId = await makeIssue({ maxInfraAttempts: 0 });
  const github = fakeGithub();
  await advanceToReviewing(issueId, github);
  registerEffectHandler("reviewer", (ctx) => runReviewerEffect(ctx, { deckCallTool: okDeckCallTool, spawn: crashingReviewerSpawn, github }));
  await pump(1);

  assert.equal(getIssue(issueId)!.status, "needs_human");
});

test("session_failed: the reviewer's own wall-clock timeout is folded into session_failed (no separate timed_out kind for reviewers)", async () => {
  const issueId = await makeIssue({ maxInfraAttempts: 0 });
  const github = fakeGithub();
  await advanceToReviewing(issueId, github);
  registerEffectHandler("reviewer", (ctx) => runReviewerEffect(ctx, { deckCallTool: okDeckCallTool, spawn: timedOutReviewerSpawn, github }));
  await pump(1);

  const rev = listWorkerSessionsForIssue(issueId).find((s) => s.role === "reviewer")!;
  assert.equal(rev.status, "failed");
  assert.equal(getIssue(issueId)!.status, "needs_human");
});

test("publish_failed: gh pr review itself fails — escalates as infrastructure, not a code finding", async () => {
  const issueId = await makeIssue({ maxInfraAttempts: 0 });
  const github = fakeGithub({ publishFails: true });
  await advanceToReviewing(issueId, github);
  registerEffectHandler("reviewer", (ctx) => runReviewerEffect(ctx, { deckCallTool: okDeckCallTool, spawn: verdictSpawn({ verdict: "approved" }), github }));
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human");
  assert.equal(issue.currentRound, 1, "a publish failure never consumes a round");
  assert.ok(listHumanActionsForIssue(issueId).find((a) => a.actionType === "policy_escalation"));
});

test("publish_failed: the PR cannot be re-verified after the reviewer session ends", async () => {
  const issueId = await makeIssue({ maxInfraAttempts: 0 });
  const github = fakeGithub();
  await advanceToReviewing(issueId, github);
  github.viewPr = async () => null;
  registerEffectHandler("reviewer", (ctx) => runReviewerEffect(ctx, { deckCallTool: okDeckCallTool, spawn: verdictSpawn({ verdict: "approved" }), github }));
  await pump(1);

  assert.equal(getIssue(issueId)!.status, "needs_human");
});

test("NOT-83 review: a reviewer item cancelled during worktree/deck-bind setup (before spawn) is never spawned", async () => {
  const issueId = await makeIssue();
  const github = fakeGithub();
  await advanceToReviewing(issueId, github);
  const workItem = listWorkItemsForIssue(issueId).find((i) => i.kind === "reviewer" && i.status === "pending")!;
  // Captured before cancelling — the factory's own internal lookup requires `status ===
  // "pending"`, which cancelWorkItem below no longer satisfies.
  const ctxWithLease = reviewerCtxFactory(issueId);

  setWorkItemLease(workItem.id, "token-1");
  // Simulates an abort landing while this handler is still inside worktree/deck-bind setup
  // (reviewer-effect.ts's guard runs after that, right before spawn) — cancelWorkItem is
  // exactly what abortIssue (commands.ts) calls in that scenario.
  assert.ok(cancelWorkItem(workItem.id), "expected the leased item to still be cancellable");

  let spawnCalled = false;
  const spySpawn: ReviewerSpawnFn = async (input) => {
    spawnCalled = true;
    return verdictSpawn({ verdict: "approved" })(input);
  };

  const outcome = await runReviewerEffect(ctxWithLease("token-1"), { deckCallTool: okDeckCallTool, spawn: spySpawn, github });
  assert.equal(spawnCalled, false, "a cancelled item must never reach the real spawn");
  assert.deepEqual(outcome, { kind: "session_failed" });
});
