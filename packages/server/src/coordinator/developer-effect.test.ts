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
const { branchExists } = await import("../adapters/git-worktree.js");
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

async function makeIssue(opts: { maxInfraAttempts?: number } = {}): Promise<string> {
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
    maxInfraAttempts: opts.maxInfraAttempts ?? 3,
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
  // GitHub's view of a PR's head is the REMOTE branch tip, not the local worktree's
  // checkout — reading it from `remote` (rather than `cwd`) lets a test simulate a
  // concurrent push changing the head independently of this worktree.
  const remoteHead = (branch: string) => git(remote, "rev-parse", branch);
  const adapter: GithubFn = {
    async viewPr({ cwd }) {
      const branch = currentBranch(cwd);
      const pr = prs.get(branch);
      if (!pr) return null;
      return { number: pr.number, url: pr.url, baseRefName: pr.base, headRefName: branch, headRefOid: remoteHead(branch), isDraft: true };
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
    async publishReview() {
      throw new Error("publishReview is unused by the developer effect");
    },
  };
  return adapter;
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
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { spawn: flakyThenCommittingSpawn, github: fakeGithub() }));
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
  assert.doesNotMatch(prompts[0], /previous attempt failed/);
  assert.match(prompts[1], /retry of round 1 after the previous attempt failed: Developer session produced no PR\./);
  assert.doesNotMatch(prompts[1], /fresh branch/);
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

test("a crash that also leaves the worktree dirty escalates as dirty_worktree, not a blind retry that would collide on the next round", async () => {
  // A review round found: crashingSpawn/timedOutSpawn returned session_failed/timed_out
  // unconditionally, which routes as a round-consuming retry. But bestEffortRemove
  // correctly refuses to remove a dirty checkout, so the branch stayed checked out there
  // — and the very next round's `git worktree add` for that same branch would then fail,
  // burning a round on a confusing adapter_failure two rounds later instead of the
  // immediate policy_escalation a dirty handoff is supposed to get.
  const issueId = await makeIssue();
  const crashingDirtySpawn: SpawnFn = async (input) => {
    fs.writeFileSync(path.join(input.cwd, "half-done.txt"), "oops\n");
    return { exitCode: 1, transcript: "boom", logPath: "/dev/null", timedOut: false };
  };
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { spawn: crashingDirtySpawn, github: fakeGithub() }));
  startWorkflow(issueId);
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human");
  assert.equal(issue.currentRound, 1, "a dirty crash never consumes a round");
  assert.ok(listHumanActionsForIssue(issueId).find((a) => a.actionType === "policy_escalation"));
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
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { spawn: commitingSpawn, github: fakeGithub({ checks: "pending" }) }));
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
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { spawn: commitingSpawn, github }));
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
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { spawn: commitingSpawn, github }));
  startWorkflow(issueId);
  await pump(1);

  assert.equal(getIssue(issueId)!.status, "needs_human");
});

test("adapter_failure: a stale headRefOid (gh's view lags the actual push) is rejected rather than accepted", async () => {
  const issueId = await makeIssue({ maxInfraAttempts: 0 });
  const github = fakeGithub();
  const realViewPr = github.viewPr.bind(github);
  github.viewPr = async (opts) => {
    const view = await realViewPr(opts);
    return view ? { ...view, headRefOid: "0000000000000000000000000000000000dead" } : view;
  };
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { spawn: commitingSpawn, github }));
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
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { spawn: commitingSpawn, github }));
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
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { spawn: commitingSpawn, github: fakeGithub({ createFails: true }) }));
  startWorkflow(issueId);
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human");
  assert.equal(issue.currentRound, 1, "adapter failure never consumes a review round");
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

    const dev = createAgent({ name: `dev-iso-${Math.random()}`, runtime: "claude_code", workspaceRoot: isoRepo });
    const rev = createAgent({ name: `rev-iso-${Math.random()}`, runtime: "claude_code", workspaceRoot: isoRepo });
    const issueId = createIssue({
      title: "Iso base sha",
      acceptanceCriteria: "works",
      repo: isoRepo,
      baseBranch: "main",
      developerAgentId: dev.id,
      reviewerAgentId: rev.id,
      maxReviewRounds: 3,
      maxInfraAttempts: 3,
      source: "manual",
    }).id;

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
      async viewPr({ cwd }) {
        const branch = git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
        const pr = isoPrs.get(branch);
        if (!pr) return null;
        return { number: pr.number, url: pr.url, baseRefName: pr.base, headRefName: branch, headRefOid: git(isoRemote, "rev-parse", branch), isDraft: true };
      },
      async createDraftPr({ cwd, base }) {
        const branch = git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
        const number = 1;
        isoPrs.set(branch, { number, url: `https://github.com/o/r/pull/${number}`, base });
        return { ok: true, number, url: `https://github.com/o/r/pull/${number}` };
      },
      async checksSnapshot() {
        return "success";
      },
      async publishReview() {
        throw new Error("publishReview is unused by the developer effect");
      },
    };

    registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { spawn: isoCommittingSpawn, github: isoGithub }));
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
