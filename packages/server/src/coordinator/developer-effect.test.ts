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
process.env.HEAD_RECONCILE_TIMEOUT_MS = "60";
process.env.HEAD_RECONCILE_INTERVAL_MS = "10";

const { migrate, getDb } = await import("../db/index.js");
const { createAgent } = await import("../repository/agents.js");
const { createIssue, getIssue } = await import("../repository/issues.js");
const { listWorkerSessionsForIssue, createWorkerSession, startSession } = await import(
  "../repository/worker-sessions.js"
);
const { listWorkItemsForIssue, claimWorkItem, bindWorkItemSession, cancelWorkItem } = await import(
  "../repository/work-items.js"
);
const { listArtifactsForIssue } = await import("../repository/artifacts-for-issue.js");
const { listHumanActionsForIssue } = await import("../repository/human-actions.js");
const { listUsageEventsForIssue } = await import("../repository/usage-events.js");
const { getActiveWorkflowInstance, listWorkflowEventsForIssue } = await import("../repository/workflow-events.js");
const { startWorkflow, resolveHumanActionAndAdvance } = await import("./commands.js");
const { registerEffectHandler, resetEffectHandlers } = await import("./effect-registry.js");
const { runCoordinatorTick, drainCoordinator } = await import("./worker-loop.js");
const { runDeveloperEffect } = await import("./developer-effect.js");
const { realDeveloperSpawn } = await import("./spawn.js");
const { realGithubAdapter } = await import("../adapters/github.js");
const { branchExists, roleWorktreePath, withRepoLock } = await import("../adapters/git-worktree.js");
type SpawnFn = typeof realDeveloperSpawn;
type GithubFn = typeof realGithubAdapter;

before(() => migrate());
// NOT-220's test runs reviewer effects, which record review_publications rows keyed
// by work item — they must go before work_items or the FK blocks every later test.
beforeEach(() => getDb().exec("DELETE FROM review_publications; DELETE FROM work_items"));
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

async function makeIssue(opts: { maxInfraAttempts?: number } = {}): Promise<string> {
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
    maxInfraAttempts: opts.maxInfraAttempts ?? 3,
    source: "manual"}).id;
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

/**
 * In-memory PR store keyed by branch — real git tells it the head SHA, nothing hits real
 * GitHub. `viewPr`/`createDraftPr` deliberately require an explicit `branch`/`head` and
 * never fall back to inspecting the worktree's current branch: NOT-82's bug was exactly
 * that fallback (`gh`'s bare current-branch/upstream inference), and a fake that still
 * tolerated it would let a regression back in silently.
 */
function fakeGithub(opts: {
  checks?: "success" | "failure" | "pending";
  createFails?: boolean | (() => boolean);
} = {}): GithubFn {
  const prs = new Map<string, { number: number; url: string; base: string }>();
  let nextNumber = 100;
  // GitHub's view of a PR's head is the REMOTE branch tip, not the local worktree's
  // checkout — reading it from `remote` (rather than `cwd`) lets a test simulate a
  // concurrent push changing the head independently of this worktree.
  const remoteHead = (branch: string) => git(remote, "rev-parse", branch);
  const shouldFailCreate = () =>
    typeof opts.createFails === "function" ? opts.createFails() : Boolean(opts.createFails);
  const adapter: GithubFn = {
    async viewPr({ branch, number }) {
      if (!branch) throw new Error("fakeGithub.viewPr requires an explicit branch — bare current-branch lookup is the NOT-82 bug");
      const pr = prs.get(branch);
      if (!pr) return null;
      if (number != null && number !== pr.number) return null;
      return { number: pr.number, url: pr.url, baseRefName: pr.base, headRefName: branch, headRefOid: remoteHead(branch), isDraft: true };
    },
    async createDraftPr({ base, head }) {
      if (shouldFailCreate()) return { ok: false, reason: "gh: simulated failure", noCommits: false };
      if (!head) throw new Error("fakeGithub.createDraftPr requires an explicit --head — bare create is the NOT-82 bug");
      const number = nextNumber++;
      const url = `https://github.com/o/r/pull/${number}`;
      prs.set(head, { number, url, base });
      return { ok: true, number, url };
    },
    async checksSnapshot({ number, branch }) {
      if (number == null && !branch) {
        throw new Error("fakeGithub.checksSnapshot requires an explicit number or branch — bare checks lookup is the NOT-82 bug");
      }
      return opts.checks ?? "success";
    },
    async publishReview() {
      throw new Error("publishReview is unused by the developer effect");
    }};
  return adapter;
}

test("clean handoff: real worktree, real push, fake GitHub — issue moves to reviewing with a reviewer work item queued", async () => {
  const issueId = await makeIssue();
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: commitingSpawn, github: fakeGithub() }));
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
  // NOT-146: clean handoff is commits + publish — not gated on a full-suite / Lens receipt.
  assert.ok(
    !kinds.includes("verification_receipt"),
    "NOT-146: handoff must succeed without a full-suite verification receipt"
  );

  assert.equal(listWorkItemsForIssue(issueId).filter((i) => i.kind === "reviewer" && i.status === "pending").length, 1);

  const usage = listUsageEventsForIssue(issueId);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].role, "developer");
  assert.equal(usage[0].workerSessionId, devSession.id);
  assert.ok(usage[0].durationMs !== null && usage[0].durationMs! >= 0);

  const { listWorkflowEventsForIssue } = await import("../repository/workflow-events.js");
  const events = listWorkflowEventsForIssue(issueId);
  const started = events.find((e) => e.type === "worker.started");
  assert.ok(started);
  assert.equal(started!.actorType, "developer");
  const payload = started!.payloadJson ? JSON.parse(started!.payloadJson) : null;
  assert.ok(payload?.sessionId);
  assert.ok(payload?.runtime);
  const milestones = events.map((e) => e.type).filter((t) =>
    ["worktree.ready", "brief.resolved", "branch.pushed", "checks.started", "checks.completed"].includes(t)
  );
  assert.ok(milestones.includes("worktree.ready"));
  assert.ok(milestones.includes("brief.resolved"));
  assert.ok(milestones.includes("checks.started"));
  assert.ok(milestones.length >= 3, `expected ≥3 mid-session milestones, got ${milestones.join(",")}`);
  const finished = events.find((e) => e.type === "worker.completed");
  assert.ok(finished);
  assert.equal(finished!.actorType, "developer");
});

test("no_pr: the agent makes no commits — retried, no reviewer work item", async () => {
  const issueId = await makeIssue();
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: noopSpawn, github: fakeGithub() }));
  startWorkflow(issueId);
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "developing");
  assert.equal(issue.currentRound, 1, "no_pr is an infra failure — it must not spend a review round");
  assert.equal(issue.infraAttempts, 1);
  assert.equal(listWorkItemsForIssue(issueId).filter((i) => i.kind === "reviewer").length, 0);
  assert.equal(
    listWorkItemsForIssue(issueId).filter((i) => i.kind === "developer" && i.status === "pending").length,
    1
  );
});

test("the branch created on a retried round is reused, not re-created — no 'branch already exists' collision", async () => {
  const issueId = await makeIssue();
  let call = 0;
  const prompts: string[] = [];
  const flakyThenCommittingSpawn: SpawnFn = async (input) => {
    call++;
    prompts.push(input.prompt);
    if (call === 1) return { exitCode: 0, transcript: "", logPath: "/dev/null", timedOut: false }; // round 1: no_pr
    return commitingSpawn(input); // round 2: implements for real
  };
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: flakyThenCommittingSpawn, github: fakeGithub() }));
  startWorkflow(issueId);

  await pump(1); // round 1: no_pr, removes the worktree but leaves the branch ref behind
  assert.equal(getIssue(issueId)!.status, "developing");
  assert.equal(await branchExists(repo, issueBranchName(issueId)), true, "branch persists across the retry");

  await pump(1); // round 2: must reuse that branch, not fail with "already exists"
  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "reviewing");
  assert.equal(issue.branch, issueBranchName(issueId));
  const devSessions = listWorkerSessionsForIssue(issueId).filter((s) => s.role === "developer");
  assert.equal(devSessions.length, 2);
  assert.equal(devSessions[1].status, "done");

  // The retried session's prompt must carry WHY the prior attempt failed and must NOT
  // claim a fresh branch — it's still round 1 (no_pr is an infra retry, not a new round),
  // and the branch already carries whatever the first attempt left behind.
  assert.doesNotMatch(prompts[0], /Previous attempt|previous attempt failed/);
  assert.match(prompts[1], /retry of round 1 \(same review round/);
  assert.match(prompts[1], /\*\*Last failure:\*\* Developer session produced no PR\./);
  assert.doesNotMatch(prompts[1], /fresh branch/);
});

test("dirty_worktree: an uncommitted file escalates without consuming a round", async () => {
  const issueId = await makeIssue();
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: dirtySpawn, github: fakeGithub() }));
  startWorkflow(issueId);
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human");
  assert.equal(issue.currentRound, 1, "dirty worktree never consumes a round");
  const action = listHumanActionsForIssue(issueId).find((a) => a.actionType === "policy_escalation");
  assert.ok(action, "expected a policy_escalation human action");
  // NOT-145 / NOT-137: exit-0 dirty escalations carry path + recovery like worktree_conflict.
  assert.match(action!.reason, /Recovery:/);
  assert.match(action!.reason, /git status/);
});

test("session_failed: the agent process exits non-zero — retried like no_pr", async () => {
  const issueId = await makeIssue();
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: crashingSpawn, github: fakeGithub() }));
  startWorkflow(issueId);
  await pump(1);

  assert.equal(getIssue(issueId)!.status, "developing");
  const dev = listWorkerSessionsForIssue(issueId).find((s) => s.role === "developer")!;
  assert.equal(dev.status, "failed");

  // Cost is incurred the moment the process runs — a failed session still gets a
  // usage_events row (see developer-effect.ts: recorded before the early return).
  const usage = listUsageEventsForIssue(issueId);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].workerSessionId, dev.id);
});

