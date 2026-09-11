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

const { migrate, getDb } = await import("../db/index.js");
const { createAgent } = await import("../repository/agents.js");
const { createIssue, getIssue } = await import("../repository/issues.js");
const { listWorkerSessionsForIssue } = await import("../repository/worker-sessions.js");
const { listWorkItemsForIssue } = await import("../repository/work-items.js");
const { listArtifactsForIssue } = await import("../repository/artifacts-for-issue.js");
const { listHumanActionsForIssue } = await import("../repository/human-actions.js");
const { listFindingsForIssue } = await import("../repository/findings.js");
const { getActiveWorkflowInstance } = await import("../repository/workflow-events.js");
const { createWorkerSession } = await import("../repository/worker-sessions.js");
const { startWorkflow } = await import("./commands.js");
const { registerEffectHandler, resetEffectHandlers } = await import("./effect-registry.js");
const { runCoordinatorTick, drainCoordinator } = await import("./worker-loop.js");
const { runDeveloperEffect } = await import("./developer-effect.js");
const { runReviewerEffect } = await import("./reviewer-effect.js");
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

async function makeIssue(): Promise<string> {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", workspaceRoot: repo });
  const rev = createAgent({ name: `rev-${Math.random()}`, runtime: "claude_code", workspaceRoot: repo });
  return createIssue({
    title: "Add widget",
    description: "Build the widget.",
    acceptanceCriteria: "Widget renders.",
    repo,
    baseBranch: "main",
    developerAgentId: dev.id,
    reviewerAgentId: rev.id,
    maxReviewRounds: 3,
    source: "manual",
  }).id;
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
    ...(opts.productScopeQuestion ? { productScopeQuestion: opts.productScopeQuestion } : {}),
  };
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
  timedOut: false,
});

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
 * NOT independently deduplicate by `(number, headSha)`. That's deliberate: the real
 * duplicate-submission guard now lives in `reviewer-effect.ts` itself (the durable
 * `review_publications` claim, gating entry before `publishReview` is ever called), not
 * in the adapter. Keeping the fake's own bookkeeping this simple means a test asserting
 * `publishCallCount() === 1` after two effect runs is actually exercising the caller's
 * claim, not a dedup the fake would have papered over on its own. `findOwnReview` reports
 * by `(number, headSha, marker)`, matching the real adapter's own narrower-than-identity
 * lookup.
 */
function fakeGithub(opts: FakeGithubOpts = {}): GithubFn & { publishCallCount(): number } {
  const prsByBranch = new Map<string, { number: number; url: string; base: string }>();
  const branchByNumber = new Map<number, string>();
  const publishedReviews = new Map<string, { event: ReviewEvent; marker: string }>();
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
    async findOwnReview({ number, headSha, marker }) {
      const existing = publishedReviews.get(`${number}:${headSha}`);
      return existing && existing.marker === marker ? existing.event : null;
    },
    async publishReview({ number, headSha, marker, event }) {
      publishCalls++;
      if (opts.publishFails) return { ok: false, reason: "boom" };
      const finalEvent: ReviewEvent = opts.rejectSelfReview && event !== "COMMENT" ? "COMMENT" : event;
      publishedReviews.set(`${number}:${headSha}`, { event: finalEvent, marker });
      return { ok: true, event: finalEvent, usedCommentFallback: finalEvent !== event };
    },
  };
  return Object.assign(adapter, { publishCallCount: () => publishCalls });
}

/** Advances the issue to "reviewing" with a real coordinator-verified head SHA. */
async function advanceToReviewing(issueId: string, github: GithubFn): Promise<void> {
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { spawn: commitingSpawn, github }));
  startWorkflow(issueId);
  await pump(1);
  assert.equal(getIssue(issueId)!.status, "reviewing", "test setup: developer stage did not reach reviewing");
}

test("approved: the coordinator verifies the pinned SHA, publishes the review, and opens final_review", async () => {
  const issueId = await makeIssue();
  const github = fakeGithub();
  await advanceToReviewing(issueId, github);
  registerEffectHandler("reviewer", (ctx) => runReviewerEffect(ctx, { spawn: verdictSpawn({ verdict: "approved" }), github }));
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
});

test("same-identity fallback: GitHub rejecting APPROVE as a self-review still records the internal verdict and moves to final_review", async () => {
  const issueId = await makeIssue();
  const github = fakeGithub({ rejectSelfReview: true });
  await advanceToReviewing(issueId, github);
  registerEffectHandler("reviewer", (ctx) => runReviewerEffect(ctx, { spawn: verdictSpawn({ verdict: "approved" }), github }));
  await pump(1);

  assert.equal(getIssue(issueId)!.status, "final_review", "the internal verdict is the workflow authority, not the GitHub event");
  const published = listArtifactsForIssue(issueId).find((a) => a.kind === "review_published");
  assert.equal(JSON.parse(published!.contentJson!).event, "COMMENT");
  assert.equal(JSON.parse(published!.contentJson!).usedCommentFallback, true);
});

test("session_failed: a verdict reporting SHAs that don't match the coordinator-verified revision is rejected, not accepted", async () => {
  const issueId = await makeIssue();
  const github = fakeGithub();
  await advanceToReviewing(issueId, github);
  registerEffectHandler("reviewer", (ctx) => runReviewerEffect(ctx, { spawn: wrongShaSpawn, github }));
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human", "a wrong-SHA verdict must never reach final_review");
  assert.equal(issue.currentRound, 1, "a rejected verdict never consumes a round");
  assert.equal(github.publishCallCount(), 0, "a rejected verdict is never published");
});

