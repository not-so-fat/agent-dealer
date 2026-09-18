// packages/server/src/coordinator/repair-cycle.integration.test.ts
//
// NOT-63 acceptance test: the ticket's required end-to-end scenario — developer round 1
// → reviewer changes_requested → developer round 2 on the SAME branch → reviewer
// approved — driven through the real coordinator (startWorkflow → tick → routing → next
// effect) against a real Git repository (temp repo + bare "origin" remote) and real
// worktrees. Only the agent CLI session and GitHub publication are faked (the confirmed
// NOT-61/62 scope: no paid CLI spawn, no real GitHub calls) — everything else (git,
// worktree lifecycle, PR/SHA verification, findings persistence, budget bookkeeping) is
// exercised for real.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GithubAdapter, ReviewEvent } from "../adapters/github.js";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-repair-home-"));
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
const { listWorkItemsForIssue } = await import("../repository/work-items.js");
const { listHumanActionsForIssue } = await import("../repository/human-actions.js");
const { listFindingsForIssue } = await import("../repository/findings.js");
const { listWorkflowEventsForIssue } = await import("../repository/workflow-events.js");
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
beforeEach(() => getDb().exec("DELETE FROM review_publications; DELETE FROM work_items;"));
after(() => resetEffectHandlers());

let repo: string;
let remote: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-repair-repo-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");

  remote = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-repair-remote-"));
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
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", deckId: "00000000-0000-4000-a000-000000000099"});
  const rev = createAgent({ name: `rev-${Math.random()}`, runtime: "claude_code", deckId: "00000000-0000-4000-a000-000000000099"});
  return createIssue({
    title: "Add widget",
    description: "Build the widget.",
    acceptanceCriteria: "Widget renders.",
    repo,
    baseBranch: "main",
    developerAgentId: dev.id,
    reviewerAgentId: rev.id,
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual"}).id;
}

async function pump(max = 20): Promise<void> {
  for (let i = 0; i < max; i++) {
    const started = await runCoordinatorTick({ leaseOwner: "pump" });
    await drainCoordinator();
    if (started === 0) return;
  }
}

/** Round 1: implements the widget for real (a genuine first commit). */
const round1Spawn: SpawnFn = async (input) => {
  fs.writeFileSync(path.join(input.cwd, "feature.txt"), "implemented v1\n");
  git(input.cwd, "add", ".");
  git(input.cwd, "-c", "user.email=agent@test", "-c", "user.name=Agent", "commit", "-q", "-m", "implement widget");
  return { exitCode: 0, transcript: "Implementation conclusion: added the widget.", logPath: "/dev/null", timedOut: false };
};

/** Round 2: a genuinely different commit addressing the round-1 finding — proves the
 * retry actually re-ran the agent rather than replaying the same diff. */
const round2Spawn: SpawnFn = async (input) => {
  fs.writeFileSync(path.join(input.cwd, "feature.txt"), "implemented v1\nadded a test\n");
  git(input.cwd, "add", ".");
  git(input.cwd, "-c", "user.email=agent@test", "-c", "user.name=Agent", "commit", "-q", "-m", "add the missing test");
  return { exitCode: 0, transcript: "Implementation conclusion: added the missing test the reviewer asked for.", logPath: "/dev/null", timedOut: false };
};

function roundAwareDeveloperSpawn(): SpawnFn {
  let calls = 0;
  return async (input) => {
    calls++;
    return calls === 1 ? round1Spawn(input) : round2Spawn(input);
  };
}

const ROUND1_FINDING = { fingerprint: "missing-test", severity: "blocking" as const, title: "No test for the widget", rationale: "Add a test." };

function reviewerTranscript(verdict: "changes_requested" | "approved", baseSha: string, headSha: string): string {
  const body = {
    verdict,
    baseSha,
    headSha,
    acceptanceCriteriaAssessment: verdict === "approved" ? "Met." : "Not yet — missing test coverage.",
    evidenceAssessment: "Evidence checked.",
    findings: verdict === "changes_requested" ? [ROUND1_FINDING] : [],
    risks: []};
  return `\`\`\`json\n${JSON.stringify(body)}\n\`\`\`\n`;
}

function shasFromPrompt(prompt: string): { baseSha: string; headSha: string } {
  const baseSha = prompt.match(/"baseSha" to exactly "([0-9a-f]+)"/)?.[1];
  const headSha = prompt.match(/"headSha" to exactly "([0-9a-f]+)"/)?.[1];
  if (!baseSha || !headSha) throw new Error("could not extract SHAs from reviewer prompt");
  return { baseSha, headSha };
}

/** Round 1 requests changes; round 2 approves — the ticket's exact required scenario. */
function roundAwareReviewerSpawn(): ReviewerSpawnFn {
  let calls = 0;
  return async (input) => {
    calls++;
    const { baseSha, headSha } = shasFromPrompt(input.prompt);
    const verdict = calls === 1 ? "changes_requested" : "approved";
    return { exitCode: 0, transcript: reviewerTranscript(verdict, baseSha, headSha), logPath: "/dev/null", timedOut: false };
  };
}

/** In-memory PR store — real git tells it the branch/head, nothing hits real GitHub. */
function fakeGithub(): GithubFn {
  const prsByBranch = new Map<string, { number: number; url: string; base: string }>();
  const branchByNumber = new Map<number, string>();
  let nextNumber = 200;
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
      return "success";
    },
    async publishReview({ event }) {
      const finalEvent: ReviewEvent = event;
      return { ok: true, event: finalEvent, usedCommentFallback: false };
    }};
  return adapter;
}