test("NOT-145: a crash that leaves the worktree dirty auto-commits a salvage tip and retries — WIP is not deleted", async () => {
  // Parent NOT-143: prefer the git tip as the durable checkpoint. Pre-NOT-145 this path
  // escalated dirty_worktree (preserved checkout, human gate). Salvage lands the WIP on
  // the issue branch, removes the worktree cleanly, and routes timed_out/session_failed
  // so retry_developer continues from the salvage tip.
  const issueId = await makeIssue();
  const crashingDirtySpawn: SpawnFn = async (input) => {
    fs.writeFileSync(path.join(input.cwd, "half-done.txt"), "oops\n");
    return { exitCode: 1, transcript: "boom", logPath: "/dev/null", timedOut: false };
  };
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: crashingDirtySpawn, github: fakeGithub() }));
  startWorkflow(issueId);
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "developing", "salvaged crash retries on the infra budget, not a human gate");
  assert.equal(issue.currentRound, 1);
  const branch = issueBranchName(issueId);
  assert.ok(await branchExists(repo, branch));
  assert.equal(git(repo, "log", "-1", "--pretty=%s", branch), "wip: crash salvage");
  assert.ok(git(repo, "show", `${branch}:half-done.txt`).includes("oops"));

  const round1 = listWorkerSessionsForIssue(issueId).find((s) => s.role === "developer")!;
  assert.equal(round1.status, "failed");
  assert.ok(!fs.existsSync(roleWorktreePath(repo, round1.id, "developer")), "clean salvage allows worktree remove");
  assert.match(JSON.parse(round1.errorJson ?? "{}").reason ?? round1.errorJson ?? "", /Salvaged uncommitted work|crash salvage/);
});

test("NOT-145: dirty worktree + forced timeout salvages a tip then routes timed_out for retry", async () => {
  const issueId = await makeIssue();
  const timedOutDirtySpawn: SpawnFn = async (input) => {
    fs.writeFileSync(path.join(input.cwd, "partial.txt"), "still cooking\n");
    return { exitCode: 1, transcript: "", logPath: "/dev/null", timedOut: true };
  };
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: timedOutDirtySpawn, github: fakeGithub() }));
  startWorkflow(issueId);
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "developing");
  const branch = issueBranchName(issueId);
  assert.equal(git(repo, "log", "-1", "--pretty=%s", branch), "wip: timeout salvage");
  assert.ok(git(repo, "show", `${branch}:partial.txt`).includes("still cooking"));

  const dev = listWorkerSessionsForIssue(issueId).find((s) => s.role === "developer")!;
  assert.equal(dev.status, "timed_out");
  assert.ok(!fs.existsSync(roleWorktreePath(repo, dev.id, "developer")));
});

test("NOT-145: clean timeout with existing commits still retries without losing the tip", async () => {
  const issueId = await makeIssue();
  const timedOutAfterCommitSpawn: SpawnFn = async (input) => {
    fs.writeFileSync(path.join(input.cwd, "feature.txt"), "implemented\n");
    git(input.cwd, "add", ".");
    git(input.cwd, "-c", "user.email=agent@test", "-c", "user.name=Agent", "commit", "-q", "-m", "implement");
    return { exitCode: 1, transcript: "", logPath: "/dev/null", timedOut: true };
  };
  registerEffectHandler("developer", (ctx) =>
    runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: timedOutAfterCommitSpawn, github: fakeGithub() })
  );
  startWorkflow(issueId);
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "developing");
  const branch = issueBranchName(issueId);
  assert.equal(git(repo, "log", "-1", "--pretty=%s", branch), "implement");
  assert.ok(await branchExists(repo, branch));

  const dev = listWorkerSessionsForIssue(issueId).find((s) => s.role === "developer")!;
  assert.equal(dev.status, "timed_out");
  assert.ok(!fs.existsSync(roleWorktreePath(repo, dev.id, "developer")), "clean tip allows worktree remove");
});

test("NOT-113: keychain stderr on a dirty crash surfaces auth/keychain after salvage on the retry path", async () => {
  const issueId = await makeIssue();
  const keychainLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dealer-keychain-")), "session.ndjson");
  fs.writeFileSync(
    keychainLog,
    `{"type":"assistant"}\n--- stderr ---\nCursor couldn't save your login to the macOS keychain (errSecDuplicateItem, security exit code 45).\nThe keychain item is stuck.\n`
  );
  const crashingDirtyKeychainSpawn: SpawnFn = async (input) => {
    fs.writeFileSync(path.join(input.cwd, "half-done.txt"), "oops\n");
    return { exitCode: 1, transcript: "boom", logPath: keychainLog, timedOut: false };
  };
  registerEffectHandler("developer", (ctx) =>
    runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: crashingDirtyKeychainSpawn, github: fakeGithub() })
  );
  startWorkflow(issueId);
  await pump(1);

  const issue = getIssue(issueId)!;
  // Salvage lands the tip → session_failed → infra retry (still developing), not dirty escalate.
  assert.equal(issue.status, "developing");
  const branch = issueBranchName(issueId);
  assert.equal(git(repo, "log", "-1", "--pretty=%s", branch), "wip: crash salvage");

  const { listWorkflowEventsForIssue } = await import("../repository/workflow-events.js");
  const failed = listWorkflowEventsForIssue(issueId).filter((e) => e.type === "worker.failed");
  assert.ok(failed.length >= 1);
  const payload = JSON.parse(failed[failed.length - 1]!.payloadJson!) as { reason?: string; outcome?: string };
  assert.equal(payload.outcome, "session_failed");
  assert.match(payload.reason ?? "", /keychain|errSecDuplicateItem/i);
  assert.match(payload.reason ?? "", /Salvaged uncommitted work|crash salvage/);

  const { latestSessionFailureForIssue } = await import("./latest-failure.js");
  const latest = latestSessionFailureForIssue(issue);
  assert.ok(latest);
  assert.match(latest!.reason, /keychain|errSecDuplicateItem/i);
});

test("NOT-145: when salvage commit fails, dirty checkout is preserved with actionable recovery — never wiped", async () => {
  const issueId = await makeIssue();
  const failingSalvageSpawn: SpawnFn = async (input) => {
    fs.writeFileSync(path.join(input.cwd, "half-done.txt"), "oops\n");
    // Reject the coordinator's salvage commit so we exercise the escalate-and-preserve path.
    const hookDir = path.join(input.cwd, ".git", "hooks");
    // Worktrees share .git/hooks via the common dir — write a commit-msg hook that fails.
    const common = git(input.cwd, "rev-parse", "--git-common-dir");
    const hooks = path.isAbsolute(common) ? path.join(common, "hooks") : path.join(input.cwd, common, "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    const hookPath = path.join(hooks, "pre-commit");
    fs.writeFileSync(hookPath, "#!/bin/sh\necho salvage-blocked >&2\nexit 1\n");
    fs.chmodSync(hookPath, 0o755);
    return { exitCode: 1, transcript: "boom", logPath: "/dev/null", timedOut: true };
  };
  registerEffectHandler("developer", (ctx) =>
    runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: failingSalvageSpawn, github: fakeGithub() })
  );
  startWorkflow(issueId);
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human");
  const action = listHumanActionsForIssue(issueId).find((a) => a.actionType === "policy_escalation");
  assert.ok(action);
  assert.match(action!.reason, /Auto-commit salvage failed|salvage-blocked/i);
  assert.match(action!.reason, /Recovery:/);
  assert.match(action!.reason, /git status/);

  const round1 = listWorkerSessionsForIssue(issueId).find((s) => s.role === "developer")!;
  const leftover = roleWorktreePath(repo, round1.id, "developer");
  assert.ok(fs.existsSync(path.join(leftover, "half-done.txt")), "failed salvage must not wipe WIP");

  // Cleanup hook so later tests in this file aren't poisoned.
  const common = git(repo, "rev-parse", "--git-common-dir");
  const hooks = path.isAbsolute(common) ? path.join(common, "hooks") : path.join(repo, common, "hooks");
  fs.rmSync(path.join(hooks, "pre-commit"), { force: true });
  fs.rmSync(leftover, { recursive: true, force: true });
  await withRepoLock(repo, async () => execFileSync("git", ["worktree", "prune"], { cwd: repo }));
});

test("timed_out (session): the spawn wall-clock timeout is reported distinctly from a crash", async () => {
  const issueId = await makeIssue();
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: timedOutSpawn, github: fakeGithub() }));
  startWorkflow(issueId);
  await pump(1);

  const dev = listWorkerSessionsForIssue(issueId).find((s) => s.role === "developer")!;
  assert.equal(dev.status, "timed_out");
});

test("NOT-147: empty tip + 2 session timeouts escalates to human — no third spawn", async () => {
  const issueId = await makeIssue();
  registerEffectHandler("developer", (ctx) =>
    runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: timedOutSpawn, github: fakeGithub() })
  );
  startWorkflow(issueId);

  await pump(1); // failure #1 → auto-retry
  assert.equal(getIssue(issueId)!.status, "developing");
  assert.equal(getIssue(issueId)!.infraAttempts, 1);
  assert.equal(
    listWorkItemsForIssue(issueId).filter((i) => i.kind === "developer" && i.status === "pending").length,
    1
  );

  await pump(1); // failure #2 with still-empty tip → policy_escalation
  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human");
  assert.equal(
    listWorkItemsForIssue(issueId).filter((i) => i.kind === "developer" && i.status === "pending").length,
    0,
    "must not enqueue a third hour-long spawn"
  );
  const { listHumanActionsForIssue } = await import("../repository/human-actions.js");
  const action = listHumanActionsForIssue(issueId).find((a) => a.status === "open");
  assert.ok(action);
  assert.equal(action!.actionType, "policy_escalation");
  assert.match(action!.reason, /stuck: no commits after 2 timeouts\/crashes/i);
});

