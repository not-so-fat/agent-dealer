// packages/server/src/coordinator/reclaim-republish.integration.test.ts
//
// NOT-129: a reclaimed attempt that already has commits routes to republish, not a fresh
// agent session.
//
// On NOT-121 a commit sat unpushed on the branch for ~3 hours while five full developer
// sessions each re-ran a ~40-minute suite to redo it, and an OPEN + MERGEABLE PR carried only
// half the fix the whole time. The session was being treated as the unit of progress; the
// branch is the durable artifact. These are the acceptance scenarios: the same presumed-dead
// reclaim against all three branch states, end to end through recovery → work item → the real
// developer effect, with a real git repo + bare "origin" and a spawn that FAILS the test if
// it is ever called — "no fresh agent session" is the whole point, so it is asserted by
// construction rather than by counting sessions after the fact.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-republish-home-"));
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
const { createWorkerSession, startSession, listWorkerSessionsForIssue } = await import(
  "../repository/worker-sessions.js"
);
const { listWorkItemsForIssue, claimWorkItem, bindWorkItemSession, getWorkItem } = await import(
  "../repository/work-items.js"
);
const { listWorkflowEventsForIssue } = await import("../repository/workflow-events.js");
const { startWorkflow } = await import("./commands.js");
const { recoverCoordinator } = await import("./recovery.js");
const { registerEffectHandler, resetEffectHandlers } = await import("./effect-registry.js");
const { runCoordinatorTick, drainCoordinator } = await import("./worker-loop.js");
const { runDeveloperEffect } = await import("./developer-effect.js");
const { realDeveloperSpawn } = await import("./spawn.js");
const { realGithubAdapter } = await import("../adapters/github.js");
type SpawnFn = typeof realDeveloperSpawn;
type GithubFn = typeof realGithubAdapter;

/** A clock well past any lease in this file — recovery must see every lease as expired. */
const FUTURE = () => Date.now() + 3_600_000;

before(() => migrate());
beforeEach(() => getDb().exec("DELETE FROM work_items"));
after(() => resetEffectHandlers());

let repo: string;
let remote: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-republish-repo-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");

  remote = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-republish-remote-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
});

after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(remote, { recursive: true, force: true });
});