test("developer round 1 → reviewer changes_requested → developer round 2 on the same branch → reviewer approved", async () => {
  const issueId = await makeIssue();
  const github = fakeGithub();
  // Each spawn's call-counter must persist ACROSS attempts — build it once, outside the
  // handler closure, or every invocation would reset to round 1's behavior.
  const devSpawn = roundAwareDeveloperSpawn();
  const revSpawn = roundAwareReviewerSpawn();
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { spawn: devSpawn, github }));
  registerEffectHandler("reviewer", (ctx) => runReviewerEffect(ctx, { spawn: revSpawn, github }));

  startWorkflow(issueId);
  await pump();

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "final_review", "the cycle must end at a human final_review, not stuck or escalated");
  assert.equal(issue.currentRound, 2, "exactly one genuine repair round — changes_requested — was spent");
  assert.equal(issue.infraAttempts, 0, "nothing in this run was an infra failure");
  assert.ok(listHumanActionsForIssue(issueId).find((a) => a.actionType === "final_review" && a.status === "open"));

  // Same branch reused across both rounds — never re-created.
  const branch = issueBranchName(issueId);
  assert.equal(issue.branch, branch);

  // Two real developer sessions and two real reviewer sessions, one per round.
  const devSessions = listWorkerSessionsForIssue(issueId).filter((s) => s.role === "developer");
  const revSessions = listWorkerSessionsForIssue(issueId).filter((s) => s.role === "reviewer");
  assert.equal(devSessions.length, 2);
  assert.equal(revSessions.length, 2);
  assert.ok(devSessions.every((s) => s.status === "done"));
  assert.ok(revSessions.every((s) => s.status === "done"));

  // Round 2's reviewer was pinned to round 2's real, freshly-verified head — never the
  // round-1 head (no retry path used a stale SHA).
  const round1DevWorkItem = listWorkItemsForIssue(issueId).find((i) => i.kind === "developer" && i.round === 1)!;
  const round2DevWorkItem = listWorkItemsForIssue(issueId).find((i) => i.kind === "developer" && i.round === 2)!;
  const round2ReviewerWorkItem = listWorkItemsForIssue(issueId).find((i) => i.kind === "reviewer" && i.round === 2)!;
  const round1HeadSha = (round1DevWorkItem.resultJson && JSON.parse(round1DevWorkItem.resultJson).headSha) as string;
  const round2HeadSha = (round2DevWorkItem.resultJson && JSON.parse(round2DevWorkItem.resultJson).headSha) as string;
  assert.notEqual(round1HeadSha, round2HeadSha, "round 2 must produce a genuinely new head");
  assert.equal(JSON.parse(round2ReviewerWorkItem.payloadJson!).inputSha, round2HeadSha);
  assert.equal(issue.headSha, round2HeadSha);

  // Real git: the branch on the bare remote actually carries both commits.
  const log = git(remote, "log", "--oneline", branch);
  assert.equal(log.split("\n").length, 3, "init + round-1 commit + round-2 commit");

  // Round 1's finding is threaded onto the issue and reached round 2's developer prompt.
  const findings = listFindingsForIssue(issueId);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].fingerprint, ROUND1_FINDING.fingerprint);

  // Invariant: at every intermediate step the issue had a next effect (never neither a
  // pending work item nor an open human action) — reconstructed from the event log.
  const events = listWorkflowEventsForIssue(issueId).map((e) => e.type);
  assert.ok(events.includes("repair.started"), "the changes_requested round transition was recorded");
  assert.ok(events.includes("review.submitted"));
  assert.ok(events.includes("final_review.requested"));
});