test("publish is idempotent: re-running the effect for the same PR/head (simulating a crash before the work item's completion CAS, then recovery) does not submit a second review", async () => {
  const issueId = await makeIssue();
  const github = fakeGithub();
  await advanceToReviewing(issueId, github);

  const issue = getIssue(issueId)!;
  const instance = getActiveWorkflowInstance(issueId)!;
  const workItem = listWorkItemsForIssue(issueId).find((i) => i.kind === "reviewer" && i.status === "pending")!;
  const deps = { spawn: verdictSpawn({ verdict: "approved" }), github };

  // A real worker_sessions row per attempt — createIssueArtifact's FK requires one, and
  // this also matches what worker-loop.ts's processWorkItem actually does on each attempt
  // (a fresh session per claim of the same work item).
  const ctxFor = (): EffectContext => {
    const session = createWorkerSession({
      issueId: issue.id,
      role: "reviewer",
      round: workItem.round,
      agentId: issue.reviewerAgentId,
      runtime: "claude_code",
    });
    return {
      workItem: { ...workItem, workerSessionId: session.id },
      issue,
      instance,
      signal: new AbortController().signal,
    };
  };

  const first = await runReviewerEffect(ctxFor(), deps);
  const second = await runReviewerEffect(ctxFor(), deps);

  assert.equal(first.kind, "verdict");
  assert.equal(second.kind, "verdict");
  assert.equal(github.publishCallCount(), 1, "GitHub must only actually be mutated once");
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
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { spawn: bigFileSpawn, github }));
  startWorkflow(issueId);
  await pump(1);
  assert.equal(getIssue(issueId)!.status, "reviewing", "test setup: developer stage did not reach reviewing");

  registerEffectHandler("reviewer", (ctx) => runReviewerEffect(ctx, { spawn: verdictSpawn({ verdict: "approved" }), github }));
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
    runReviewerEffect(ctx, { spawn: verdictSpawn({ verdict: "changes_requested", findings: [finding] }), github })
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
    runReviewerEffect(ctx, { spawn: verdictSpawn({ verdict: "escalated", productScopeQuestion: "Should this support X?" }), github })
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
  registerEffectHandler("reviewer", (ctx) => runReviewerEffect(ctx, { spawn: verdictSpawn({ verdict: "escalated" }), github }));
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

  registerEffectHandler("reviewer", (ctx) => runReviewerEffect(ctx, { spawn: verdictSpawn({ verdict: "approved" }), github }));
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "reviewing", "a stale re-review stays in reviewing, not final_review");
  assert.equal(issue.headSha, newHead);
  const items = listWorkItemsForIssue(issueId).filter((i) => i.kind === "reviewer");
  assert.equal(items.filter((i) => i.status === "pending").length, 1, "a fresh reviewer item is queued at the new head");
  assert.ok(listArtifactsForIssue(issueId).find((a) => a.kind === "stale_review_evidence"));
});

test("session_failed: an unparseable transcript escalates without consuming a round", async () => {
  const issueId = await makeIssue();
  const github = fakeGithub();
  await advanceToReviewing(issueId, github);
  registerEffectHandler("reviewer", (ctx) => runReviewerEffect(ctx, { spawn: garbageSpawn, github }));
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human");
  assert.equal(issue.currentRound, 1, "a failed reviewer session never consumes a round");
  assert.ok(listHumanActionsForIssue(issueId).find((a) => a.actionType === "policy_escalation"));
  const rev = listWorkerSessionsForIssue(issueId).find((s) => s.role === "reviewer")!;
  assert.equal(rev.status, "failed");
});

test("session_failed: the reviewer process exits non-zero", async () => {
  const issueId = await makeIssue();
  const github = fakeGithub();
  await advanceToReviewing(issueId, github);
  registerEffectHandler("reviewer", (ctx) => runReviewerEffect(ctx, { spawn: crashingReviewerSpawn, github }));
  await pump(1);

  assert.equal(getIssue(issueId)!.status, "needs_human");
});

test("session_failed: the reviewer's own wall-clock timeout is folded into session_failed (no separate timed_out kind for reviewers)", async () => {
  const issueId = await makeIssue();
  const github = fakeGithub();
  await advanceToReviewing(issueId, github);
  registerEffectHandler("reviewer", (ctx) => runReviewerEffect(ctx, { spawn: timedOutReviewerSpawn, github }));
  await pump(1);

  const rev = listWorkerSessionsForIssue(issueId).find((s) => s.role === "reviewer")!;
  assert.equal(rev.status, "failed");
  assert.equal(getIssue(issueId)!.status, "needs_human");
});

test("publish_failed: gh pr review itself fails — escalates as infrastructure, not a code finding", async () => {
  const issueId = await makeIssue();
  const github = fakeGithub({ publishFails: true });
  await advanceToReviewing(issueId, github);
  registerEffectHandler("reviewer", (ctx) => runReviewerEffect(ctx, { spawn: verdictSpawn({ verdict: "approved" }), github }));
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human");
  assert.equal(issue.currentRound, 1, "a publish failure never consumes a round");
  assert.ok(listHumanActionsForIssue(issueId).find((a) => a.actionType === "policy_escalation"));
});

test("publish_failed: the PR cannot be re-verified after the reviewer session ends", async () => {
  const issueId = await makeIssue();
  const github = fakeGithub();
  await advanceToReviewing(issueId, github);
  github.viewPr = async () => null;
  registerEffectHandler("reviewer", (ctx) => runReviewerEffect(ctx, { spawn: verdictSpawn({ verdict: "approved" }), github }));
  await pump(1);

  assert.equal(getIssue(issueId)!.status, "needs_human");
});