test("checks_failed: CI failure after a clean push/PR retries without a human action", async () => {
  const issueId = await makeIssue();
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: commitingSpawn, github: fakeGithub({ checks: "failure" }) }));
  startWorkflow(issueId);
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "developing");
  assert.equal(listWorkItemsForIssue(issueId).filter((i) => i.kind === "reviewer").length, 0);
  const kinds = listArtifactsForIssue(issueId).map((a) => a.kind);
  const evidence = listArtifactsForIssue(issueId).find((a) => a.kind === "checks_evidence");
  assert.ok(evidence, "checks_failed still persists check evidence for the issue evidence API");
  assert.equal(JSON.parse(evidence!.contentJson!).snapshot, "failure");
  // A review round found these dropped whenever verification failed after a successful
  // session — they must survive a checks failure too, not just a clean handoff.
  assert.ok(kinds.includes("implementation_conclusion"), "conclusion must survive a post-session verification failure");
  assert.ok(kinds.includes("developer_transcript"), "raw trace must survive a post-session verification failure");
});

test("timed_out (checks poll): checks stay pending past the poll deadline", async () => {
  const issueId = await makeIssue();
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: commitingSpawn, github: fakeGithub({ checks: "pending" }) }));
  startWorkflow(issueId);
  await pump(1);

  assert.equal(getIssue(issueId)!.status, "developing");
});

test("adapter_failure: a non-draft PR is rejected rather than accepted as a clean handoff", async () => {
  const issueId = await makeIssue({ maxInfraAttempts: 0 });
  const github = fakeGithub();
  const realViewPr = github.viewPr.bind(github);
  github.viewPr = async (opts) => {
    const view = await realViewPr(opts);
    return view ? { ...view, isDraft: false } : view;
  };
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: commitingSpawn, github }));
  startWorkflow(issueId);
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human");
  assert.equal(issue.currentRound, 1, "a rejected PR identity never consumes a round");
  assert.equal(issue.prNumber, null, "a rejected identity must never be recorded as the verified handoff");
});

test("adapter_failure: a PR based against the wrong branch is rejected rather than accepted", async () => {
  const issueId = await makeIssue({ maxInfraAttempts: 0 });
  const github = fakeGithub();
  const realViewPr = github.viewPr.bind(github);
  github.viewPr = async (opts) => {
    const view = await realViewPr(opts);
    return view ? { ...view, baseRefName: "some-other-branch" } : view;
  };
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: commitingSpawn, github }));
  startWorkflow(issueId);
  await pump(1);

  assert.equal(getIssue(issueId)!.status, "needs_human");
});

test("clean handoff: a briefly stale headRefOid (gh's view lags the push) catches up within the reconcile window", async () => {
  // NOT-110: the first couple of `gh pr view` reads still show the pre-push head — exactly
  // the GraphQL-lag race observed in production — then GitHub catches up. This must be
  // reconciled by polling, not treated as a failed developer attempt.
  const issueId = await makeIssue();
  const github = fakeGithub();
  const realViewPr = github.viewPr.bind(github);
  let staleReadsLeft = 2;
  github.viewPr = async (opts) => {
    const view = await realViewPr(opts);
    if (view && staleReadsLeft > 0) {
      staleReadsLeft--;
      return { ...view, headRefOid: "0000000000000000000000000000000000dead" };
    }
    return view;
  };
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: commitingSpawn, github }));
  startWorkflow(issueId);
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "reviewing");
  assert.equal(staleReadsLeft, 0, "the reconcile loop must actually re-read gh pr view rather than giving up early");
});

test("adapter_failure: a headRefOid that never catches up is rejected after the bounded reconcile timeout", async () => {
  const issueId = await makeIssue({ maxInfraAttempts: 0 });
  const github = fakeGithub();
  const realViewPr = github.viewPr.bind(github);
  github.viewPr = async (opts) => {
    const view = await realViewPr(opts);
    return view ? { ...view, headRefOid: "0000000000000000000000000000000000dead" } : view;
  };
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: commitingSpawn, github }));
  startWorkflow(issueId);
  await pump(1);

  assert.equal(getIssue(issueId)!.status, "needs_human");
});

test("adapter_failure: the PR head changing while checks were being polled is rejected, not silently handed to the reviewer at the old SHA", async () => {
  // A review round found: validatePrIdentity only ran once, before a checks poll that can
  // run for up to checksPollTimeoutMs. If the branch moved during that wait (a concurrent
  // push, or a zombie retry from a reclaimed lease), the pre-poll prView was still reused
  // for the final clean_handoff — pinning the reviewer to a SHA that might no longer be
  // "current" per the exact-current-SHA contract. Simulates that race by pushing an extra
  // commit to the remote branch, from a second clone, right when polling first checks.
  const issueId = await makeIssue({ maxInfraAttempts: 0 });
  const branch = issueBranchName(issueId);
  const github = fakeGithub({ checks: "pending" });
  let racedYet = false;
  const realChecksSnapshot = github.checksSnapshot.bind(github);
  github.checksSnapshot = async (opts) => {
    if (!racedYet) {
      racedYet = true;
      const other = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-deveff-race-"));
      execFileSync("git", ["clone", "-q", remote, other]);
      git(other, "checkout", "-q", branch);
      git(other, "config", "user.email", "test@example.com");
      git(other, "config", "user.name", "Test");
      fs.writeFileSync(path.join(other, "race.txt"), "x");
      git(other, "add", ".");
      git(other, "-c", "user.email=race@test", "-c", "user.name=Race", "commit", "-q", "-m", "concurrent push");
      git(other, "push", "-q", "origin", branch);
      fs.rmSync(other, { recursive: true, force: true });
      return realChecksSnapshot(opts); // still "pending" — the poll continues
    }
    return "success"; // now resolves, but the head has moved underneath it
  };
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: commitingSpawn, github }));
  startWorkflow(issueId);
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human");
  assert.equal(issue.currentRound, 1, "a post-poll identity mismatch never consumes a round");
  assert.ok(listHumanActionsForIssue(issueId).find((a) => a.actionType === "policy_escalation"));
});

test("adapter_failure: gh pr create itself fails — never silently treated as a code-crash review round; escalates once infra attempts run out", async () => {
  // adapter_failure is bounded-retried on the infra budget like any other infra-class
  // failure (routing.test.ts covers the retry step in isolation); a real repeat here
  // would need a real, changing commit each attempt to avoid "nothing to commit" on a
  // reused worktree, so this end-to-end case pins maxInfraAttempts to 0 to exercise the
  // immediate-exhaustion edge of the same policy.
  const issueId = await makeIssue({ maxInfraAttempts: 0 });
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: commitingSpawn, github: fakeGithub({ createFails: true }) }));
  startWorkflow(issueId);
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human");
  assert.equal(issue.currentRound, 1, "adapter failure never consumes a review round");
  assert.ok(listHumanActionsForIssue(issueId).find((a) => a.actionType === "policy_escalation"));
});

test("publish-only retry: post-push gh create failure reopens the PR without respawning the agent", async () => {
  const issueId = await makeIssue();
  let createAttempt = 0;
  let spawnCalls = 0;
  const github = fakeGithub({ createFails: () => ++createAttempt === 1 });
  const countingSpawn: SpawnFn = async (input) => {
    spawnCalls++;
    return commitingSpawn(input);
  };
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: countingSpawn, github }));
  startWorkflow(issueId);
  await pump(4);

  const issue = getIssue(issueId)!;
  assert.equal(spawnCalls, 1, "publish-only retry must not spawn another agent session");
  assert.equal(createAttempt, 2, "gh create is retried once after the first failure");
  assert.equal(issue.status, "reviewing");
  assert.ok(issue.prNumber, "draft PR must exist after the publish-only retry");
  assert.equal(issue.currentRound, 1, "publish-only infra retry does not spend a review round");
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
  const remoteSha = git(other, "rev-parse", "HEAD");
  fs.rmSync(other, { recursive: true, force: true });

  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: commitingSpawn, github: fakeGithub() }));
  startWorkflow(issueId);
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human");
  assert.equal(issue.currentRound, 1, "a rejected push never consumes a round");
  const action = listHumanActionsForIssue(issueId).find((a) => a.actionType === "policy_escalation");
  assert.ok(action);
  // NOT-137: escalation must name shas / ahead-behind / recovery — not raw git pull hints.
  assert.match(action.reason, /diverged/i);
  assert.match(action.reason, new RegExp(remoteSha.slice(0, 12)));
  assert.match(action.reason, /force-with-lease/);
  assert.match(action.reason, new RegExp(remoteSha));
  assert.doesNotMatch(action.reason, /use 'git pull'/i);

  execFileSync("git", ["push", "-q", remote, `:${branch}`], { cwd: repo }).toString();
});