function makeIssue(): string {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", deckId: "00000000-0000-4000-a000-000000000099"});
  const rev = createAgent({ name: `rev-${Math.random()}`, runtime: "claude_code", deckId: "00000000-0000-4000-a000-000000000099"});
  return createIssue({
    title: "Keep card deletes complete when a deck file write fails",
    description: "Recover the stranded commit.",
    acceptanceCriteria: "The fix ships in one piece.",
    repo,
    baseBranch: "main",
    developerAgentId: dev.id,
    reviewerAgentId: rev.id,
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual"}).id;
}

/**
 * What a dead attempt leaves behind: a commit on the issue branch in the shared repo. Made
 * through a throwaway worktree (that is how the real developer commits) and then removed, so
 * the branch ref — the durable artifact under test — is all that survives.
 */
function commitOnBranch(branch: string, file: string): string {
  const wt = path.join(os.tmpdir(), `dealer-republish-wt-${Math.random().toString(36).slice(2)}`);
  git(repo, "worktree", "add", "-q", "-b", branch, wt, "main");
  fs.writeFileSync(path.join(wt, file), "recovered work\n");
  git(wt, "add", ".");
  git(wt, "-c", "user.email=agent@test", "-c", "user.name=Agent", "commit", "-q", "-m", `implement ${file}`);
  const sha = git(wt, "rev-parse", "HEAD");
  git(repo, "worktree", "remove", "--force", wt);
  return sha;
}

/** `commitOnBranch` for a branch that already exists — a second round on the same branch. */
function commitOnBranchTip(branch: string, file: string): string {
  const wt = path.join(os.tmpdir(), `dealer-republish-wt-${Math.random().toString(36).slice(2)}`);
  git(repo, "worktree", "add", "-q", wt, branch);
  fs.writeFileSync(path.join(wt, file), "more recovered work\n");
  git(wt, "add", ".");
  git(wt, "-c", "user.email=agent@test", "-c", "user.name=Agent", "commit", "-q", "-m", `implement ${file}`);
  const sha = git(wt, "rev-parse", "HEAD");
  git(repo, "worktree", "remove", "--force", wt);
  return sha;
}

/** Claims the issue's developer item and binds a running session, as a live attempt has. */
function leasedAttempt(issueId: string): { itemId: string; sessionId: string } {
  const item = listWorkItemsForIssue(issueId).find((i) => i.kind === "developer")!;
  const claimed = claimWorkItem("crashed-attempt", { leaseMs: 60_000 })!;
  const session = createWorkerSession({
    issueId,
    role: "developer",
    round: 1,
    agentId: getIssue(issueId)!.developerAgentId,
    runtime: "claude_code"});
  startSession(session.id);
  assert.equal(bindWorkItemSession(item.id, session.id, claimed.leaseToken!), true);
  return { itemId: item.id, sessionId: session.id };
}

/** Asserts by construction: reaching the agent at all is a failure of this ticket. */
const forbiddenSpawn: SpawnFn = async () => {
  throw new Error("a republish must never spawn an agent session");
};

function fakeGithub(opts: { seedPr?: { branch: string; base: string } } = {}): GithubFn {
  const prs = new Map<string, { number: number; url: string; base: string }>();
  let nextNumber = 700;
  if (opts.seedPr) {
    prs.set(opts.seedPr.branch, { number: nextNumber++, url: `https://github.com/o/r/pull/699`, base: opts.seedPr.base });
  }
  // GitHub's view of a PR head is the REMOTE tip, read from the bare repo — never the local
  // checkout, so a branch that was only committed locally correctly reads as "not there yet".
  const remoteHead = (branch: string) => git(remote, "rev-parse", branch);
  return {
    async viewPr({ branch, number }) {
      if (!branch) throw new Error("viewPr requires an explicit branch (NOT-82)");
      const pr = prs.get(branch);
      if (!pr) return null;
      if (number != null && number !== pr.number) return null;
      return {
        number: pr.number,
        url: pr.url,
        baseRefName: pr.base,
        headRefName: branch,
        headRefOid: remoteHead(branch),
        isDraft: true};
    },
    async createDraftPr({ base, head }) {
      if (!head) throw new Error("createDraftPr requires an explicit --head (NOT-82)");
      const number = nextNumber++;
      const url = `https://github.com/o/r/pull/${number}`;
      prs.set(head, { number, url, base });
      return { ok: true, number, url };
    },
    async checksSnapshot() {
      return "success";
    },
    async publishReview() {
      throw new Error("publishReview is unused by the developer effect");
    }};
}

async function pump(max = 20): Promise<void> {
  for (let i = 0; i < max; i++) {
    const started = await runCoordinatorTick({ leaseOwner: "pump" });
    await drainCoordinator();
    if (started === 0) return;
  }
}

function workerFailedPayload(issueId: string): Record<string, unknown> {
  const failed = listWorkflowEventsForIssue(issueId).filter((e) => e.type === "worker.failed");
  assert.ok(failed.length >= 1, "the reclaim must be visible on the timeline");
  return JSON.parse(failed[failed.length - 1]!.payloadJson!) as Record<string, unknown>;
}

// ------------------------------------------------------- state 1: unpushed local commits

test("NOT-129: a presumed-dead reclaim with unpushed commits enqueues a publishOnly item and publishes them without an agent", async () => {
  const issueId = makeIssue();
  const branch = `issue-${issueId}`;
  startWorkflow(issueId);
  const { itemId } = leasedAttempt(issueId);
  // The attempt committed and then died before the coordinator could push — the NOT-121 case.
  const sha = commitOnBranch(branch, "card-delete.ts");
  assert.equal(git(repo, "ls-remote", "origin", `refs/heads/${branch}`), "", "precondition: nothing on origin");

  const res = await recoverCoordinator({ now: FUTURE() });
  assert.deepEqual(res.republished, [itemId], "unpushed commits must route to republish");
  assert.deepEqual(res.reclaimed, [], "…and not to a fresh developer session");

  const requeued = getWorkItem(itemId)!;
  assert.equal(requeued.status, "pending");
  const payload = JSON.parse(requeued.payloadJson!) as { publishOnly?: boolean; branch?: string; profileSnapshot?: string };
  assert.equal(payload.publishOnly, true);
  assert.equal(payload.branch, branch);
  assert.ok(payload.profileSnapshot, "the frozen execution profile must survive the re-point");

  // Timeline: this reads as a republish, not as the agent redoing the work.
  const failedPayload = workerFailedPayload(issueId);
  assert.equal(failedPayload.recovery, "republish");
  assert.equal(failedPayload.branchState, "unpushed");
  assert.match(String(failedPayload.reason), /presumed dead/);
  assert.match(String(failedPayload.reason), /republishing 1 unpushed commit/);
  assert.match(getIssue(issueId)!.currentIntent ?? "", /Republishing 1 recovered commit \(no agent\)/);

  registerEffectHandler("developer", (ctx) =>
    runDeveloperEffect(ctx, { spawn: forbiddenSpawn, github: fakeGithub() })
  );
  await pump(1);

  assert.equal(git(repo, "ls-remote", "origin", `refs/heads/${branch}`).startsWith(sha), true, "the stranded commit is on origin");
  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "reviewing", "the recovered work goes straight to review");
  assert.equal(issue.branch, branch);
  assert.equal(issue.headSha, sha);
  assert.ok(issue.prNumber, "a PR now carries the recovered commit");
  assert.equal(listWorkItemsForIssue(issueId).filter((i) => i.kind === "reviewer").length, 1);
});

// --------------------------------- state 1b: the recovered push itself fails, transiently

test("NOT-129: a recovered push that fails transiently retries publish-only, then publishes without an agent", async () => {
  const issueId = makeIssue();
  const branch = `issue-${issueId}`;
  startWorkflow(issueId);
  const { itemId } = leasedAttempt(issueId);
  const sha = commitOnBranch(branch, "transient.ts");
  assert.deepEqual((await recoverCoordinator({ now: FUTURE() })).republished, [itemId]);

  // One github across both attempts: the retry must reuse whatever the first one left behind.
  const github = fakeGithub();
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { spawn: forbiddenSpawn, github }));

  // The remote is unreachable for this attempt — a dropped connection, not a rejection. It
  // says nothing about the commits, which are still sitting on the branch. `origin` is shared
  // with every other test in this file, so it is restored in `finally`: a failure here must
  // stay this test's failure rather than becoming four unrelated git transport errors.
  const originUrl = git(repo, "remote", "get-url", "origin");
  try {
    git(repo, "remote", "set-url", "origin", path.join(os.tmpdir(), "dealer-republish-unreachable"));
    await pump(1);

    const afterFailure = getIssue(issueId)!;
    assert.notEqual(afterFailure.status, "reviewing", "the publish failed");
    assert.match(afterFailure.currentIntent ?? "", /Retrying GitHub publish \(no agent\)/);
    const pending = listWorkItemsForIssue(issueId).filter((i) => i.kind === "developer" && i.status === "pending");
    assert.equal(pending.length, 1, "the failed publish leaves exactly one pending developer item");
    const payload = JSON.parse(pending[0]!.payloadJson!) as { publishOnly?: boolean; branch?: string };
    assert.equal(payload.publishOnly, true, "a transient push failure must not cost a full agent rerun");
    assert.equal(payload.branch, branch, "…and the retry must still be pointed at the recovered branch");
  } finally {
    git(repo, "remote", "set-url", "origin", originUrl);
  }

  // Remote back: the same commits publish, still with no agent behind them.
  await pump(1);

  assert.equal(
    git(repo, "ls-remote", "origin", `refs/heads/${branch}`).startsWith(sha),
    true,
    "the recovered commit reached origin on the retry"
  );
  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "reviewing");
  assert.equal(issue.headSha, sha);
  assert.ok(issue.prNumber, "a PR now carries the recovered commit");
});

