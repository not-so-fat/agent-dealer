// packages/server/src/coordinator/developer-effect.test.ts
//
// NOT-61 acceptance test: a real Git repository (temp repo + bare "origin" remote) drives
// worktree/push/PR-verification, while the agent session itself and GitHub are faked — the
// confirmed scope for this ticket (no paid CLI spawn, no real GitHub calls). Exercises
// every distinct DeveloperOutcome the acceptance criteria names, end to end through the
// real coordinator (startWorkflow → tick → routing), not just the handler in isolation.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-deveff-home-"));
process.env.MAX_COORDINATOR_CONCURRENCY = "2";
process.env.COORDINATOR_HEARTBEAT_MS = "20";
process.env.COORDINATOR_FAIL_BACKOFF_MS = "0";
process.env.CHECKS_POLL_TIMEOUT_MS = "60";
process.env.CHECKS_POLL_INTERVAL_MS = "10";

const { migrate, getDb } = await import("../db/index.js");
const { createAgent } = await import("../repository/agents.js");
const { createIssue, getIssue } = await import("../repository/issues.js");
const { listWorkerSessionsForIssue } = await import("../repository/worker-sessions.js");
const { listWorkItemsForIssue } = await import("../repository/work-items.js");
const { listArtifactsForIssue } = await import("../repository/artifacts-for-issue.js");
const { listHumanActionsForIssue } = await import("../repository/human-actions.js");
const { startWorkflow } = await import("./commands.js");
const { registerEffectHandler, resetEffectHandlers } = await import("./effect-registry.js");
const { runCoordinatorTick, drainCoordinator } = await import("./worker-loop.js");
const { runDeveloperEffect } = await import("./developer-effect.js");
const { realDeveloperSpawn } = await import("./spawn.js");
const { realGithubAdapter } = await import("../adapters/github.js");
type SpawnFn = typeof realDeveloperSpawn;
type GithubFn = typeof realGithubAdapter;

before(() => migrate());
beforeEach(() => getDb().exec("DELETE FROM work_items"));
after(() => resetEffectHandlers());

let repo: string;
let remote: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-deveff-repo-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");

  remote = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-deveff-remote-"));
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

/** Commits a file in the worktree — the "agent implemented the task" fake. */
const commitingSpawn: SpawnFn = async (input) => {
  fs.writeFileSync(path.join(input.cwd, "feature.txt"), "implemented\n");
  git(input.cwd, "add", ".");
  git(input.cwd, "-c", "user.email=agent@test", "-c", "user.name=Agent", "commit", "-q", "-m", "implement");
  return { exitCode: 0, transcript: "Implementation conclusion: added the widget.", logPath: "/dev/null", timedOut: false };
};

/** Never touches the worktree — nothing to push, the no_pr outcome. */
const noopSpawn: SpawnFn = async () => ({ exitCode: 0, transcript: "", logPath: "/dev/null", timedOut: false });

/** Leaves an untracked file uncommitted — the dirty_worktree outcome. */
const dirtySpawn: SpawnFn = async (input) => {
  fs.writeFileSync(path.join(input.cwd, "scratch.txt"), "oops\n");
  return { exitCode: 0, transcript: "", logPath: "/dev/null", timedOut: false };
};

const crashingSpawn: SpawnFn = async () => ({ exitCode: 1, transcript: "boom", logPath: "/dev/null", timedOut: false });
const timedOutSpawn: SpawnFn = async () => ({ exitCode: 1, transcript: "", logPath: "/dev/null", timedOut: true });

/** In-memory PR store keyed by branch — real git tells it the branch/head, nothing hits real GitHub. */
function fakeGithub(opts: { checks?: "success" | "failure" | "pending"; createFails?: boolean } = {}): GithubFn {
  const prs = new Map<string, { number: number; url: string; base: string }>();
  let nextNumber = 100;
  const currentBranch = (cwd: string) => git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
  const currentHead = (cwd: string) => git(cwd, "rev-parse", "HEAD");
  return {
    async viewPr({ cwd }) {
      const branch = currentBranch(cwd);
      const pr = prs.get(branch);
      if (!pr) return null;
      return { number: pr.number, url: pr.url, baseRefName: pr.base, headRefName: branch, headRefOid: currentHead(cwd) };
    },
    async createDraftPr({ cwd, base }) {
      if (opts.createFails) return { ok: false, reason: "gh: simulated failure", noCommits: false };
      const branch = currentBranch(cwd);
      const number = nextNumber++;
      const url = `https://github.com/o/r/pull/${number}`;
      prs.set(branch, { number, url, base });
      return { ok: true, number, url };
    },
    async checksSnapshot() {
      return opts.checks ?? "success";
    },
  } as GithubFn;
}