test("NOT-220: a repair round whose rebuild is patch-equivalent to the last pushed head recovers via the lease pin — no human action, auditable branch.pushed", async () => {
  const { runReviewerEffect } = await import("./reviewer-effect.js");
  const issueId = await makeIssue();
  const branch = issueBranchName(issueId);

  // Round 1 implements the widget for real; round 2 rebuilds the identical patch under
  // a different message (same diff, always a different SHA) plus follow-up work — the
  // diverged-but-proven-equivalent shape NOT-220 auto-recovers.
  let devCalls = 0;
  const rebuildSpawn: SpawnFn = async (input) => {
    devCalls++;
    if (devCalls === 1) return commitingSpawn(input);
    git(input.cwd, "reset", "--hard", "origin/main");
    fs.writeFileSync(path.join(input.cwd, "feature.txt"), "implemented\n");
    git(input.cwd, "add", ".");
    git(input.cwd, "-c", "user.email=agent@test", "-c", "user.name=Agent", "commit", "-q", "-m", "implement (rebuilt)");
    fs.writeFileSync(path.join(input.cwd, "feature2.txt"), "follow-up\n");
    git(input.cwd, "add", ".");
    git(input.cwd, "-c", "user.email=agent@test", "-c", "user.name=Agent", "commit", "-q", "-m", "follow-up work");
    return { exitCode: 0, transcript: "Implementation conclusion: rebuilt the widget and added follow-up work.", logPath: "/dev/null", timedOut: false };
  };

  // Round 1 requests changes; round 2 approves — reviewer transcripts must carry the
  // coordinator-verified SHAs from the prompt or the verdict is rejected.
  const shasFromPrompt = (prompt: string) => {
    const baseSha = prompt.match(/"baseSha" to exactly "([0-9a-f]+)"/)?.[1];
    const headSha = prompt.match(/"headSha" to exactly "([0-9a-f]+)"/)?.[1];
    if (!baseSha || !headSha) throw new Error("could not extract SHAs from reviewer prompt");
    return { baseSha, headSha };
  };
  let revCalls = 0;
  const reviewerSpawn = async (input: { prompt: string }) => {
    revCalls++;
    const { baseSha, headSha } = shasFromPrompt(input.prompt);
    const verdict = revCalls === 1 ? "changes_requested" : "approved";
    const body = {
      verdict,
      baseSha,
      headSha,
      acceptanceCriteriaAssessment: verdict === "approved" ? "Met." : "Not yet — missing coverage.",
      evidenceAssessment: "Evidence checked.",
      findings:
        verdict === "changes_requested"
          ? [{ fingerprint: "missing-test", severity: "blocking", title: "No test", rationale: "Add a test." }]
          : [],
      risks: [],
    };
    return { exitCode: 0, transcript: "```json\n" + JSON.stringify(body) + "\n```\n", logPath: "/dev/null", timedOut: false };
  };

  // One PR store shared by both handlers: the developer selects by branch, the
  // reviewer by PR number, and the head always comes from the bare remote.
  const prsByBranch = new Map<string, { number: number; url: string; base: string }>();
  const branchByNumber = new Map<number, string>();
  let nextNumber = 300;
  const remoteHead = (b: string) => git(remote, "rev-parse", b);
  const sharedGithub = (): GithubFn => ({
    async viewPr({ branch: b, number, cwd }) {
      const name = b ?? (number != null ? branchByNumber.get(number) : undefined) ?? (cwd ? git(cwd, "rev-parse", "--abbrev-ref", "HEAD") : undefined);
      if (!name) return null;
      const pr = prsByBranch.get(name);
      if (!pr) return null;
      if (number != null && number !== pr.number) return null;
      return { number: pr.number, url: pr.url, baseRefName: pr.base, headRefName: name, headRefOid: remoteHead(name), isDraft: true };
    },
    async createDraftPr({ base, head }) {
      if (!head) throw new Error("fakeGithub.createDraftPr requires an explicit --head");
      const number = nextNumber++;
      const url = `https://github.com/o/r/pull/${number}`;
      prsByBranch.set(head, { number, url, base });
      branchByNumber.set(number, head);
      return { ok: true, number, url };
    },
    async checksSnapshot() {
      return "success";
    },
    async publishReview({ event }) {
      return { ok: true, event, usedCommentFallback: false };
    },
  });
  const github = sharedGithub();

  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: rebuildSpawn, github }));
  registerEffectHandler("reviewer", (ctx) => runReviewerEffect(ctx, { deckCallTool: okDeckCallTool, spawn: reviewerSpawn as never, github: github as never }));
  startWorkflow(issueId);
  await pump(20);

  const issue = getIssue(issueId)!;
  assert.equal(devCalls, 2, "exactly two developer rounds must run");
  assert.equal(issue.status, "final_review", "the lease-recovered round must complete, not escalate");
  assert.equal(issue.currentRound, 2);
  assert.equal(
    listHumanActionsForIssue(issueId).filter((a) => a.actionType === "policy_escalation").length,
    0,
    "a proven-equivalent divergence must not create a human escalation"
  );

  // Audit: the round-2 branch.pushed carries the lease pin's old and new SHA.
  const pushedEvents = listWorkflowEventsForIssue(issueId).filter((e) => e.type === "branch.pushed");
  assert.equal(pushedEvents.length, 2, "both rounds push exactly once");
  const [first, second] = pushedEvents;
  assert.ok(!JSON.parse(first.payloadJson!).viaLeasePush, "round 1 is a plain push");
  const leasePayload = JSON.parse(second.payloadJson!);
  assert.equal(leasePayload.viaLeasePush, true);
  assert.ok(leasePayload.oldSha, "audit event must contain the old (pre-rewrite) SHA");
  assert.ok(leasePayload.newSha, "audit event must contain the new (published) SHA");
  assert.notEqual(leasePayload.oldSha, leasePayload.newSha);
  assert.equal(issue.headSha, leasePayload.newSha);
  assert.equal(git(remote, "rev-parse", branch), leasePayload.newSha, "the remote carries the rebuilt tip");

  // This is the only test in the file that registers a reviewer handler — restore the
  // placeholders so later tests keep the no-reviewer-handler assumption they were
  // written against (each re-registers its own developer handler).
  resetEffectHandlers();
});

test("NOT-88: a leftover clean worktree from a resolved unpushed_commit escalation is reused on Resume, not a worktree-add collision", async () => {
  const issueId = await makeIssue();
  const branch = issueBranchName(issueId);

  // Same setup as the unpushed_commit test above: pre-diverge the remote so round 1's own
  // push is rejected. This leaves a CLEAN worktree behind (the push happens after the
  // clean-check) at a path keyed by round 1's session id — exactly the leftover a plain
  // `git worktree add` for round 2's NEW session id would collide with (the reported bug).
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-deveff-reuse-other-"));
  execFileSync("git", ["clone", "-q", remote, other]);
  git(other, "checkout", "-q", "-b", branch);
  git(other, "config", "user.email", "test@example.com");
  git(other, "config", "user.name", "Test");
  fs.writeFileSync(path.join(other, "elsewhere.txt"), "y");
  git(other, "add", ".");
  git(other, "commit", "-q", "-m", "elsewhere");
  git(other, "push", "-q", "origin", branch);
  fs.rmSync(other, { recursive: true, force: true });

  // Round 1 commits the feature and gets its push rejected. Round 2 reuses that SAME
  // worktree — the commit is already there, so its spawn only needs to exit cleanly
  // (re-running commitingSpawn's identical write+commit against an unchanged file would
  // itself fail with "nothing to commit", which would test the fake, not the fix).
  let call = 0;
  const commitOnceThenNoop: SpawnFn = async (input) => (++call === 1 ? commitingSpawn(input) : noopSpawn(input));
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: commitOnceThenNoop, github: fakeGithub() }));
  startWorkflow(issueId);
  await pump(1);

  const issueAfterEscalation = getIssue(issueId)!;
  assert.equal(issueAfterEscalation.status, "needs_human");
  const round1Session = listWorkerSessionsForIssue(issueId).find((s) => s.role === "developer")!;
  const leftoverPath = roleWorktreePath(repo, round1Session.id, "developer");
  assert.ok(fs.existsSync(leftoverPath), "the clean worktree behind the rejected push must be preserved, not removed");

  const action = listHumanActionsForIssue(issueId).find((a) => a.actionType === "policy_escalation" && a.status === "open")!;
  assert.ok(action);

  // The human's actual fix for a diverged remote (out of scope for this ticket — see
  // git-worktree.ts's blockPush doc comment on force-push policy): here, just remove the
  // conflicting remote ref so round 2's push can fast-forward.
  execFileSync("git", ["push", "-q", remote, `:${branch}`], { cwd: repo }).toString();
  resolveHumanActionAndAdvance(action.id, "test", "resume");
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "reviewing", "round 2 must reuse the leftover worktree and complete the handoff, not crash on the collision");
  assert.equal(issue.currentRound, 1, "a policy_escalation resume is an infra reset, not a review round");
  assert.equal(issue.infraAttempts, 0, "resuming resets the infra budget");

  const devSessions = listWorkerSessionsForIssue(issueId).filter((s) => s.role === "developer");
  assert.equal(devSessions.length, 2);
  assert.equal(devSessions[1].status, "done");
  // Round 2 never created its OWN sessionId-keyed worktree — it reused round 1's leftover
  // path in place, which the clean_handoff path then removes as part of a normal wrap-up.
  assert.ok(!fs.existsSync(roleWorktreePath(repo, devSessions[1].id, "developer")));
  assert.ok(!fs.existsSync(leftoverPath), "the reused worktree is cleaned up after a successful handoff");
});

test("NOT-88: a leftover dirty worktree escalates as an actionable worktree_conflict on every Resume — no infra budget burned, no opaque crash loop", async () => {
  const issueId = await makeIssue();

  // Round 1 exits 0 but leaves the worktree dirty — dirty_worktree escalation preserves the
  // checkout (NOT-145 salvage applies only to timeout/crash infra deaths). That leftover is
  // the setup NOT-88's collision needs: round 2 must find that SAME dirty leftover still
  // holding the branch.
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: dirtySpawn, github: fakeGithub() }));
  startWorkflow(issueId);
  await pump(1);

  const round1Session = listWorkerSessionsForIssue(issueId).find((s) => s.role === "developer")!;
  const leftoverPath = roleWorktreePath(repo, round1Session.id, "developer");
  assert.ok(fs.existsSync(path.join(leftoverPath, "scratch.txt")), "the dirty leftover must be preserved");

  const firstAction = listHumanActionsForIssue(issueId).find((a) => a.actionType === "policy_escalation" && a.status === "open")!;
  assert.ok(firstAction);

  // Resume without actually cleaning the leftover: must re-detect the same conflict and
  // escalate again immediately — never spend an infra attempt on a retry that's certain to
  // collide identically, and never surface it as a generic/opaque adapter_failure.
  resolveHumanActionAndAdvance(firstAction.id, "test", "resume");
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human");
  assert.equal(issue.infraAttempts, 0, "a worktree_conflict never spends the infra-attempt budget it was reset to");
  assert.equal(issue.currentRound, 1);
  assert.ok(fs.existsSync(path.join(leftoverPath, "scratch.txt")), "still never force-removed");

  const secondAction = listHumanActionsForIssue(issueId).find(
    (a) => a.actionType === "policy_escalation" && a.status === "open" && a.id !== firstAction.id
  )!;
  assert.ok(secondAction, "a fresh, actionable escalation — not silence and not a crash");
  assert.match(secondAction.reason, /uncommitted changes/);
  assert.match(secondAction.reason, new RegExp(leftoverPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  fs.rmSync(leftoverPath, { recursive: true, force: true });
  await withRepoLock(repo, async () => execFileSync("git", ["worktree", "prune"], { cwd: repo }));
});