// ------------------------------------------------- state 2: already pushed, PR already open

test("NOT-129: a presumed-dead reclaim whose branch is already pushed with an open PR re-verifies it instead of re-running the agent", async () => {
  const issueId = makeIssue();
  const branch = `issue-${issueId}`;
  startWorkflow(issueId);
  const { itemId } = leasedAttempt(issueId);
  // Attempt 1 on NOT-121: it pushed and opened its PR *after* the coordinator gave up on it.
  const sha = commitOnBranch(branch, "deck-membership.ts");
  git(repo, "push", "-q", "origin", branch);

  const res = await recoverCoordinator({ now: FUTURE() });
  assert.deepEqual(res.republished, [itemId]);
  assert.deepEqual(res.reclaimed, []);

  const payload = JSON.parse(getWorkItem(itemId)!.payloadJson!) as { publishOnly?: boolean; branch?: string };
  assert.equal(payload.publishOnly, true);
  assert.equal(payload.branch, branch);

  const failedPayload = workerFailedPayload(issueId);
  assert.equal(failedPayload.recovery, "republish");
  assert.equal(failedPayload.branchState, "published");
  assert.match(String(failedPayload.reason), /already on origin, re-verifying the PR/);

  registerEffectHandler("developer", (ctx) =>
    runDeveloperEffect(ctx, { spawn: forbiddenSpawn, github: fakeGithub({ seedPr: { branch, base: "main" } }) })
  );
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "reviewing");
  assert.equal(issue.headSha, sha);
  assert.equal(issue.prNumber, 700, "the PR the dead attempt opened is reused, not replaced");
  assert.equal(
    listWorkerSessionsForIssue(issueId).filter((s) => s.role === "developer" && s.status === "done").length,
    1,
    "exactly one developer session completed — the republish one, with no agent behind it"
  );
});