test("clean handoff: real worktree, real push, fake GitHub — issue moves to reviewing with a reviewer work item queued", async () => {
  const issueId = await makeIssue();
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { spawn: commitingSpawn, github: fakeGithub() }));
  startWorkflow(issueId);
  // Only pump the developer item — the reviewer effect handler is still NOT-62's
  // placeholder (always session_failed), which would otherwise immediately escalate the
  // just-queued reviewer work item and mask what this test actually checks.
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "reviewing");
  assert.equal(issue.branch, issueBranchName(issueId));
  assert.ok(issue.headSha);
  assert.ok(issue.prNumber);
  assert.equal(git(repo, "ls-remote", "origin", `refs/heads/${issue.branch}`).length > 0, true);

  const devSession = listWorkerSessionsForIssue(issueId).find((s) => s.role === "developer")!;
  assert.equal(devSession.status, "done");

  const kinds = listArtifactsForIssue(issueId).map((a) => a.kind);
  assert.ok(kinds.includes("task_snapshot"));
  assert.ok(kinds.includes("implementation_conclusion"));
  assert.ok(kinds.includes("developer_transcript"));
  assert.ok(kinds.includes("checks_evidence"));

  assert.equal(listWorkItemsForIssue(issueId).filter((i) => i.kind === "reviewer" && i.status === "pending").length, 1);
});

test("no_pr: the agent makes no commits — retried, no reviewer work item", async () => {
  const issueId = await makeIssue();
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { spawn: noopSpawn, github: fakeGithub() }));
  startWorkflow(issueId);
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "developing");
  assert.equal(listWorkItemsForIssue(issueId).filter((i) => i.kind === "reviewer").length, 0);
  assert.equal(listWorkItemsForIssue(issueId).some((i) => i.kind === "developer" && i.round === 2), true);
});

test("dirty_worktree: an uncommitted file escalates without consuming a round", async () => {
  const issueId = await makeIssue();
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { spawn: dirtySpawn, github: fakeGithub() }));
  startWorkflow(issueId);
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human");
  assert.equal(issue.currentRound, 1, "dirty worktree never consumes a round");
  const action = listHumanActionsForIssue(issueId).find((a) => a.actionType === "policy_escalation");
  assert.ok(action, "expected a policy_escalation human action");
});

test("session_failed: the agent process exits non-zero — retried like no_pr", async () => {
  const issueId = await makeIssue();
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { spawn: crashingSpawn, github: fakeGithub() }));
  startWorkflow(issueId);
  await pump(1);

  assert.equal(getIssue(issueId)!.status, "developing");
  const dev = listWorkerSessionsForIssue(issueId).find((s) => s.role === "developer")!;
  assert.equal(dev.status, "failed");
});

test("timed_out (session): the spawn wall-clock timeout is reported distinctly from a crash", async () => {
  const issueId = await makeIssue();
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { spawn: timedOutSpawn, github: fakeGithub() }));
  startWorkflow(issueId);
  await pump(1);

  const dev = listWorkerSessionsForIssue(issueId).find((s) => s.role === "developer")!;
  assert.equal(dev.status, "timed_out");
});

test("checks_failed: CI failure after a clean push/PR retries without a human action", async () => {
  const issueId = await makeIssue();
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { spawn: commitingSpawn, github: fakeGithub({ checks: "failure" }) }));
  startWorkflow(issueId);
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "developing");
  assert.equal(listWorkItemsForIssue(issueId).filter((i) => i.kind === "reviewer").length, 0);
  const evidence = listArtifactsForIssue(issueId).find((a) => a.kind === "checks_evidence");
  assert.ok(evidence, "checks_failed still persists check evidence for the issue evidence API");
  assert.equal(JSON.parse(evidence!.contentJson!).snapshot, "failure");
});

test("timed_out (checks poll): checks stay pending past the poll deadline", async () => {
  const issueId = await makeIssue();
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { spawn: commitingSpawn, github: fakeGithub({ checks: "pending" }) }));
  startWorkflow(issueId);
  await pump(1);

  assert.equal(getIssue(issueId)!.status, "developing");
});

test("adapter_failure: gh pr create itself fails — escalates, never silently retried as a crash", async () => {
  const issueId = await makeIssue();
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { spawn: commitingSpawn, github: fakeGithub({ createFails: true }) }));
  startWorkflow(issueId);
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human");
  assert.equal(issue.currentRound, 1, "adapter failure never consumes a round");
  assert.ok(listHumanActionsForIssue(issueId).find((a) => a.actionType === "policy_escalation"));
});

test("unpushed_commit: the coordinator's own push is rejected by a diverged remote branch — escalates, work preserved", async () => {
  const issueId = await makeIssue();
  const branch = issueBranchName(issueId);

  // Pre-create the branch on the remote with a commit our worktree will never have,
  // so the coordinator's push (fast-forward only) is rejected once it tries to push.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-deveff-other-"));
  execFileSync("git", ["clone", "-q", remote, other]);
  git(other, "checkout", "-q", "-b", branch);
  git(other, "config", "user.email", "test@example.com");
  git(other, "config", "user.name", "Test");
  fs.writeFileSync(path.join(other, "elsewhere.txt"), "y");
  git(other, "add", ".");
  git(other, "commit", "-q", "-m", "elsewhere");
  git(other, "push", "-q", "origin", branch);
  fs.rmSync(other, { recursive: true, force: true });

  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { spawn: commitingSpawn, github: fakeGithub() }));
  startWorkflow(issueId);
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human");
  assert.equal(issue.currentRound, 1, "a rejected push never consumes a round");
  assert.ok(listHumanActionsForIssue(issueId).find((a) => a.actionType === "policy_escalation"));

  execFileSync("git", ["push", "-q", remote, `:${branch}`], { cwd: repo }).toString();
});