test("baseSha is resolved against the fetched base ref, not a stale local branch", async () => {
  // A review round found mergeBase used the local `main`, never fetched — if origin/main
  // had moved since this repo checkout last fetched, the recorded baseSha would be the
  // stale ancestor rather than the actual current base, and the reviewer would build the
  // wrong diff. Uses its own isolated repo/remote so advancing "main" here can't affect
  // any other test in this file that shares the module-level repo/remote fixture.
  const isoRepo = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-deveff-iso-repo-"));
  const isoRemote = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-deveff-iso-remote-"));
  try {
    git(isoRepo, "init", "-q", "-b", "main");
    git(isoRepo, "config", "user.email", "test@example.com");
    git(isoRepo, "config", "user.name", "Test");
    fs.writeFileSync(path.join(isoRepo, "README.md"), "hello\n");
    git(isoRepo, "add", ".");
    git(isoRepo, "commit", "-q", "-m", "init");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", isoRemote]);
    git(isoRepo, "remote", "add", "origin", isoRemote);
    git(isoRepo, "push", "-q", "origin", "main");

    // Advance origin/main from a separate clone — isoRepo's own local "main" is never
    // updated, so it stays stale relative to the remote exactly like the scenario found.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-deveff-iso-other-"));
    execFileSync("git", ["clone", "-q", isoRemote, other]);
    git(other, "config", "user.email", "test@example.com");
    git(other, "config", "user.name", "Test");
    fs.writeFileSync(path.join(other, "upstream-change.txt"), "z");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "upstream change");
    git(other, "push", "-q", "origin", "main");
    const currentOriginMainSha = git(other, "rev-parse", "HEAD");
    fs.rmSync(other, { recursive: true, force: true });
    assert.notEqual(git(isoRepo, "rev-parse", "main"), currentOriginMainSha, "isoRepo's local main must stay stale for this test to mean anything");

    const dev = createAgent({ name: `dev-iso-${Math.random()}`, runtime: "claude_code", deckId: "00000000-0000-4000-a000-000000000099"});
    const rev = createAgent({ name: `rev-iso-${Math.random()}`, runtime: "claude_code", deckId: "00000000-0000-4000-a000-000000000099"});
    const issueId = createIssue({
      title: "Iso base sha",
      acceptanceCriteria: "works",
      repo: isoRepo,
      baseBranch: "main",
      developerAgentId: dev.id,
      reviewerAgentId: rev.id,
      maxReviewRounds: 3,
      maxInfraAttempts: 3,
      source: "manual"}).id;

    const isoCommittingSpawn: SpawnFn = async (input) => {
      // Build the feature commit ON TOP of the advanced origin/main (B), not the stale
      // local main (A) the worktree was cut from — a review round found the original
      // version of this test built H directly off A, so merge-base(A, H) and
      // merge-base(B, H) were BOTH A and the test couldn't actually distinguish the
      // fetched-base fix from the pre-fix stale-local-base bug (mutation-tested: reverting
      // fetchRef still passed it). With H containing B as an ancestor, the two bases
      // genuinely differ, so this only stays green under the real fetch.
      git(input.cwd, "fetch", "-q", "origin", "main");
      git(input.cwd, "merge", "-q", "--ff-only", "origin/main");
      fs.writeFileSync(path.join(input.cwd, "feature.txt"), "implemented\n");
      git(input.cwd, "add", ".");
      git(input.cwd, "-c", "user.email=agent@test", "-c", "user.name=Agent", "commit", "-q", "-m", "implement");
      return { exitCode: 0, transcript: "conclusion", logPath: "/dev/null", timedOut: false };
    };
    const isoPrs = new Map<string, { number: number; url: string; base: string }>();
    const isoGithub: GithubFn = {
      async viewPr({ branch }) {
        if (!branch) throw new Error("isoGithub.viewPr requires an explicit branch — bare current-branch lookup is the NOT-82 bug");
        const pr = isoPrs.get(branch);
        if (!pr) return null;
        return { number: pr.number, url: pr.url, baseRefName: pr.base, headRefName: branch, headRefOid: git(isoRemote, "rev-parse", branch), isDraft: true };
      },
      async createDraftPr({ base, head }) {
        if (!head) throw new Error("isoGithub.createDraftPr requires an explicit --head — bare create is the NOT-82 bug");
        const number = 1;
        isoPrs.set(head, { number, url: `https://github.com/o/r/pull/${number}`, base });
        return { ok: true, number, url: `https://github.com/o/r/pull/${number}` };
      },
      async checksSnapshot({ number, branch }) {
        if (number == null && !branch) {
          throw new Error("isoGithub.checksSnapshot requires an explicit number or branch — bare checks lookup is the NOT-82 bug");
        }
        return "success";
      },
      async publishReview() {
        throw new Error("publishReview is unused by the developer effect");
      }};

    registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: isoCommittingSpawn, github: isoGithub }));
    startWorkflow(issueId);
    await pump(1);

    const issue = getIssue(issueId)!;
    assert.equal(issue.status, "reviewing");
    // H contains B (the advanced origin/main) as a direct ancestor, so its true base is B
    // itself — this is exactly what fetchRef existing to be tested: without it, mergeBase
    // would run against the stale local "main" (still at A) and return A instead.
    assert.equal(issue.baseSha, currentOriginMainSha, "baseSha must be the fetched origin/main tip");
    const staleLocalBase = git(isoRepo, "merge-base", "main", issue.headSha!);
    assert.notEqual(
      currentOriginMainSha,
      staleLocalBase,
      "sanity: the fetched and stale-local bases must actually differ, or this test can't tell them apart"
    );
  } finally {
    fs.rmSync(isoRepo, { recursive: true, force: true });
    fs.rmSync(isoRemote, { recursive: true, force: true });
  }
});

test("NOT-197: with a lagging local main, a new developer branch starts at the origin/main tip", async () => {
  // The NOT-197 incident: the cached clone's local main lagged origin/main, so branches
  // cut from it conflicted with already-merged work. Unlike the test above, the fake
  // agent does NOT merge origin/main itself — the branch must already start there.
  const isoRepo = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-deveff-197-repo-"));
  const isoRemote = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-deveff-197-remote-"));
  try {
    git(isoRepo, "init", "-q", "-b", "main");
    git(isoRepo, "config", "user.email", "test@example.com");
    git(isoRepo, "config", "user.name", "Test");
    fs.writeFileSync(path.join(isoRepo, "README.md"), "hello\n");
    git(isoRepo, "add", ".");
    git(isoRepo, "commit", "-q", "-m", "init");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", isoRemote]);
    git(isoRepo, "remote", "add", "origin", isoRemote);
    git(isoRepo, "push", "-q", "origin", "main");
    const staleLocalMain = git(isoRepo, "rev-parse", "main");

    const other = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-deveff-197-other-"));
    execFileSync("git", ["clone", "-q", isoRemote, other]);
    git(other, "config", "user.email", "test@example.com");
    git(other, "config", "user.name", "Test");
    fs.writeFileSync(path.join(other, "upstream-change.txt"), "z");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "upstream change");
    git(other, "push", "-q", "origin", "main");
    const originTip = git(other, "rev-parse", "HEAD");
    fs.rmSync(other, { recursive: true, force: true });
    assert.notEqual(staleLocalMain, originTip, "the local main must lag origin/main for this test to mean anything");

    const dev = createAgent({ name: `dev-197-${Math.random()}`, runtime: "claude_code", deckId: "00000000-0000-4000-a000-000000000099"});
    const rev = createAgent({ name: `rev-197-${Math.random()}`, runtime: "claude_code", deckId: "00000000-0000-4000-a000-000000000099"});
    const issueId = createIssue({
      title: "Fresh base",
      acceptanceCriteria: "works",
      repo: isoRepo,
      baseBranch: "main",
      developerAgentId: dev.id,
      reviewerAgentId: rev.id,
      maxReviewRounds: 3,
      maxInfraAttempts: 3,
      source: "manual"}).id;

    const isoPrs = new Map<string, { number: number; url: string; base: string }>();
    const isoGithub: GithubFn = {
      async viewPr({ branch }) {
        if (!branch) throw new Error("isoGithub.viewPr requires an explicit branch — bare current-branch lookup is the NOT-82 bug");
        const pr = isoPrs.get(branch);
        if (!pr) return null;
        return { number: pr.number, url: pr.url, baseRefName: pr.base, headRefName: branch, headRefOid: git(isoRemote, "rev-parse", branch), isDraft: true };
      },
      async createDraftPr({ base, head }) {
        if (!head) throw new Error("isoGithub.createDraftPr requires an explicit --head — bare create is the NOT-82 bug");
        isoPrs.set(head, { number: 1, url: "https://github.com/o/r/pull/1", base });
        return { ok: true, number: 1, url: "https://github.com/o/r/pull/1" };
      },
      async checksSnapshot() {
        return "success";
      },
      async publishReview() {
        throw new Error("publishReview is unused by the developer effect");
      }};

    registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: commitingSpawn, github: isoGithub }));
    startWorkflow(issueId);
    await pump(1);

    const issue = getIssue(issueId)!;
    assert.equal(issue.status, "reviewing");
    const branch = `issue-${issueId}`;
    assert.equal(issue.branch, branch);
    assert.equal(
      git(isoRepo, "rev-parse", `${branch}^`),
      originTip,
      "the new branch must be cut from the origin/main tip, not the stale local main"
    );
    assert.equal(issue.baseSha, originTip, "base_sha must equal the fetched origin/main tip");
    assert.equal(git(isoRepo, "rev-parse", "main"), staleLocalMain, "sanity: the local main is still stale — the fix fetches, it does not move local branches");
  } finally {
    fs.rmSync(isoRepo, { recursive: true, force: true });
    fs.rmSync(isoRemote, { recursive: true, force: true });
  }
});