// ---------------------------------------------------------------- state 3: nothing to publish

test("NOT-129: a presumed-dead reclaim with an empty branch still enqueues a normal developer attempt", async () => {
  const issueId = makeIssue();
  startWorkflow(issueId);
  const { itemId } = leasedAttempt(issueId);
  // No branch at all — the attempt died before committing anything.

  const res = await recoverCoordinator({ now: FUTURE() });
  assert.deepEqual(res.reclaimed, [itemId], "nothing to publish — a full attempt is the only option");
  assert.deepEqual(res.republished, []);

  const requeued = getWorkItem(itemId)!;
  assert.equal(requeued.status, "pending");
  const payload = JSON.parse(requeued.payloadJson!) as { publishOnly?: boolean };
  assert.equal(payload.publishOnly, undefined, "a normal developer attempt, not a republish");

  // Timeline: distinguishable from the two republish cases above.
  const failedPayload = workerFailedPayload(issueId);
  assert.equal(failedPayload.recovery, "rerun");
  assert.equal(failedPayload.branchState, undefined);
  assert.match(String(failedPayload.reason), /presumed dead/);
  assert.match(String(failedPayload.reason), /re-running the developer/);

  // And the re-run really does reach the agent — the spawn is what produces the commit here.
  const spawned: string[] = [];
  registerEffectHandler("developer", (ctx) =>
    runDeveloperEffect(ctx, {
      spawn: async (input) => {
        spawned.push(input.cwd);
        fs.writeFileSync(path.join(input.cwd, "fresh.txt"), "from scratch\n");
        git(input.cwd, "add", ".");
        git(input.cwd, "-c", "user.email=agent@test", "-c", "user.name=Agent", "commit", "-q", "-m", "implement");
        return { exitCode: 0, transcript: "conclusion", logPath: "/dev/null", timedOut: false };
      },
      github: fakeGithub()})
  );
  await pump(1);

  assert.equal(spawned.length, 1, "an empty branch must still get a real agent session");
  assert.equal(getIssue(issueId)!.status, "reviewing");
});

// ------------------------------------------------------------ the branch classifier itself

test("NOT-129: a branch whose commits are all on origin reads as published, and one with none as empty", async () => {
  const { inspectBranchProgress } = await import("./branch-progress.js");
  const baseRefs = ["origin/main", "main"];

  assert.deepEqual(await inspectBranchProgress({ repo, branch: "no-such-branch", baseRefs }), {
    state: "absent",
    branch: "no-such-branch"});

  // A branch created off main with no commits of its own has nothing to publish.
  git(repo, "branch", "empty-branch", "main");
  assert.deepEqual(await inspectBranchProgress({ repo, branch: "empty-branch", baseRefs }), {
    state: "empty",
    branch: "empty-branch"});

  commitOnBranch("half-published", "one.txt");
  assert.deepEqual(await inspectBranchProgress({ repo, branch: "half-published", baseRefs }), {
    state: "unpushed",
    branch: "half-published",
    ahead: 1,
    unpushed: 1});

  git(repo, "push", "-q", "origin", "half-published");
  assert.deepEqual(await inspectBranchProgress({ repo, branch: "half-published", baseRefs }), {
    state: "published",
    branch: "half-published",
    ahead: 1});

  // A repo that isn't there at all degrades to "absent" — recovery must never throw.
  assert.deepEqual(await inspectBranchProgress({ repo: "/nope/not/a/repo", branch: "x", baseRefs }), {
    state: "absent",
    branch: "x"});

  // No base resolves AND origin has never seen the branch: "it carries work" would be a
  // guess, and the wrong guess pushes an empty branch at a PR `gh` will reject. Guess the
  // cheap way — a needless agent session is only the status quo.
  commitOnBranch("unmeasurable", "two.txt");
  assert.deepEqual(
    await inspectBranchProgress({ repo, branch: "unmeasurable", baseRefs: ["origin/nope", "nope"] }),
    { state: "absent", branch: "unmeasurable" }
  );
  // …but once origin has the branch, the remote IS the reference point — no base needed.
  git(repo, "push", "-q", "origin", "unmeasurable");
  commitOnBranchTip("unmeasurable", "three.txt");
  assert.deepEqual(
    await inspectBranchProgress({ repo, branch: "unmeasurable", baseRefs: ["origin/nope", "nope"] }),
    { state: "unpushed", branch: "unmeasurable", ahead: 1, unpushed: 1 }
  );
});