test("NOT-197: a failed pre-branch fetch defers the start without a branch, a spawn, or an attempt", async () => {
  // origin points at nothing fetchable: the effect must defer (worker.deferred, item
  // pending, budgets untouched) instead of cutting the branch from the stale local base.
  const isoRepo = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-deveff-197fail-repo-"));
  const isoRemote = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-deveff-197fail-remote-"));
  try {
    git(isoRepo, "init", "-q", "-b", "main");
    git(isoRepo, "config", "user.email", "test@example.com");
    git(isoRepo, "config", "user.name", "Test");
    fs.writeFileSync(path.join(isoRepo, "README.md"), "hello\n");
    git(isoRepo, "add", ".");
    git(isoRepo, "commit", "-q", "-m", "init");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", isoRemote]);
    git(isoRepo, "remote", "add", "origin", isoRemote);
    git(isoRepo, "push", "-q", "origin", "main");
    git(isoRepo, "remote", "set-url", "origin", path.join(isoRemote, "does-not-exist.git"));

    const dev = createAgent({ name: `dev-197f-${Math.random()}`, runtime: "claude_code", deckId: "00000000-0000-4000-a000-000000000099"});
    const rev = createAgent({ name: `rev-197f-${Math.random()}`, runtime: "claude_code", deckId: "00000000-0000-4000-a000-000000000099"});
    const issueId = createIssue({
      title: "Fetch fails",
      acceptanceCriteria: "works",
      repo: isoRepo,
      baseBranch: "main",
      developerAgentId: dev.id,
      reviewerAgentId: rev.id,
      maxReviewRounds: 3,
      maxInfraAttempts: 3,
      source: "manual"}).id;

    let spawnCalled = false;
    const spySpawn: SpawnFn = async () => {
      spawnCalled = true;
      return { exitCode: 0, transcript: "", logPath: "/dev/null", timedOut: false };
    };
    registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: spySpawn, github: fakeGithub() }));
    startWorkflow(issueId);
    await pump(1);

    assert.equal(spawnCalled, false, "nothing may spawn when the base could not be fetched");
    assert.equal(await branchExists(isoRepo, `issue-${issueId}`), false, "no branch may be created from a base that was never confirmed");
    const issue = getIssue(issueId)!;
    assert.equal(issue.branch, null);
    assert.equal(issue.baseSha, null);
    assert.equal(issue.infraAttempts, 0, "a deferred start spends no infra attempt");
    assert.equal(issue.currentRound, 1);
    assert.notEqual(issue.status, "needs_human");
    assert.match(issue.currentIntent ?? "", /Waiting for network/);

    const { listWorkItemsForIssue } = await import("../repository/work-items.js");
    const items = listWorkItemsForIssue(issueId);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.status, "pending", "the item waits, it is not finished or dead-lettered");
    assert.equal(items[0]!.attemptCount, 0, "the claim-time attempt bump is reverted");
    assert.ok(
      Date.parse(items[0]!.availableAt) > Date.parse(items[0]!.updatedAt),
      "the next start is gated behind a wait"
    );

    assert.equal(listHumanActionsForIssue(issueId).filter((a) => a.status === "open").length, 0);
    const events = listWorkflowEventsForIssue(issueId);
    const deferrals = events.filter((e) => e.type === "worker.deferred");
    assert.ok(deferrals.length > 0);
    const payload = JSON.parse(deferrals[0]!.payloadJson ?? "{}");
    assert.equal(payload.outcome, "base_fetch_failed");
    assert.equal(events.some((e) => e.type === "worker.failed"), false, "a deferred start is not a failure");

    const { listWorkerSessionsForIssue } = await import("../repository/worker-sessions.js");
    assert.equal(listWorkerSessionsForIssue(issueId).every((s) => s.status === "cancelled"), true);
  } finally {
    fs.rmSync(isoRepo, { recursive: true, force: true });
    fs.rmSync(isoRemote, { recursive: true, force: true });
  }
});

test("NOT-83 review: an item cancelled during worktree/deck-bind setup (before spawn) is never spawned", async () => {
  const { buildProfileSnapshot, serializeProfileSnapshot } = await import("./profile-snapshot.js");
  const issueId = await makeIssue();
  startWorkflow(issueId);

  // Replicates worker-loop.ts's own session setup (claim → create session → bind → start)
  // instead of going through the real pump loop — this makes the "cancelled sometime after
  // the session was marked running, but before this handler reaches spawn" window
  // deterministic instead of racing real git subprocess timing.
  const claimed = claimWorkItem(`test-${issueId}`, { leaseMs: 60_000 })!;
  const agent = getIssue(issueId)!.developerAgentId
    ? (await import("../repository/agents.js")).getAgent(getIssue(issueId)!.developerAgentId!)!
    : null;
  const session = createWorkerSession({
    issueId,
    role: "developer",
    round: claimed.round,
    agentId: agent?.id ?? null,
    runtime: "claude_code",
    profileSnapshotJson: agent
      ? serializeProfileSnapshot(buildProfileSnapshot(agent, "developer"))
      : undefined,
  });
  assert.ok(bindWorkItemSession(claimed.id, session.id, claimed.leaseToken!));
  startSession(session.id);

  // Simulates an abort landing while this handler is still inside worktree/deck-bind setup
  // (developer-effect.ts's guard runs after that, right before spawn) — cancelWorkItem is
  // exactly what abortIssue (commands.ts) calls in that scenario.
  assert.ok(cancelWorkItem(claimed.id));

  let spawnCalled = false;
  const spySpawn: SpawnFn = async (input) => {
    spawnCalled = true;
    return commitingSpawn(input);
  };

  const outcome = await runDeveloperEffect(
    {
      workItem: { ...claimed, workerSessionId: session.id },
      issue: getIssue(issueId)!,
      instance: getActiveWorkflowInstance(issueId)!,
      signal: new AbortController().signal,
    },
    { deckCallTool: okDeckCallTool, spawn: spySpawn, github: fakeGithub() }
  );

  assert.equal(spawnCalled, false, "a cancelled item must never reach the real spawn");
  assert.deepEqual(outcome, { kind: "session_failed" });
});

test("cursor_local + deckId: prepares worker deck connection and passes mcpConfigPath to spawn", async () => {
  const { randomUUID } = await import("node:crypto");
  const { buildProfileSnapshot } = await import("./profile-snapshot.js");

  const deckId = randomUUID();
  const dev = createAgent({
    name: `cursor-dev-${Math.random()}`,
    runtime: "cursor_local",
    deckId,
  });
  const rev = createAgent({ name: `rev-${Math.random()}`, runtime: "claude_code", deckId: "00000000-0000-4000-a000-000000000099" });
  const issueId = createIssue({
    title: "Cursor deck launch",
    description: "Use launch-fixed deck MCP.",
    acceptanceCriteria: "mcpConfigPath set.",
    repo,
    baseBranch: "main",
    developerAgentId: dev.id,
    reviewerAgentId: rev.id,
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual"}).id;

  startWorkflow(issueId);
  const claimed = claimWorkItem(`test-cursor-deck-${issueId}`, { leaseMs: 60_000 })!;
  const snapshot = buildProfileSnapshot(dev, "developer");
  const session = createWorkerSession({
    issueId,
    role: "developer",
    round: claimed.round,
    agentId: dev.id,
    runtime: "cursor_local",
    profileSnapshotJson: JSON.stringify(snapshot)});
  assert.ok(bindWorkItemSession(claimed.id, session.id, claimed.leaseToken!));
  startSession(session.id);

  let spawnSawMcpConfig: string | undefined;
  const deckCalls: string[] = [];
  const spySpawn: SpawnFn = async (input) => {
    spawnSawMcpConfig = input.mcpConfigPath;
    return commitingSpawn(input);
  };

  const outcome = await runDeveloperEffect(
    {
      workItem: { ...claimed, workerSessionId: session.id },
      issue: getIssue(issueId)!,
      instance: getActiveWorkflowInstance(issueId)!,
      signal: new AbortController().signal},
    {
      spawn: spySpawn,
      github: fakeGithub(),
      deckCallTool: async (name, args) => {
        deckCalls.push(name);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                name === "get_bound_deck"
                  ? { id: deckId, name: "dev" }
                  : { id: args.playbook_id }
              )},
          ]};
      }}
  );

  assert.ok(spawnSawMcpConfig, "cursor_local + deckId must materialize a worktree mcp.json");
  assert.match(spawnSawMcpConfig!, /\.cursor\/mcp\.json$/);
  assert.deepEqual(deckCalls, ["get_bound_deck"]);
  assert.equal(outcome.kind, "clean_handoff");
});

test("NOT-117: mid-success usage cap continues publish instead of deferring the tip", async () => {
  const { fileURLToPath } = await import("node:url");
  const { clearAllRuntimeAvailability, runtimeAvailability } = await import(
    "../repository/runtime-availability.js"
  );
  clearAllRuntimeAvailability();

  const issueId = await makeIssue();
  const capLog = path.join(process.env.AGENT_DEALER_HOME!, `not117-mid-success-${issueId}.ndjson`);
  const fixture = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../runners/fixtures/claude-rate-limit-rejected.ndjson"
  );
  fs.copyFileSync(fixture, capLog);

  const midSuccessCapSpawn: SpawnFn = async (input) => {
    await commitingSpawn(input);
    return {
      exitCode: 0,
      transcript: "Implementation conclusion: added the widget.",
      logPath: capLog,
      timedOut: false};
  };

  registerEffectHandler("developer", (ctx) =>
    runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: midSuccessCapSpawn, github: fakeGithub() })
  );
  startWorkflow(issueId);
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "reviewing", "successful tip must continue to publish/PR, not defer");
  assert.ok(issue.branch);
  assert.ok(issue.prNumber);

  const items = listWorkItemsForIssue(issueId);
  assert.equal(items.filter((i) => i.status === "pending" && i.kind === "developer").length, 0);
  assert.equal(runtimeAvailability("claude_code").available, false, "cap is still recorded for future spawns");
  clearAllRuntimeAvailability();
});

test("NOT-117: usage_capped after commits resumes with retryReason — no fresh-branch rebuild, tip preserved", async () => {
  const { fileURLToPath } = await import("node:url");
  const { clearAllRuntimeAvailability } = await import("../repository/runtime-availability.js");
  clearAllRuntimeAvailability();

  const issueId = await makeIssue();
  const branch = issueBranchName(issueId);
  const capLog = path.join(process.env.AGENT_DEALER_HOME!, `not117-resume-${issueId}.ndjson`);
  const fixture = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../runners/fixtures/claude-rate-limit-rejected.ndjson"
  );
  fs.copyFileSync(fixture, capLog);

  let call = 0;
  const prompts: string[] = [];
  let tipAfterFirst = "";
  const commitThenCapCrash: SpawnFn = async (input) => {
    call++;
    prompts.push(input.prompt);
    if (call === 1) {
      await commitingSpawn(input);
      tipAfterFirst = git(input.cwd, "rev-parse", "HEAD");
      return { exitCode: 1, transcript: "boom after commit", logPath: capLog, timedOut: false };
    }
    // Resume: do not add a second tip — prove we reused the prior branch.
    assert.equal(git(input.cwd, "rev-parse", "HEAD"), tipAfterFirst);
    return { exitCode: 0, transcript: "continue", logPath: "/dev/null", timedOut: false };
  };

  registerEffectHandler("developer", (ctx) =>
    runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: commitThenCapCrash, github: fakeGithub() })
  );
  startWorkflow(issueId);
  await pump(1);

  const deferred = listWorkItemsForIssue(issueId)[0]!;
  assert.equal(deferred.status, "pending");
  assert.ok(Date.parse(deferred.availableAt) > Date.now());
  const payload = JSON.parse(deferred.payloadJson!) as { retryReason?: string };
  assert.match(payload.retryReason ?? "", /usage cap after local commits/i);
  assert.equal(await branchExists(repo, branch), true);
  assert.equal(git(repo, "rev-parse", branch), tipAfterFirst);

  clearAllRuntimeAvailability();
  getDb()
    .prepare(`UPDATE work_items SET available_at = ? WHERE id = ?`)
    .run(new Date(0).toISOString(), deferred.id);

  await pump(1);

  assert.equal(call, 2);
  assert.doesNotMatch(prompts[1]!, /fresh branch/);
  assert.match(prompts[1]!, /do not re-implement from scratch/i);
  assert.equal(git(repo, "rev-parse", branch), tipAfterFirst, "resume must not mint a parallel tip");
  clearAllRuntimeAvailability();
});

function writeVerificationLog(opts: { command: string; output: string; isError?: boolean }): string {
  const logPath = path.join(
    process.env.AGENT_DEALER_HOME!,
    `not130-receipt-${Math.random().toString(16).slice(2)}.ndjson`
  );
  const lines = [
    {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "t1", name: "Bash", input: { command: opts.command } },
        ]}},
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            is_error: opts.isError ?? false,
            content: opts.output},
        ]}},
  ];
  fs.writeFileSync(logPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return logPath;
}

test("NOT-130: interrupted-but-verified attempt persists receipt and retry prompt carries it at unchanged HEAD", async () => {
  const issueId = await makeIssue();
  const branch = issueBranchName(issueId);
  const logPath = writeVerificationLog({
    command: "npm run test:unit",
    output: "711/711 tests passed\n"});

  let call = 0;
  const prompts: string[] = [];
  let tipAfterFirst = "";
  const commitVerifyThenCrash: SpawnFn = async (input) => {
    call++;
    prompts.push(input.prompt);
    if (call === 1) {
      await commitingSpawn(input);
      tipAfterFirst = git(input.cwd, "rev-parse", "HEAD");
      return { exitCode: 1, transcript: "boom after green suite", logPath, timedOut: false };
    }
    assert.equal(git(input.cwd, "rev-parse", "HEAD"), tipAfterFirst);
    return { exitCode: 0, transcript: "continue without re-suite", logPath: "/dev/null", timedOut: false };
  };

  registerEffectHandler("developer", (ctx) =>
    runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: commitVerifyThenCrash, github: fakeGithub() })
  );
  startWorkflow(issueId);
  await pump(1);

  const receipt = listArtifactsForIssue(issueId).find((a) => a.kind === "verification_receipt");
  assert.ok(receipt, "verification receipt must be persisted even when the session crashes");
  const content = JSON.parse(receipt!.contentJson!) as { headSha: string; commands: Array<{ command: string }> };
  assert.equal(content.headSha, tipAfterFirst);
  assert.match(content.commands[0]!.command, /npm run test:unit/);

  assert.equal(getIssue(issueId)!.status, "developing");
  await pump(1);

  assert.equal(call, 2);
  assert.match(prompts[1]!, /### Prior verification receipt/);
  assert.match(prompts[1]!, /npm run test:unit.*passed \(711\/711\)/);
  assert.match(prompts[1]!, /Do not re-run an unchanged green suite by default/);
  assert.equal(git(repo, "rev-parse", branch), tipAfterFirst);
});

test("NOT-130: receipt is dropped from the retry prompt when HEAD moved after it was recorded", async () => {
  const issueId = await makeIssue();
  const logPath = writeVerificationLog({
    command: "npm run test:unit",
    output: "711/711 tests passed\n"});

  let call = 0;
  const prompts: string[] = [];
  const verifyCrashThenMoveHead: SpawnFn = async (input) => {
    call++;
    prompts.push(input.prompt);
    if (call === 1) {
      await commitingSpawn(input);
      return { exitCode: 1, transcript: "boom", logPath, timedOut: false };
    }
    // New commit on the reused branch — tip no longer matches the receipt SHA.
    fs.writeFileSync(path.join(input.cwd, "moved.txt"), "moved\n");
    git(input.cwd, "add", ".");
    git(input.cwd, "-c", "user.email=agent@test", "-c", "user.name=Agent", "commit", "-q", "-m", "move head");
    return { exitCode: 0, transcript: "new tip", logPath: "/dev/null", timedOut: false };
  };

  registerEffectHandler("developer", (ctx) =>
    runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: verifyCrashThenMoveHead, github: fakeGithub() })
  );
  startWorkflow(issueId);
  await pump(1);
  assert.ok(listArtifactsForIssue(issueId).some((a) => a.kind === "verification_receipt"));

  // Mutate the branch tip *before* the retry session starts so the prompt SHA gate fails.
  const branch = issueBranchName(issueId);
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not130-move-"));
  try {
    git(repo, "worktree", "add", wt, branch);
    fs.writeFileSync(path.join(wt, "pre-retry.txt"), "x\n");
    git(wt, "add", ".");
    git(wt, "-c", "user.email=agent@test", "-c", "user.name=Agent", "commit", "-q", "-m", "pre-retry move");
  } finally {
    try {
      git(repo, "worktree", "remove", "--force", wt);
    } catch {
      fs.rmSync(wt, { recursive: true, force: true });
    }
  }

  await pump(1);
  assert.equal(call, 2);
  assert.doesNotMatch(prompts[1]!, /Prior verification receipt/);
});

test("NOT-219: a repair round after a side-branch round 1 starts at the pushed tip and pushes fast-forward", async () => {
  // The NOT-171 incident end to end: round 1's worker commits on a side branch, so the
  // clone's local issue branch never advances — Dealer pushes HEAD to origin/<branch>.
  // A repair round must then start at that pushed tip (not the stale base) so its own
  // push is a fast-forward instead of a false-diverged `unpushed_commit` escalation.
  const issueId = await makeIssue();
  const branch = issueBranchName(issueId);
  const base = git(repo, "rev-parse", "main");

  const sideBranchSpawn: SpawnFn = async (input) => {
    git(input.cwd, "checkout", "-qb", "feat/side-work");
    fs.writeFileSync(path.join(input.cwd, "feature.txt"), "implemented\n");
    git(input.cwd, "add", ".");
    git(input.cwd, "-c", "user.email=agent@test", "-c", "user.name=Agent", "commit", "-q", "-m", "implement");
    return { exitCode: 0, transcript: "Implementation conclusion: added the widget.", logPath: "/dev/null", timedOut: false };
  };

  let checksPass = false;
  const github = fakeGithub();
  github.checksSnapshot = async () => (checksPass ? "success" : "failure");

  let spawnCalls = 0;
  let repairStartHead = "";
  let repairStartBranch = "";
  let repairStartRemoteAhead = -1;
  const alternatingSpawn: SpawnFn = async (input) => {
    spawnCalls++;
    if (spawnCalls === 1) return sideBranchSpawn(input);
    // Repair round: observe the start BEFORE committing anything.
    repairStartHead = git(input.cwd, "rev-parse", "HEAD");
    repairStartBranch = git(input.cwd, "rev-parse", "--abbrev-ref", "HEAD");
    repairStartRemoteAhead = Number(git(input.cwd, "rev-list", "--count", `origin/${branch}..HEAD`));
    // One new commit on top, on the checked-out issue branch like a normal worker.
    fs.writeFileSync(path.join(input.cwd, "repair.txt"), "repair\n");
    git(input.cwd, "add", ".");
    git(input.cwd, "-c", "user.email=agent@test", "-c", "user.name=Agent", "commit", "-q", "-m", "repair");
    return { exitCode: 0, transcript: "Implementation conclusion: repaired.", logPath: "/dev/null", timedOut: false };
  };

  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: alternatingSpawn, github }));
  startWorkflow(issueId);
  await pump(1); // round 1: the push lands, checks fail → infra retry queued

  assert.equal(getIssue(issueId)!.status, "developing");
  const pushedX = git(remote, "rev-parse", branch);
  assert.notEqual(pushedX, base, "round 1 must have published a tip beyond base");
  assert.equal(
    git(repo, "rev-parse", branch),
    pushedX,
    "the post-push fast-forward keeps the clone's local ref at the pushed SHA even though the worker committed on a side branch"
  );

  // Re-create the pre-fix staleness: the local ref falls back to base while the remote
  // still holds exactly what round 1 pushed.
  git(repo, "branch", "-f", branch, base);
  assert.equal(git(repo, "rev-parse", branch), base);

  checksPass = true;
  await pump(1); // repair round

  assert.equal(spawnCalls, 2);
  assert.equal(repairStartBranch, branch);
  assert.equal(repairStartHead, pushedX, "the repair worktree must start at the pushed tip, not the stale base");
  assert.equal(repairStartRemoteAhead, 0, "git rev-list --count origin/<branch>..HEAD must be 0 at repair start");

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "reviewing", "the repair push must fast-forward, never escalate as unpushed_commit");
  assert.equal(listHumanActionsForIssue(issueId).filter((a) => a.status === "open").length, 0);
  const repairHead = git(remote, "rev-parse", branch);
  assert.notEqual(repairHead, pushedX, "the repair round must have published its own commit");
  assert.equal(issue.headSha, repairHead);
  assert.equal(git(repo, "rev-parse", branch), repairHead);
  assert.equal(git(repo, "merge-base", pushedX, repairHead), pushedX, "the repair tip builds on the round-1 tip");
});

test("NOT-219: a repair round whose origin/<branch> fetch fails defers without spawning or spending an attempt", async () => {
  // Like NOT-197's pre-branch deferral, but on the reuse path: the branch already exists
  // locally (round 1 pushed it), then the network breaks — the repair start must defer
  // as base_fetch_failed instead of starting from the stale local ref.
  const isoRepo = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-deveff-219fail-repo-"));
  const isoRemote = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-deveff-219fail-remote-"));
  try {
    git(isoRepo, "init", "-q", "-b", "main");
    git(isoRepo, "config", "user.email", "test@example.com");
    git(isoRepo, "config", "user.name", "Test");
    fs.writeFileSync(path.join(isoRepo, "README.md"), "hello\n");
    git(isoRepo, "add", ".");
    git(isoRepo, "commit", "-q", "-m", "init");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", isoRemote]);
    git(isoRepo, "remote", "add", "origin", isoRemote);
    git(isoRepo, "push", "-q", "origin", "main");

    const dev = createAgent({ name: `dev-219f-${Math.random()}`, runtime: "claude_code", deckId: "00000000-0000-4000-a000-000000000099"});
    const rev = createAgent({ name: `rev-219f-${Math.random()}`, runtime: "claude_code", deckId: "00000000-0000-4000-a000-000000000099"});
    const issueId = createIssue({
      title: "Repair fetch fails",
      acceptanceCriteria: "works",
      repo: isoRepo,
      baseBranch: "main",
      developerAgentId: dev.id,
      reviewerAgentId: rev.id,
      maxReviewRounds: 3,
      maxInfraAttempts: 3,
      source: "manual"}).id;
    const branch = issueBranchName(issueId);

    let checksPass = false;
    const github = fakeGithub();
    github.checksSnapshot = async () => (checksPass ? "success" : "failure");
    let spawnCalls = 0;
    const countingSpawn: SpawnFn = async (input) => {
      spawnCalls++;
      return commitingSpawn(input);
    };
    registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: countingSpawn, github }));
    startWorkflow(issueId);
    await pump(1); // round 1: pushed, checks fail → repair retry queued

    assert.equal(spawnCalls, 1);
    assert.equal(getIssue(issueId)!.status, "developing");
    assert.equal(await branchExists(isoRepo, branch), true, "round 1 must have left the local branch behind");
    assert.ok(git(isoRepo, "ls-remote", "origin", `refs/heads/${branch}`).length > 0, "round 1 must have pushed the branch");
    const infraAfterRound1 = getIssue(issueId)!.infraAttempts;

    // Break the network only now, so round 1 proves the setup while the repair starves.
    git(isoRepo, "remote", "set-url", "origin", path.join(isoRemote, "does-not-exist.git"));
    await pump(1); // repair start: the origin/<branch> fetch fails → defer

    assert.equal(spawnCalls, 1, "nothing may spawn when the repair branch could not be fetched");
    const issue = getIssue(issueId)!;
    assert.equal(issue.infraAttempts, infraAfterRound1, "a deferred start spends no infra attempt");
    assert.equal(issue.currentRound, 1);
    assert.notEqual(issue.status, "needs_human");
    assert.match(issue.currentIntent ?? "", /Waiting for network/);

    const { listWorkItemsForIssue: listItems } = await import("../repository/work-items.js");
    const items = listItems(issueId);
    assert.equal(items.filter((i) => i.kind === "developer" && i.status === "pending").length, 1);
    const pending = items.find((i) => i.kind === "developer" && i.status === "pending")!;
    assert.equal(pending.attemptCount, 0, "the claim-time attempt bump is reverted");
    assert.ok(Date.parse(pending.availableAt) > Date.parse(pending.updatedAt), "the next start is gated behind a wait");

    const events = listWorkflowEventsForIssue(issueId);
    const deferrals = events.filter((e) => e.type === "worker.deferred");
    assert.ok(deferrals.length > 0);
    assert.equal(JSON.parse(deferrals[deferrals.length - 1]!.payloadJson ?? "{}").outcome, "base_fetch_failed");

    const { listWorkerSessionsForIssue: listSessions } = await import("../repository/worker-sessions.js");
    const sessions = listSessions(issueId).filter((s) => s.role === "developer");
    assert.equal(sessions.length, 2, "round 1 ran; the repair attempt never spawned");
    assert.equal(sessions[sessions.length - 1]!.status, "cancelled", "the unfired repair session is cancelled, not failed");
  } finally {
    fs.rmSync(isoRepo, { recursive: true, force: true });
    fs.rmSync(isoRemote, { recursive: true, force: true });
  }
});

test("NOT-130: a green suite on a dirty worktree is not persisted as tip evidence", async () => {
  const issueId = await makeIssue();
  const logPath = writeVerificationLog({
    command: "npm run test:unit",
    output: "711/711 tests passed\n"});

  const dirtyAfterVerify: SpawnFn = async (input) => {
    await commitingSpawn(input);
    fs.writeFileSync(path.join(input.cwd, "scratch.txt"), "uncommitted\n");
    return { exitCode: 0, transcript: "dirty after suite", logPath, timedOut: false };
  };

  registerEffectHandler("developer", (ctx) =>
    runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: dirtyAfterVerify, github: fakeGithub() })
  );
  startWorkflow(issueId);
  await pump(1);

  assert.equal(
    listArtifactsForIssue(issueId).some((a) => a.kind === "verification_receipt"),
    false,
    "dirty tree must not mint a tip-scoped verification receipt"
  );
  assert.equal(getIssue(issueId)!.status, "needs_human");
});

test("NOT-130: checks_failed retry does not carry a prior green receipt into the prompt", async () => {
  const issueId = await makeIssue();
  const logPath = writeVerificationLog({
    command: "npm run test:unit",
    output: "711/711 tests passed\n"});

  let call = 0;
  const prompts: string[] = [];
  const commitVerifyThenCiFail: SpawnFn = async (input) => {
    call++;
    prompts.push(input.prompt);
    if (call === 1) {
      await commitingSpawn(input);
      return { exitCode: 0, transcript: "green locally", logPath, timedOut: false };
    }
    if (call === 2) {
      // Same tip — crash after CI already rejected it; must still not re-carry the receipt.
      return { exitCode: 1, transcript: "boom while reproducing CI", logPath: "/dev/null", timedOut: false };
    }
    return { exitCode: 0, transcript: "reproducing CI", logPath: "/dev/null", timedOut: false };
  };

  const github = fakeGithub({ checks: "failure" });
  let checkPass = false;
  github.checksSnapshot = async () => (checkPass ? "success" : "failure");

  registerEffectHandler("developer", (ctx) =>
    runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: commitVerifyThenCiFail, github })
  );
  startWorkflow(issueId);
  await pump(1);

  assert.ok(
    listArtifactsForIssue(issueId).some((a) => a.kind === "verification_receipt"),
    "receipt is still persisted from the green local suite"
  );
  assert.ok(listArtifactsForIssue(issueId).some((a) => a.kind === "checks_evidence"));
  assert.equal(getIssue(issueId)!.status, "developing");

  await pump(1);
  assert.equal(call, 2);
  assert.match(prompts[1]!, /Developer's PR checks failed/);
  assert.doesNotMatch(
    prompts[1]!,
    /Prior verification receipt/,
    "checks_failed must not tell the agent the suite at this SHA is already green"
  );

  // Later infra retry at the same tip uses session_failed prose — still no receipt.
  checkPass = true;
  await pump(1);
  assert.equal(call, 3);
  assert.match(prompts[2]!, /failed or crashed|timed out|session/i);
  assert.doesNotMatch(
    prompts[2]!,
    /Prior verification receipt/,
    "CI-rejected tip must not re-authorize skip-suite on a later crash retry"
  );
});
