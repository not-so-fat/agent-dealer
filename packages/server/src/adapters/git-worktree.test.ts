// packages/server/src/adapters/git-worktree.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Worktrees live under `<repo>/.agent-dealer-worktrees/` so deck grants on the issue
// repo cover the worker cwd. realpathSync: macOS's /tmp is a symlink to /private/tmp,
// and `git worktree list` reports the resolved path — without this, path comparisons
// against findWorktreeForBranch/resolveDeveloperWorktree would fail.
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dealer-wt-home-")));
process.env.AGENT_DEALER_HOME = home;

const {
  branchExists,
  createRoleWorktree,
  safeRemoveWorktree,
  fetchFreshBase,
  inspectLeftoverWorktree,
  isWorktreeClean,
  withRepoLock,
  pushBranch,
  pushWithLease,
  commitsAhead,
  findWorktreeForBranch,
  resolveDeveloperWorktree,
  worktreesRoot,
  WORKTREES_DIR_NAME,
} = await import("./git-worktree.js");

let repo: string;
let remote: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** `git` with extra env — used to pin commit dates apart so rebuilt/cherry-picked
 * equivalents never collide with the original SHAs within the same second. */
function gitEnv(cwd: string, env: Record<string, string>, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } }).trim();
}

/** Fixed past identity dates: commits made "then" always differ in SHA from an
 * equivalent patch committed "now", however fast the test runs. */
const PAST_DATES = {
  GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
};

function commitFileAs(
  cwd: string,
  name: string,
  content: string,
  message: string,
  env?: Record<string, string>
): string {
  fs.writeFileSync(path.join(cwd, name), content);
  const run = env ? (args: string[]) => gitEnv(cwd, env, ...args) : (args: string[]) => git(cwd, ...args);
  run(["add", "."]);
  run(["commit", "-m", message]);
  return git(cwd, "rev-parse", "HEAD");
}

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-wt-repo-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "init");
  git(repo, "branch", "issue-1");

  // A real `origin` so push-block tests exercise the pushurl override, not just a
  // missing-remote error, while fetch/read stays meaningful.
  remote = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-wt-remote-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main", "issue-1");
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(remote, { recursive: true, force: true });
});

test("createRoleWorktree gives the developer a branch checkout and the reviewer a detached one", async () => {
  const dev = await createRoleWorktree({ repo, role: "developer", sessionId: "s-dev", ref: "issue-1" });
  assert.ok(dev.path.startsWith(fs.realpathSync(worktreesRoot(repo)) + path.sep));
  assert.ok(dev.path.includes(WORKTREES_DIR_NAME));
  const head = git(repo, "rev-parse", "HEAD");
  const rev = await createRoleWorktree({ repo, role: "reviewer", sessionId: "s-rev", ref: head });

  assert.ok(fs.existsSync(dev.path));
  assert.equal(dev.detached, false);
  assert.equal(git(dev.path, "rev-parse", "--abbrev-ref", "HEAD"), "issue-1");

  assert.ok(fs.existsSync(rev.path));
  assert.equal(rev.detached, true);
  assert.equal(git(rev.path, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");

  await safeRemoveWorktree({ repo, path: dev.path, role: "developer", branchPushed: true });
  await safeRemoveWorktree({ repo, path: rev.path, role: "reviewer" });
});

test("NOT-145: salvageDirtyWorktree auto-commits dirty WIP as a marked tip", async () => {
  const { salvageDirtyWorktree, SALVAGE_TIMEOUT_MESSAGE, SALVAGE_CRASH_MESSAGE } = await import(
    "./git-worktree.js"
  );
  const dev = await createRoleWorktree({ repo, role: "developer", sessionId: "s-salvage", ref: "issue-1" });
  fs.writeFileSync(path.join(dev.path, "half-done.txt"), "wip\n");
  assert.equal(await isWorktreeClean(dev.path), false);

  const before = git(dev.path, "rev-parse", "HEAD");
  const result = await salvageDirtyWorktree(dev.path, "timeout");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.message, SALVAGE_TIMEOUT_MESSAGE);
    assert.notEqual(result.commitSha, before);
    assert.equal(git(dev.path, "rev-parse", "HEAD"), result.commitSha);
    assert.equal(git(dev.path, "log", "-1", "--pretty=%s"), SALVAGE_TIMEOUT_MESSAGE);
  }
  assert.equal(await isWorktreeClean(dev.path), true);

  fs.writeFileSync(path.join(dev.path, "more.txt"), "again\n");
  const crash = await salvageDirtyWorktree(dev.path, "crash");
  assert.equal(crash.ok, true);
  if (crash.ok) assert.equal(crash.message, SALVAGE_CRASH_MESSAGE);

  await safeRemoveWorktree({ repo, path: dev.path, role: "developer", branchPushed: true });
});

test("NOT-145: salvageDirtyWorktree reports failure without mutating when there is nothing to commit", async () => {
  const { salvageDirtyWorktree } = await import("./git-worktree.js");
  const dev = await createRoleWorktree({ repo, role: "developer", sessionId: "s-salvage-empty", ref: "issue-1" });
  assert.equal(await isWorktreeClean(dev.path), true);
  const before = git(dev.path, "rev-parse", "HEAD");
  const result = await salvageDirtyWorktree(dev.path, "timeout");
  assert.equal(result.ok, false);
  assert.equal(git(dev.path, "rev-parse", "HEAD"), before);
  await safeRemoveWorktree({ repo, path: dev.path, role: "developer", branchPushed: true });
});

test("safeRemoveWorktree removes a clean reviewer checkout but preserves a dirty developer one", async () => {
  const rev = await createRoleWorktree({ repo, role: "reviewer", sessionId: "s-rev2", ref: "HEAD" });
  const removed = await safeRemoveWorktree({ repo, path: rev.path, role: "reviewer" });
  assert.deepEqual(removed, { removed: true });
  assert.ok(!fs.existsSync(rev.path));

  const dev = await createRoleWorktree({ repo, role: "developer", sessionId: "s-dev2", ref: "issue-1" });
  fs.writeFileSync(path.join(dev.path, "scratch.txt"), "uncommitted work\n");
  assert.equal(await isWorktreeClean(dev.path), false);

  const result = await safeRemoveWorktree({ repo, path: dev.path, role: "developer", branchPushed: true });
  assert.equal(result.removed, false);
  assert.ok(fs.existsSync(dev.path), "dirty developer worktree must be preserved");
  if (result.removed === false) {
    assert.match(result.reason, /uncommitted/);
    assert.ok(result.recoveryCommands.some((c) => c.includes(dev.path)));
  }

  // clean it up for real
  fs.rmSync(dev.path, { recursive: true, force: true });
  await withRepoLock(repo, async () => {
    execFileSync("git", ["worktree", "prune"], { cwd: repo });
  });
});

test("safeRemoveWorktree preserves a clean developer worktree whose branch is not pushed", async () => {
  const dev = await createRoleWorktree({ repo, role: "developer", sessionId: "s-dev3", ref: "issue-1" });
  const result = await safeRemoveWorktree({ repo, path: dev.path, role: "developer", branchPushed: false });
  assert.equal(result.removed, false);
  if (result.removed === false) assert.match(result.reason, /not pushed/);
  fs.rmSync(dev.path, { recursive: true, force: true });
  await withRepoLock(repo, async () => execFileSync("git", ["worktree", "prune"], { cwd: repo }));
});

test("withRepoLock serializes concurrent worktree operations on one repo", async () => {
  const order: string[] = [];
  const slow = withRepoLock(repo, async () => {
    order.push("a:start");
    await new Promise((r) => setTimeout(r, 30));
    order.push("a:end");
  });
  const fast = withRepoLock(repo, async () => {
    order.push("b:start");
    order.push("b:end");
  });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
});

test("reviewer worktrees redirect origin's pushurl as hygiene — an ordinary push fails, reads are unaffected", async () => {
  const rev = await createRoleWorktree({ repo, role: "reviewer", sessionId: "s-rev-pushblock", ref: "HEAD" });
  try {
    assert.throws(() => git(rev.path, "push", "origin", "HEAD:refs/heads/reviewer-accident"));
    assert.doesNotThrow(() => git(rev.path, "fetch", "origin"));
    // Scoped to this worktree — the original checkout's own pushurl is untouched.
    assert.equal(git(repo, "remote", "get-url", "--push", "origin"), remote);
  } finally {
    await safeRemoveWorktree({ repo, path: rev.path, role: "reviewer" });
  }
});

test("the pushurl redirect is NOT a security boundary — it does not survive a targeted bypass", async () => {
  // Documents the exact bypasses a PR review round found, so this limitation can't
  // silently regress into being treated as enforcement again: reviewer worktrees get no
  // Bash/write tool grant at all (args.ts), which is the actual reason a reviewer can't
  // push — this git-config redirect alone would not stop a session that could edit files.
  const rev = await createRoleWorktree({ repo, role: "reviewer", sessionId: "s-rev-bypass", ref: "HEAD" });
  try {
    // Bypass 1: push straight to the remote URL instead of the configured name.
    assert.doesNotThrow(() => git(rev.path, "push", remote, "HEAD:refs/heads/bypass-1"));
    // Bypass 2: the config lives inside the worktree the same process can already write.
    git(rev.path, "config", "--worktree", "--unset-all", "remote.origin.pushurl");
    assert.doesNotThrow(() => git(rev.path, "push", "origin", "HEAD:refs/heads/bypass-2"));
  } finally {
    // Throwaway bare remote is removed wholesale in after() — no branch cleanup needed.
    await safeRemoveWorktree({ repo, path: rev.path, role: "reviewer" });
  }
});

test("createRoleWorktree with newBranch creates a fresh branch off the given base ref (round 1)", async () => {
  const dev = await createRoleWorktree({ repo, role: "developer", sessionId: "s-dev-new", ref: "main", newBranch: "issue-new-1" });
  assert.equal(git(dev.path, "rev-parse", "--abbrev-ref", "HEAD"), "issue-new-1");
  assert.equal(dev.ref, "issue-new-1");
  fs.rmSync(dev.path, { recursive: true, force: true });
  await withRepoLock(repo, async () => execFileSync("git", ["worktree", "prune"], { cwd: repo }));
  execFileSync("git", ["branch", "-D", "issue-new-1"], { cwd: repo });
});

test("commitsAhead counts commits on HEAD not on the base ref, zero when there are none", async () => {
  const dev = await createRoleWorktree({ repo, role: "developer", sessionId: "s-dev-ahead", ref: "main", newBranch: "issue-ahead" });
  assert.equal(await commitsAhead({ worktreePath: dev.path, baseRef: "origin/main" }), 0);
  fs.writeFileSync(path.join(dev.path, "feature.txt"), "work\n");
  git(dev.path, "add", ".");
  git(dev.path, "commit", "-m", "feature");
  assert.equal(await commitsAhead({ worktreePath: dev.path, baseRef: "origin/main" }), 1);
  fs.rmSync(dev.path, { recursive: true, force: true });
  await withRepoLock(repo, async () => execFileSync("git", ["worktree", "prune"], { cwd: repo }));
  execFileSync("git", ["branch", "-D", "issue-ahead"], { cwd: repo });
});

test("pushBranch pushes a clean commit and reports a real rejection distinctly from a tooling failure", async () => {
  const dev = await createRoleWorktree({ repo, role: "developer", sessionId: "s-dev-push", ref: "main", newBranch: "issue-push" });
  fs.writeFileSync(path.join(dev.path, "feature.txt"), "work\n");
  git(dev.path, "add", ".");
  git(dev.path, "commit", "-m", "feature");

  const ok = await pushBranch({ worktreePath: dev.path, branch: "issue-push" });
  assert.deepEqual(ok, { ok: true });
  assert.equal(git(repo, "ls-remote", "origin", "refs/heads/issue-push").length > 0, true);

  // Diverge the remote branch, then try to push again — a real rejection, not a crash.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-wt-other-"));
  execFileSync("git", ["clone", "-q", remote, other]);
  git(other, "checkout", "issue-push");
  git(other, "config", "user.email", "test@example.com");
  git(other, "config", "user.name", "Test");
  fs.writeFileSync(path.join(other, "elsewhere.txt"), "y");
  git(other, "add", ".");
  git(other, "commit", "-m", "elsewhere");
  git(other, "push", "origin", "issue-push");
  const remoteSha = git(other, "rev-parse", "HEAD");

  fs.writeFileSync(path.join(dev.path, "feature2.txt"), "more\n");
  git(dev.path, "add", ".");
  git(dev.path, "commit", "-m", "feature2");
  const localSha = git(dev.path, "rev-parse", "HEAD");
  const rejected = await pushBranch({ worktreePath: dev.path, branch: "issue-push" });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.rejected, true);
    // NOT-137: rejection carries divergence facts — not opaque git stderr alone.
    assert.ok(rejected.facts, "rejected push must attach divergence facts");
    assert.equal(rejected.facts.localSha, localSha);
    assert.equal(rejected.facts.remoteSha, remoteSha);
    assert.equal(rejected.facts.ahead, 1);
    assert.equal(rejected.facts.behind, 1);
    assert.equal(rejected.facts.relationship, "diverged");
    assert.match(rejected.reason, /diverged/i);
    assert.doesNotMatch(rejected.reason, /use 'git pull'/i);
    assert.ok(rejected.facts.recoveryCommands.some((c) => c.includes("force-with-lease")));
    assert.ok(rejected.facts.recoveryCommands.some((c) => c.includes(remoteSha)));
  }

  const infra = await pushBranch({ worktreePath: "/no/such/worktree", branch: "issue-push" });
  assert.equal(infra.ok, false);
  if (!infra.ok) assert.equal(infra.rejected, false);

  fs.rmSync(dev.path, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
  await withRepoLock(repo, async () => execFileSync("git", ["worktree", "prune"], { cwd: repo }));
  execFileSync("git", ["branch", "-D", "issue-push"], { cwd: repo });
});

test("NOT-137: pushBranch rejection when local is strictly behind reports behind + rebase recovery, not force-with-lease", async () => {
  // Local tip equals the last successful push; remote alone advanced. Resetting local to that
  // tip after a remote-only commit yields ahead=0, behind=1 — the "behind" relationship.
  const branch = "issue-push-behind";
  const dev = await createRoleWorktree({
    repo,
    role: "developer",
    sessionId: "s-dev-push-behind",
    ref: "main",
    newBranch: branch,
  });
  fs.writeFileSync(path.join(dev.path, "feature.txt"), "work\n");
  git(dev.path, "add", ".");
  git(dev.path, "commit", "-m", "feature");
  assert.deepEqual(await pushBranch({ worktreePath: dev.path, branch }), { ok: true });
  const pushedSha = git(dev.path, "rev-parse", "HEAD");

  const other = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-wt-behind-"));
  execFileSync("git", ["clone", "-q", remote, other]);
  git(other, "checkout", branch);
  git(other, "config", "user.email", "test@example.com");
  git(other, "config", "user.name", "Test");
  fs.writeFileSync(path.join(other, "remote-only.txt"), "r");
  git(other, "add", ".");
  git(other, "commit", "-m", "remote-only");
  git(other, "push", "origin", branch);
  const remoteSha = git(other, "rev-parse", "HEAD");

  // Local has no unique commits — reset to the previously pushed tip.
  git(dev.path, "reset", "--hard", pushedSha);
  // pushBranch always pushes HEAD; force a rejection by advancing... wait, ahead=0 means
  // HEAD is an ancestor of remote, so push is a no-op / rejected as non-FF depending on git.
  // `git push` of an ancestor tip is rejected as non-fast-forward when remote moved.
  const rejected = await pushBranch({ worktreePath: dev.path, branch });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.rejected, true);
    assert.ok(rejected.facts);
    assert.equal(rejected.facts.relationship, "behind");
    assert.equal(rejected.facts.ahead, 0);
    assert.equal(rejected.facts.behind, 1);
    assert.equal(rejected.facts.localSha, pushedSha);
    assert.equal(rejected.facts.remoteSha, remoteSha);
    assert.match(rejected.reason, /behind/i);
    assert.doesNotMatch(rejected.reason, /diverged/i);
    assert.ok(rejected.facts.recoveryCommands.some((c) => /rebase/i.test(c)));
    assert.ok(!rejected.facts.recoveryCommands.some((c) => c.includes("force-with-lease")));
  }

  fs.rmSync(dev.path, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
  await withRepoLock(repo, async () => execFileSync("git", ["worktree", "prune"], { cwd: repo }));
  execFileSync("git", ["branch", "-D", branch], { cwd: repo });
});

test("NOT-220: diverged push with remote tip == last known head and patch-equivalent remote commits recovers via the lease pin", async () => {
  const branch = "issue-push-lease";
  const dev = await createRoleWorktree({
    repo,
    role: "developer",
    sessionId: "s-dev-push-lease",
    ref: "main",
    newBranch: branch,
  });
  const commitFile = (cwd: string, name: string, content: string, message: string) => {
    fs.writeFileSync(path.join(cwd, name), content);
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", message);
    return git(cwd, "rev-parse", "HEAD");
  };
  const base = commitFile(dev.path, "base.txt", "base\n", "base");
  assert.deepEqual(await pushBranch({ worktreePath: dev.path, branch }), { ok: true });

  // The reviewed remote head: two commits Dealer recorded as its last known head.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-wt-lease-other-"));
  execFileSync("git", ["clone", "-q", remote, other]);
  git(other, "checkout", branch);
  git(other, "config", "user.email", "test@example.com");
  git(other, "config", "user.name", "Test");
  // Past dates: the local cherry-picks below (made "now") can never collide with
  // these SHAs, however fast the test runs.
  const r1 = commitFileAs(other, "r1.txt", "r1\n", "remote1", PAST_DATES);
  const remoteSha = commitFileAs(other, "r2.txt", "r2\n", "remote2", PAST_DATES);
  git(other, "push", "origin", branch);

  // Local rebuild: the same patches (cherry-picked, so new SHAs) plus one new commit.
  git(dev.path, "fetch", "origin", branch);
  git(dev.path, "reset", "--hard", base);
  git(dev.path, "cherry-pick", r1);
  git(dev.path, "cherry-pick", remoteSha);
  const localSha = commitFile(dev.path, "new.txt", "new\n", "new work");
  assert.notEqual(localSha, remoteSha);
  // Drop upstream tracking so the test proves the LEASE push sets it like the plain push.
  git(dev.path, "branch", "--unset-upstream");

  const result = await pushBranch({ worktreePath: dev.path, branch, lastKnownHeadSha: remoteSha });
  assert.equal(result.ok, true);
  if (result.ok) {
    // Audit facts: the rewrite pins old -> new SHA.
    assert.deepEqual(result.leasePush, { oldSha: remoteSha, newSha: localSha });
  }
  assert.equal(git(remote, "rev-parse", branch), localSha, "the lease push must publish the local tip");
  assert.equal(
    git(dev.path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"),
    `origin/${branch}`,
    "the lease retry must set upstream tracking like the plain push"
  );

  fs.rmSync(dev.path, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
  await withRepoLock(repo, async () => execFileSync("git", ["worktree", "prune"], { cwd: repo }));
  execFileSync("git", ["branch", "-D", branch], { cwd: repo });
});

test("NOT-220: remote tip past the last known head keeps today's escalation — no force push attempted", async () => {
  const branch = "issue-push-lease-moved";
  const dev = await createRoleWorktree({
    repo,
    role: "developer",
    sessionId: "s-dev-push-lease-moved",
    ref: "main",
    newBranch: branch,
  });
  fs.writeFileSync(path.join(dev.path, "base.txt"), "base\n");
  git(dev.path, "add", ".");
  git(dev.path, "commit", "-m", "base");
  const base = git(dev.path, "rev-parse", "HEAD");
  assert.deepEqual(await pushBranch({ worktreePath: dev.path, branch }), { ok: true });

  const other = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-wt-lease-moved-"));
  execFileSync("git", ["clone", "-q", remote, other]);
  git(other, "checkout", branch);
  git(other, "config", "user.email", "test@example.com");
  git(other, "config", "user.name", "Test");
  fs.writeFileSync(path.join(other, "r1.txt"), "r1\n");
  git(other, "add", ".");
  git(other, "commit", "-m", "remote1");
  git(other, "push", "origin", branch);
  const knownHead = git(other, "rev-parse", "HEAD");
  // Someone else pushes after Dealer's last known head.
  fs.writeFileSync(path.join(other, "r2.txt"), "r2\n");
  git(other, "add", ".");
  git(other, "commit", "-m", "remote2");
  git(other, "push", "origin", branch);
  const movedSha = git(other, "rev-parse", "HEAD");

  // Local diverges with genuinely different content.
  git(dev.path, "fetch", "origin", branch);
  git(dev.path, "reset", "--hard", base);
  fs.writeFileSync(path.join(dev.path, "local.txt"), "local\n");
  git(dev.path, "add", ".");
  git(dev.path, "commit", "-m", "local");

  const result = await pushBranch({ worktreePath: dev.path, branch, lastKnownHeadSha: knownHead });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.rejected, true);
    assert.ok(result.facts);
    assert.equal(result.facts.relationship, "diverged");
    assert.equal(result.facts.remoteSha, movedSha);
  }
  assert.equal(
    git(remote, "rev-parse", branch),
    movedSha,
    "no force push may run once the remote moved past the known head"
  );

  fs.rmSync(dev.path, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
  await withRepoLock(repo, async () => execFileSync("git", ["worktree", "prune"], { cwd: repo }));
  execFileSync("git", ["branch", "-D", branch], { cwd: repo });
});

test("NOT-220: a remote-only commit with different content escalates — no force push attempted", async () => {
  const branch = "issue-push-lease-content";
  const dev = await createRoleWorktree({
    repo,
    role: "developer",
    sessionId: "s-dev-push-lease-content",
    ref: "main",
    newBranch: branch,
  });
  fs.writeFileSync(path.join(dev.path, "base.txt"), "base\n");
  git(dev.path, "add", ".");
  git(dev.path, "commit", "-m", "base");
  const base = git(dev.path, "rev-parse", "HEAD");
  assert.deepEqual(await pushBranch({ worktreePath: dev.path, branch }), { ok: true });

  const other = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-wt-lease-content-"));
  execFileSync("git", ["clone", "-q", remote, other]);
  git(other, "checkout", branch);
  git(other, "config", "user.email", "test@example.com");
  git(other, "config", "user.name", "Test");
  fs.writeFileSync(path.join(other, "remote.txt"), "remote work\n");
  git(other, "add", ".");
  git(other, "commit", "-m", "remote-only");
  git(other, "push", "origin", branch);
  const remoteSha = git(other, "rev-parse", "HEAD");

  // Local diverges with content that matches nothing on the remote.
  git(dev.path, "fetch", "origin", branch);
  git(dev.path, "reset", "--hard", base);
  fs.writeFileSync(path.join(dev.path, "local.txt"), "local work\n");
  git(dev.path, "add", ".");
  git(dev.path, "commit", "-m", "local-only");

  const result = await pushBranch({ worktreePath: dev.path, branch, lastKnownHeadSha: remoteSha });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.rejected, true);
    assert.ok(result.facts);
    assert.equal(result.facts.relationship, "diverged");
    assert.equal(result.facts.remoteSha, remoteSha);
  }
  assert.equal(
    git(remote, "rev-parse", branch),
    remoteSha,
    "a remote-only commit without a local equivalent must never be overwritten"
  );

  fs.rmSync(dev.path, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
  await withRepoLock(repo, async () => execFileSync("git", ["worktree", "prune"], { cwd: repo }));
  execFileSync("git", ["branch", "-D", branch], { cwd: repo });
});

test("NOT-220: a lease pin for a SHA origin has left behind fails instead of overwriting — the race escalates", async () => {
  const branch = "issue-push-lease-race";
  const dev = await createRoleWorktree({
    repo,
    role: "developer",
    sessionId: "s-dev-push-lease-race",
    ref: "main",
    newBranch: branch,
  });
  fs.writeFileSync(path.join(dev.path, "base.txt"), "base\n");
  git(dev.path, "add", ".");
  git(dev.path, "commit", "-m", "base");
  const base = git(dev.path, "rev-parse", "HEAD");
  assert.deepEqual(await pushBranch({ worktreePath: dev.path, branch }), { ok: true });

  const other = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-wt-lease-race-"));
  execFileSync("git", ["clone", "-q", remote, other]);
  git(other, "checkout", branch);
  git(other, "config", "user.email", "test@example.com");
  git(other, "config", "user.name", "Test");
  commitFileAs(other, "r1.txt", "r1\n", "remote1", PAST_DATES);
  git(other, "push", "origin", branch);
  const knownHead = git(other, "rev-parse", "HEAD");

  // Local rebuild, patch-equivalent to the remote tip plus new work — eligible for now.
  git(dev.path, "fetch", "origin", branch);
  git(dev.path, "reset", "--hard", base);
  git(dev.path, "cherry-pick", knownHead);
  fs.writeFileSync(path.join(dev.path, "new.txt"), "new\n");
  git(dev.path, "add", ".");
  git(dev.path, "commit", "-m", "new work");

  // Capture the fetched tip via a plain rejection (no known head, so no retry) …
  const stale = await pushBranch({ worktreePath: dev.path, branch });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.facts?.remoteSha, knownHead);

  // … then origin moves before the lease push runs: the stale pin must fail.
  fs.writeFileSync(path.join(other, "r2.txt"), "r2\n");
  git(other, "add", ".");
  git(other, "commit", "-m", "remote2");
  git(other, "push", "origin", branch);
  const movedSha = git(other, "rev-parse", "HEAD");

  const raced = await pushWithLease({
    cwd: dev.path,
    branch,
    localRef: "HEAD",
    expectedRemoteSha: knownHead,
  });
  assert.equal(raced.ok, false, "a lease pinned to a superseded SHA must fail");
  assert.equal(
    git(remote, "rev-parse", branch),
    movedSha,
    "the stale lease must not overwrite the new tip"
  );

  // And the full path now escalates against the fresh tip instead of force-pushing.
  const escalated = await pushBranch({ worktreePath: dev.path, branch, lastKnownHeadSha: knownHead });
  assert.equal(escalated.ok, false);
  if (!escalated.ok) {
    assert.equal(escalated.rejected, true);
    assert.equal(escalated.facts?.remoteSha, movedSha);
  }
  assert.equal(git(remote, "rev-parse", branch), movedSha);

  fs.rmSync(dev.path, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
  await withRepoLock(repo, async () => execFileSync("git", ["worktree", "prune"], { cwd: repo }));
  execFileSync("git", ["branch", "-D", branch], { cwd: repo });
});

test("NOT-220: a remote-only merge commit is never lease-pushed even when cherry proves its side equivalent", async () => {
  // `git cherry` never lists merge commits, so cherry alone would approve this range
  // (the side commit is patch-equivalent locally) while saying nothing about the merge
  // itself — a GitHub-style 'Update branch' merge must keep today's escalation.
  const branch = "issue-push-lease-merge";
  const dev = await createRoleWorktree({
    repo,
    role: "developer",
    sessionId: "s-dev-push-lease-merge",
    ref: "main",
    newBranch: branch,
  });
  fs.writeFileSync(path.join(dev.path, "app.txt"), "v1\n");
  git(dev.path, "add", ".");
  git(dev.path, "commit", "-m", "base");
  const base = git(dev.path, "rev-parse", "HEAD");
  assert.deepEqual(await pushBranch({ worktreePath: dev.path, branch }), { ok: true });

  // Local rebuilds the same change directly on the branch.
  git(dev.path, "reset", "--hard", base);
  fs.writeFileSync(path.join(dev.path, "app.txt"), "v1\npatched\n");
  git(dev.path, "add", ".");
  git(dev.path, "commit", "-m", "patch app");

  // Remote carries the identical patch on a side branch, merged with --no-ff.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-wt-lease-merge-"));
  execFileSync("git", ["clone", "-q", remote, other]);
  git(other, "checkout", branch);
  git(other, "config", "user.email", "test@example.com");
  git(other, "config", "user.name", "Test");
  git(other, "checkout", "-b", "side");
  fs.writeFileSync(path.join(other, "app.txt"), "v1\npatched\n");
  git(other, "add", ".");
  git(other, "commit", "-m", "patch app on side");
  git(other, "checkout", branch);
  git(other, "merge", "--no-ff", "-m", "merge side", "side");
  git(other, "push", "origin", branch);
  const mergeSha = git(other, "rev-parse", "HEAD");

  const result = await pushBranch({ worktreePath: dev.path, branch, lastKnownHeadSha: mergeSha });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.rejected, true);
    assert.ok(result.facts);
    assert.equal(result.facts.relationship, "diverged");
    assert.equal(result.facts.remoteSha, mergeSha);
  }
  assert.equal(
    git(remote, "rev-parse", branch),
    mergeSha,
    "a remote-only merge commit must never be lease-overwritten"
  );

  fs.rmSync(dev.path, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
  await withRepoLock(repo, async () => execFileSync("git", ["worktree", "prune"], { cwd: repo }));
  execFileSync("git", ["branch", "-D", branch], { cwd: repo });
});

test("NOT-220: a remote-only range of pure merges (empty cherry output) proves nothing and escalates", async () => {
  // Both sides merged the same upstream tip and got different merge SHAs: the only
  // remote-only commit is the remote merge itself, so `git cherry` prints nothing —
  // an empty output must not count as "all equivalent".
  const branch = "issue-push-lease-merges";
  const dev = await createRoleWorktree({
    repo,
    role: "developer",
    sessionId: "s-dev-push-lease-merges",
    ref: "main",
    newBranch: branch,
  });
  fs.writeFileSync(path.join(dev.path, "base.txt"), "base\n");
  git(dev.path, "add", ".");
  git(dev.path, "commit", "-m", "base");
  assert.deepEqual(await pushBranch({ worktreePath: dev.path, branch }), { ok: true });

  // A shared upstream commit both sides will merge.
  git(repo, "checkout", "-q", "main");
  fs.writeFileSync(path.join(repo, "upstream.txt"), "upstream\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "upstream");
  git(repo, "push", "-q", "origin", "main");

  const other = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-wt-lease-merges-"));
  execFileSync("git", ["clone", "-q", remote, other]);
  git(other, "checkout", branch);
  git(other, "config", "user.email", "test@example.com");
  git(other, "config", "user.name", "Test");
  git(other, "fetch", "origin", "main");
  // Past dates: the local merge below (made "now") must get a different merge SHA.
  gitEnv(other, PAST_DATES, "merge", "--no-ff", "-m", "merge main", "origin/main");
  git(other, "push", "origin", branch);
  const mergeSha = git(other, "rev-parse", "HEAD");

  // Local merges the same upstream tip — same content, different merge SHA.
  git(dev.path, "fetch", "origin", "main");
  git(dev.path, "fetch", "origin", branch);
  git(dev.path, "merge", "--no-ff", "-m", "merge main", "origin/main");

  const result = await pushBranch({ worktreePath: dev.path, branch, lastKnownHeadSha: mergeSha });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.rejected, true);
    assert.ok(result.facts);
    assert.equal(result.facts.relationship, "diverged");
    assert.equal(result.facts.remoteSha, mergeSha);
  }
  assert.equal(
    git(remote, "rev-parse", branch),
    mergeSha,
    "an unproven merge-only range must never be lease-overwritten"
  );

  fs.rmSync(dev.path, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
  await withRepoLock(repo, async () => execFileSync("git", ["worktree", "prune"], { cwd: repo }));
  execFileSync("git", ["branch", "-D", branch], { cwd: repo });
});

test("inspectLeftoverWorktree classifies missing / clean / dirty", async () => {
  assert.equal(await inspectLeftoverWorktree("/no/such/path"), "missing");
  const dev = await createRoleWorktree({ repo, role: "developer", sessionId: "s-dev4", ref: "issue-1" });
  assert.equal(await inspectLeftoverWorktree(dev.path), "clean");
  fs.writeFileSync(path.join(dev.path, "x.txt"), "y");
  assert.equal(await inspectLeftoverWorktree(dev.path), "dirty_or_unpushed");
  fs.rmSync(dev.path, { recursive: true, force: true });
  await withRepoLock(repo, async () => execFileSync("git", ["worktree", "prune"], { cwd: repo }));
});

test("findWorktreeForBranch finds the checkout holding a branch and returns null for an untouched one", async () => {
  assert.equal(await findWorktreeForBranch(repo, "issue-1"), null);
  const dev = await createRoleWorktree({ repo, role: "developer", sessionId: "s-find1", ref: "issue-1" });
  assert.equal(await findWorktreeForBranch(repo, "issue-1"), dev.path);
  // A detached (reviewer) checkout carries no `branch` line and must never match.
  const rev = await createRoleWorktree({ repo, role: "reviewer", sessionId: "s-find2", ref: "HEAD" });
  assert.equal(await findWorktreeForBranch(repo, "issue-1"), dev.path);
  await safeRemoveWorktree({ repo, path: rev.path, role: "reviewer" });
  fs.rmSync(dev.path, { recursive: true, force: true });
  await withRepoLock(repo, async () => execFileSync("git", ["worktree", "prune"], { cwd: repo }));
});

test("resolveDeveloperWorktree creates a fresh worktree when the branch isn't checked out anywhere", async () => {
  const resolved = await resolveDeveloperWorktree({
    repo,
    sessionId: "s-resolve-new",
    branchName: "issue-resolve-new",
    baseBranch: "main",
    reuseBranch: false,
  });
  assert.equal(resolved.kind, "created");
  assert.ok(fs.existsSync(resolved.path));
  fs.rmSync(resolved.path, { recursive: true, force: true });
  await withRepoLock(repo, async () => execFileSync("git", ["worktree", "prune"], { cwd: repo }));
  execFileSync("git", ["branch", "-D", "issue-resolve-new"], { cwd: repo });
});

test("resolveDeveloperWorktree reuses a clean leftover worktree from an earlier session on the same branch", async () => {
  // Simulates the exact NOT-88 repro: an earlier round's `createRoleWorktree` (keyed by its
  // OLD sessionId) is still on disk, clean, holding the branch — a plain `git worktree add`
  // for a NEW session id would collide with it ("already used by worktree").
  const leftover = await createRoleWorktree({ repo, role: "developer", sessionId: "s-leftover-clean", ref: "issue-1" });
  const resolved = await resolveDeveloperWorktree({
    repo,
    sessionId: "s-new-session",
    branchName: "issue-1",
    baseBranch: "main",
    reuseBranch: true,
  });
  assert.equal(resolved.kind, "reused");
  assert.equal(resolved.path, leftover.path);
  fs.rmSync(leftover.path, { recursive: true, force: true });
  await withRepoLock(repo, async () => execFileSync("git", ["worktree", "prune"], { cwd: repo }));
});

test("resolveDeveloperWorktree reports a conflict — with recovery commands — for a dirty leftover, never force-removing it", async () => {
  const leftover = await createRoleWorktree({ repo, role: "developer", sessionId: "s-leftover-dirty", ref: "issue-1" });
  fs.writeFileSync(path.join(leftover.path, "uncommitted.txt"), "still here\n");

  const resolved = await resolveDeveloperWorktree({
    repo,
    sessionId: "s-new-session-2",
    branchName: "issue-1",
    baseBranch: "main",
    reuseBranch: true,
  });
  assert.equal(resolved.kind, "conflict");
  if (resolved.kind === "conflict") {
    assert.equal(resolved.path, leftover.path);
    assert.match(resolved.reason, /uncommitted changes/);
    assert.ok(resolved.recoveryCommands.some((c) => c.includes(leftover.path)));
  }
  assert.ok(fs.existsSync(leftover.path), "a dirty leftover must never be force-removed by resolution");

  // Calling it again with nothing changed must report the SAME conflict, not loop into a
  // different failure mode or silently clear it — this is what breaks the "Resume loops"
  // bug into an actionable, stable escalation instead of a fresh crash each time.
  const resolvedAgain = await resolveDeveloperWorktree({
    repo,
    sessionId: "s-new-session-3",
    branchName: "issue-1",
    baseBranch: "main",
    reuseBranch: true,
  });
  assert.equal(resolvedAgain.kind, "conflict");
  if (resolvedAgain.kind === "conflict") assert.equal(resolvedAgain.path, leftover.path);

  fs.rmSync(leftover.path, { recursive: true, force: true });
  await withRepoLock(repo, async () => execFileSync("git", ["worktree", "prune"], { cwd: repo }));
});

test("resolveDeveloperWorktree prunes a stale (directory-deleted) leftover and creates a fresh worktree", async () => {
  const leftover = await createRoleWorktree({ repo, role: "developer", sessionId: "s-leftover-stale", ref: "issue-1" });
  // Delete the directory directly, bypassing `git worktree remove` — leaves a stale
  // administrative entry in `.git/worktrees` that `git worktree list` still reports.
  fs.rmSync(leftover.path, { recursive: true, force: true });

  const resolved = await resolveDeveloperWorktree({
    repo,
    sessionId: "s-new-session-4",
    branchName: "issue-1",
    baseBranch: "main",
    reuseBranch: true,
  });
  assert.equal(resolved.kind, "created");
  assert.ok(fs.existsSync(resolved.path));
  fs.rmSync(resolved.path, { recursive: true, force: true });
  await withRepoLock(repo, async () => execFileSync("git", ["worktree", "prune"], { cwd: repo }));
});

test("resolveDeveloperWorktree treats an on-disk leftover whose git status can't be read as a conflict, never as a safe-to-recreate stale entry", async () => {
  // A review round found: inspectLeftoverWorktree maps ANY `git status` failure to
  // "missing" — including a leftover that is very much still on disk but whose checkout is
  // corrupt/unreadable for some other reason. Treating that as a harmless stale entry would
  // prune (a no-op, since the directory IS there) and fall through to `addWorktree`, which
  // collides identically with the still-registered worktree — a narrower repeat of the exact
  // loop this function exists to close.
  const leftover = await createRoleWorktree({ repo, role: "developer", sessionId: "s-leftover-corrupt", ref: "issue-1" });
  // Overwriting (not deleting) the worktree's `.git` file pointer keeps `git worktree
  // prune` from reclaiming the entry (its own liveness check passes — the file exists) while
  // `git status` inside the worktree now fails outright, reproducing "still registered and
  // on disk, but status unreadable" without deleting anything prune itself would notice.
  fs.writeFileSync(path.join(leftover.path, ".git"), "gitdir: /nonexistent/path/that/does/not/exist\n");
  assert.equal(await inspectLeftoverWorktree(leftover.path), "missing", "sanity: a broken .git link reports as 'missing' too, not just a deleted directory");

  const resolved = await resolveDeveloperWorktree({
    repo,
    sessionId: "s-new-session-5",
    branchName: "issue-1",
    baseBranch: "main",
    reuseBranch: true,
  });
  assert.equal(resolved.kind, "conflict");
  if (resolved.kind === "conflict") {
    assert.equal(resolved.path, leftover.path);
    assert.match(resolved.reason, /could not be determined/);
  }
  assert.ok(fs.existsSync(leftover.path), "never removed out from under an undetermined leftover");

  fs.rmSync(leftover.path, { recursive: true, force: true });
  await withRepoLock(repo, async () => execFileSync("git", ["worktree", "prune"], { cwd: repo }));
});

test("resolveDeveloperWorktree reports a conflict for a branch checked out outside the coordinator's managed worktrees, without touching it", async () => {
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-wt-external-"));
  execFileSync("git", ["worktree", "add", external, "issue-1"], { cwd: repo });
  try {
    const resolved = await resolveDeveloperWorktree({
      repo,
      sessionId: "s-new-session-external",
      branchName: "issue-1",
      baseBranch: "main",
      reuseBranch: true,
    });
    assert.equal(resolved.kind, "conflict");
    if (resolved.kind === "conflict") {
      assert.equal(fs.realpathSync(resolved.path), fs.realpathSync(external));
      assert.match(resolved.reason, /outside the coordinator/);
    }
    assert.ok(fs.existsSync(external), "an externally managed worktree must never be touched or removed");
  } finally {
    execFileSync("git", ["worktree", "remove", "--force", external], { cwd: repo });
  }
});

// ---------------------------------------------------------------- NOT-127: owner liveness

test("NOT-127: resolveDeveloperWorktree never adopts a leftover whose owning session is still live (clean or dirty)", async () => {
  const leftover = await createRoleWorktree({ repo, role: "developer", sessionId: "s-live-owner", ref: "issue-1" });
  // Clean leftover — pre-NOT-127 this would have been silently reused.
  const clean = await resolveDeveloperWorktree({
    repo,
    sessionId: "s-new-live-clean",
    branchName: "issue-1",
    baseBranch: "main",
    reuseBranch: true,
    ownerLiveness: () => ({ state: "alive", sessionId: "s-live-owner" }),
  });
  assert.equal(clean.kind, "live_owner");
  if (clean.kind === "live_owner") {
    assert.equal(clean.path, leftover.path);
    assert.equal(clean.ownerSessionId, "s-live-owner");
    assert.match(clean.reason, /live process/);
  }

  // Dirty leftover — pre-NOT-127 this would have escalated as worktree_conflict.
  fs.writeFileSync(path.join(leftover.path, "wip.txt"), "owner still typing\n");
  const dirty = await resolveDeveloperWorktree({
    repo,
    sessionId: "s-new-live-dirty",
    branchName: "issue-1",
    baseBranch: "main",
    reuseBranch: true,
    ownerLiveness: () => ({ state: "alive", sessionId: "s-live-owner" }),
  });
  assert.equal(dirty.kind, "live_owner");
  if (dirty.kind === "live_owner") assert.equal(dirty.path, leftover.path);
  assert.ok(fs.existsSync(leftover.path), "live owner's worktree must never be removed");

  fs.rmSync(leftover.path, { recursive: true, force: true });
  await withRepoLock(repo, async () => execFileSync("git", ["worktree", "prune"], { cwd: repo }));
});

test("NOT-127: resolveDeveloperWorktree still reuses a clean leftover when the owning session is dead", async () => {
  const leftover = await createRoleWorktree({ repo, role: "developer", sessionId: "s-dead-clean", ref: "issue-1" });
  const resolved = await resolveDeveloperWorktree({
    repo,
    sessionId: "s-new-dead-clean",
    branchName: "issue-1",
    baseBranch: "main",
    reuseBranch: true,
    ownerLiveness: () => ({ state: "dead" }),
  });
  assert.equal(resolved.kind, "reused");
  assert.equal(resolved.path, leftover.path);
  fs.rmSync(leftover.path, { recursive: true, force: true });
  await withRepoLock(repo, async () => execFileSync("git", ["worktree", "prune"], { cwd: repo }));
});

test("NOT-127: resolveDeveloperWorktree still escalates a dirty leftover when the owning session is dead", async () => {
  const leftover = await createRoleWorktree({ repo, role: "developer", sessionId: "s-dead-dirty", ref: "issue-1" });
  fs.writeFileSync(path.join(leftover.path, "abandoned.txt"), "orphan dirt\n");
  const resolved = await resolveDeveloperWorktree({
    repo,
    sessionId: "s-new-dead-dirty",
    branchName: "issue-1",
    baseBranch: "main",
    reuseBranch: true,
    ownerLiveness: () => ({ state: "dead" }),
  });
  assert.equal(resolved.kind, "conflict");
  if (resolved.kind === "conflict") {
    assert.equal(resolved.path, leftover.path);
    assert.match(resolved.reason, /uncommitted changes/);
  }
  assert.ok(fs.existsSync(leftover.path), "dead-and-dirty leftover must still never be force-removed");
  fs.rmSync(leftover.path, { recursive: true, force: true });
  await withRepoLock(repo, async () => execFileSync("git", ["worktree", "prune"], { cwd: repo }));
});

// ---------------------------------------------------------------- NOT-197: fresh base

/** An isolated repo + file remote pair, so tests can move or break origin without
 * touching the module-level fixture every other test shares. */
function makeIsoRepoPair(tag: string): { isoRepo: string; isoRemote: string } {
  const isoRepo = fs.mkdtempSync(path.join(os.tmpdir(), `dealer-wt197-repo-${tag}-`));
  git(isoRepo, "init", "-b", "main");
  git(isoRepo, "config", "user.email", "test@example.com");
  git(isoRepo, "config", "user.name", "Test");
  fs.writeFileSync(path.join(isoRepo, "README.md"), "hello\n");
  git(isoRepo, "add", ".");
  git(isoRepo, "commit", "-m", "init");
  const isoRemote = fs.mkdtempSync(path.join(os.tmpdir(), `dealer-wt197-remote-${tag}-`));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", isoRemote]);
  git(isoRepo, "remote", "add", "origin", isoRemote);
  git(isoRepo, "push", "-q", "origin", "main");
  return { isoRepo, isoRemote };
}

/** Advance origin/main from a separate clone so the repo's own local main stays stale. */
function advanceOriginMain(isoRemote: string, file: string): string {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-wt197-other-"));
  try {
    execFileSync("git", ["clone", "-q", isoRemote, other]);
    git(other, "config", "user.email", "test@example.com");
    git(other, "config", "user.name", "Test");
    fs.writeFileSync(path.join(other, file), "upstream\n");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "upstream change");
    git(other, "push", "-q", "origin", "main");
    return git(other, "rev-parse", "HEAD");
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
}

async function removeIsoWorktree(isoRepo: string, worktreePath: string, branch: string): Promise<void> {
  fs.rmSync(worktreePath, { recursive: true, force: true });
  await withRepoLock(isoRepo, async () => execFileSync("git", ["worktree", "prune"], { cwd: isoRepo }));
  execFileSync("git", ["branch", "-D", branch], { cwd: isoRepo });
}

test("NOT-197: a fresh developer branch starts from the fetched origin/<base>, not the stale local base", async () => {
  const { isoRepo, isoRemote } = makeIsoRepoPair("fresh");
  try {
    const staleLocalMain = git(isoRepo, "rev-parse", "main");
    const originTip = advanceOriginMain(isoRemote, "upstream-change.txt");
    assert.notEqual(staleLocalMain, originTip, "the local main must lag origin/main for this test to mean anything");
    assert.equal(git(isoRepo, "rev-parse", "main"), staleLocalMain, "advancing origin must not move the local main");

    const resolved = await resolveDeveloperWorktree({
      repo: isoRepo,
      sessionId: "s-fresh-base",
      branchName: "issue-fresh-base",
      baseBranch: "main",
      reuseBranch: false,
    });
    assert.equal(resolved.kind, "created");
    if (resolved.kind !== "created") return;
    assert.equal(resolved.baseSha, originTip, "the recorded base must be the fetched origin/main tip");
    assert.equal(resolved.baseRef, "origin/main");
    assert.equal(
      git(isoRepo, "rev-parse", "issue-fresh-base"),
      originTip,
      "the new branch must start exactly at the origin/main tip, not the stale local main"
    );
    assert.equal(git(isoRepo, "rev-parse", "main"), staleLocalMain, "the stale local base itself is left untouched");
    await removeIsoWorktree(isoRepo, resolved.path, "issue-fresh-base");
  } finally {
    fs.rmSync(isoRepo, { recursive: true, force: true });
    fs.rmSync(isoRemote, { recursive: true, force: true });
  }
});

test("NOT-197: a failed pre-branch fetch returns base_unavailable and creates no branch", async () => {
  const { isoRepo, isoRemote } = makeIsoRepoPair("fail");
  try {
    git(isoRepo, "remote", "set-url", "origin", path.join(isoRemote, "does-not-exist.git"));

    const resolved = await resolveDeveloperWorktree({
      repo: isoRepo,
      sessionId: "s-fetch-fail",
      branchName: "issue-no-base",
      baseBranch: "main",
      reuseBranch: false,
    });
    assert.equal(resolved.kind, "base_unavailable");
    if (resolved.kind === "base_unavailable") assert.match(resolved.reason, /fetch/i);
    assert.equal(
      await branchExists(isoRepo, "issue-no-base"),
      false,
      "a failed fetch must never fall back to cutting the branch from the stale local base"
    );
  } finally {
    fs.rmSync(isoRepo, { recursive: true, force: true });
    fs.rmSync(isoRemote, { recursive: true, force: true });
  }
});

test("NOT-219: the reuse path fetches origin/<branch> first — a failed fetch defers instead of checking out the stale local branch", async () => {
  // Supersedes the NOT-197 expectation that reuse never fetches: starting a repair
  // round from the stale local ref is exactly the false-divergence bug (NOT-219), so
  // a failed fetch returns base_unavailable like the fresh-branch path does.
  const { isoRepo, isoRemote } = makeIsoRepoPair("reuse");
  try {
    git(isoRepo, "branch", "issue-reuse-219");
    // Break origin so thoroughly that any fetch attempt would fail.
    git(isoRepo, "remote", "set-url", "origin", path.join(isoRemote, "does-not-exist.git"));
    const broken = await fetchFreshBase(isoRepo, "main");
    assert.equal(broken.ok, false, "sanity: a fetch against this origin really does fail");

    const before = git(isoRepo, "rev-parse", "issue-reuse-219");
    const leftover = await createRoleWorktree({ repo: isoRepo, role: "developer", sessionId: "s-reuse-left", ref: "issue-reuse-219" });
    const resolved = await resolveDeveloperWorktree({
      repo: isoRepo,
      sessionId: "s-reuse-new",
      branchName: "issue-reuse-219",
      baseBranch: "main",
      reuseBranch: true,
    });
    assert.equal(resolved.kind, "base_unavailable");
    if (resolved.kind === "base_unavailable") assert.match(resolved.reason, /fetch/i);
    assert.equal(git(isoRepo, "rev-parse", "issue-reuse-219"), before, "a deferred start must not move the local branch");
    assert.ok(fs.existsSync(leftover.path), "a deferred start must not touch the leftover worktree");
    assert.ok(!fs.existsSync(path.join(worktreesRoot(isoRepo), "s-reuse-new-developer")), "no worktree may be created for a deferred start");
    fs.rmSync(leftover.path, { recursive: true, force: true });
    await withRepoLock(isoRepo, async () => execFileSync("git", ["worktree", "prune"], { cwd: isoRepo }));
    execFileSync("git", ["branch", "-D", "issue-reuse-219"], { cwd: isoRepo });
  } finally {
    fs.rmSync(isoRepo, { recursive: true, force: true });
    fs.rmSync(isoRemote, { recursive: true, force: true });
  }
});

test("NOT-197: fetchFreshBase bounds a hanging fetch with a timeout instead of hanging", async () => {
  const { isoRepo, isoRemote } = makeIsoRepoPair("timeout");
  try {
    // An ssh remote whose "ssh" is a script that sleeps: the fetch can only end when our
    // timeout kills it, so this deterministically exercises the timeout classification.
    const sleeper = path.join(isoRepo, "fake-ssh.sh");
    fs.writeFileSync(sleeper, "#!/bin/sh\nsleep 30\n");
    fs.chmodSync(sleeper, 0o755);
    git(isoRepo, "remote", "set-url", "origin", "ssh://git@example.invalid/repo.git");
    git(isoRepo, "config", "core.sshCommand", sleeper);

    const startedAt = Date.now();
    const result = await fetchFreshBase(isoRepo, "main", 1000);
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /timed out/);
    assert.ok(elapsedMs < 20_000, `the fetch must be bounded (took ${elapsedMs}ms)`);
  } finally {
    fs.rmSync(isoRepo, { recursive: true, force: true });
    fs.rmSync(isoRemote, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- NOT-219: repair from the pushed tip

/** Push commit(s) to origin/<branch> from a separate clone, leaving the repo's own
 * local branch ref stale — the NOT-219 round-1 shape (Dealer pushed HEAD to
 * origin/<branch> while the clone's local ref stayed at its creation point). */
function advanceOriginBranch(isoRemote: string, branch: string, files: string[]): string {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-wt219-other-"));
  try {
    execFileSync("git", ["clone", "-q", isoRemote, other]);
    git(other, "config", "user.email", "test@example.com");
    git(other, "config", "user.name", "Test");
    git(other, "checkout", "-q", branch);
    for (const file of files) {
      fs.writeFileSync(path.join(other, file), "remote work\n");
    }
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "round-1 work");
    git(other, "push", "-q", "origin", branch);
    return git(other, "rev-parse", "HEAD");
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
}

/** Commit on the repo's own local branch without pushing — a local-only tip. */
function commitLocally(isoRepo: string, branch: string, file: string): string {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-wt219-local-"));
  try {
    execFileSync("git", ["worktree", "add", "-q", wt, branch], { cwd: isoRepo });
    fs.writeFileSync(path.join(wt, file), "local work\n");
    git(wt, "add", ".");
    git(wt, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "local work");
    return git(wt, "rev-parse", "HEAD");
  } finally {
    execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: isoRepo });
  }
}

test("NOT-219: a repair round starts at the pushed origin/<branch> tip, not the stale local branch", async () => {
  const { isoRepo, isoRemote } = makeIsoRepoPair("219repair");
  try {
    const base = git(isoRepo, "rev-parse", "main");
    git(isoRepo, "branch", "issue-219-repair", base);
    git(isoRepo, "push", "-q", "origin", "issue-219-repair");
    // Round 1's commits land on the remote while the clone's local ref stays at base.
    const pushedTip = advanceOriginBranch(isoRemote, "issue-219-repair", ["round1-a.txt", "round1-b.txt"]);
    assert.equal(git(isoRepo, "rev-parse", "issue-219-repair"), base, "the local ref must stay stale for this test to mean anything");

    const resolved = await resolveDeveloperWorktree({
      repo: isoRepo,
      sessionId: "s-219-repair",
      branchName: "issue-219-repair",
      baseBranch: "main",
      reuseBranch: true,
    });
    assert.equal(resolved.kind, "created");
    if (resolved.kind !== "created") return;
    const head = git(resolved.path, "rev-parse", "HEAD");
    assert.equal(head, pushedTip, "the repair worktree must start at the pushed tip, not the stale base");
    assert.equal(
      git(resolved.path, "rev-list", "--count", "origin/issue-219-repair..HEAD"),
      "0"
    );
    assert.equal(
      git(isoRepo, "rev-parse", "issue-219-repair"),
      pushedTip,
      "the stale local ref is advanced to the pushed tip"
    );
    await removeIsoWorktree(isoRepo, resolved.path, "issue-219-repair");
  } finally {
    fs.rmSync(isoRepo, { recursive: true, force: true });
    fs.rmSync(isoRemote, { recursive: true, force: true });
  }
});

test("NOT-219: a repair round cuts the local branch at the pushed tip when the clone has no local ref for it", async () => {
  // The exact incident shape: round 1 committed on a side branch, so the local
  // issue branch was never even created — only origin/<branch> (what Dealer pushed)
  // knows the tip.
  const { isoRepo, isoRemote } = makeIsoRepoPair("219nolocal");
  try {
    const base = git(isoRepo, "rev-parse", "main");
    const seeder = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-wt219-seed-"));
    let pushedTip: string;
    try {
      execFileSync("git", ["clone", "-q", isoRemote, seeder]);
      git(seeder, "config", "user.email", "test@example.com");
      git(seeder, "config", "user.name", "Test");
      git(seeder, "checkout", "-q", "-b", "issue-219-nolocal", base);
      fs.writeFileSync(path.join(seeder, "round1.txt"), "round-1 work\n");
      git(seeder, "add", ".");
      git(seeder, "commit", "-q", "-m", "round-1 work");
      git(seeder, "push", "-q", "origin", "issue-219-nolocal");
      pushedTip = git(seeder, "rev-parse", "HEAD");
    } finally {
      fs.rmSync(seeder, { recursive: true, force: true });
    }
    await withRepoLock(isoRepo, async () => execFileSync("git", ["fetch", "-q", "origin"], { cwd: isoRepo }));
    assert.equal(await branchExists(isoRepo, "issue-219-nolocal"), false);

    const resolved = await resolveDeveloperWorktree({
      repo: isoRepo,
      sessionId: "s-219-nolocal",
      branchName: "issue-219-nolocal",
      baseBranch: "main",
      reuseBranch: true,
    });
    assert.equal(resolved.kind, "created");
    if (resolved.kind !== "created") return;
    assert.equal(git(resolved.path, "rev-parse", "HEAD"), pushedTip);
    assert.equal(git(resolved.path, "rev-list", "--count", "origin/issue-219-nolocal..HEAD"), "0");
    assert.equal(git(isoRepo, "rev-parse", "issue-219-nolocal"), pushedTip);
    await removeIsoWorktree(isoRepo, resolved.path, "issue-219-nolocal");
  } finally {
    fs.rmSync(isoRepo, { recursive: true, force: true });
    fs.rmSync(isoRemote, { recursive: true, force: true });
  }
});

test("NOT-219: local commits the remote lacks are preserved, never reset away", async () => {
  const { isoRepo, isoRemote } = makeIsoRepoPair("219diverged");
  try {
    const base = git(isoRepo, "rev-parse", "main");
    git(isoRepo, "branch", "issue-219-diverged", base);
    git(isoRepo, "push", "-q", "origin", "issue-219-diverged");
    // Diverge: the remote advances (round-1 push) AND the local ref carries a commit
    // the remote lacks.
    const remoteTip = advanceOriginBranch(isoRemote, "issue-219-diverged", ["remote-only.txt"]);
    const localTip = commitLocally(isoRepo, "issue-219-diverged", "local-only.txt");
    assert.notEqual(localTip, remoteTip);

    const resolved = await resolveDeveloperWorktree({
      repo: isoRepo,
      sessionId: "s-219-diverged",
      branchName: "issue-219-diverged",
      baseBranch: "main",
      reuseBranch: true,
    });
    assert.equal(resolved.kind, "created");
    if (resolved.kind !== "created") return;
    assert.equal(
      git(resolved.path, "rev-parse", "HEAD"),
      localTip,
      "the worktree must keep the local tip — its unique commits are never discarded"
    );
    assert.equal(git(isoRepo, "rev-parse", "issue-219-diverged"), localTip, "the local ref itself is untouched");
    await removeIsoWorktree(isoRepo, resolved.path, "issue-219-diverged");
  } finally {
    fs.rmSync(isoRepo, { recursive: true, force: true });
    fs.rmSync(isoRemote, { recursive: true, force: true });
  }
});

test("NOT-219: reuse with no remote branch yet checks out the local branch without deferring", async () => {
  // A same-round retry whose branch was never pushed: `git fetch origin <branch>`
  // reports "couldn't find remote ref" — that is not a network failure, so the local
  // branch is used as-is instead of deferring.
  const { isoRepo, isoRemote } = makeIsoRepoPair("219unpushed");
  try {
    git(isoRepo, "branch", "issue-219-unpushed");
    const localTip = commitLocally(isoRepo, "issue-219-unpushed", "retry-work.txt");

    const resolved = await resolveDeveloperWorktree({
      repo: isoRepo,
      sessionId: "s-219-unpushed",
      branchName: "issue-219-unpushed",
      baseBranch: "main",
      reuseBranch: true,
    });
    assert.equal(resolved.kind, "created");
    if (resolved.kind !== "created") return;
    assert.equal(git(resolved.path, "rev-parse", "HEAD"), localTip);
    await removeIsoWorktree(isoRepo, resolved.path, "issue-219-unpushed");
  } finally {
    fs.rmSync(isoRepo, { recursive: true, force: true });
    fs.rmSync(isoRemote, { recursive: true, force: true });
  }
});

test("NOT-219: a clean leftover holding the stale local branch is reused at the pushed tip", async () => {
  const { isoRepo, isoRemote } = makeIsoRepoPair("219leftover");
  try {
    const base = git(isoRepo, "rev-parse", "main");
    git(isoRepo, "branch", "issue-219-leftover", base);
    git(isoRepo, "push", "-q", "origin", "issue-219-leftover");
    const leftover = await createRoleWorktree({ repo: isoRepo, role: "developer", sessionId: "s-219-left", ref: "issue-219-leftover" });
    const pushedTip = advanceOriginBranch(isoRemote, "issue-219-leftover", ["round1.txt"]);
    assert.equal(git(leftover.path, "rev-parse", "HEAD"), base);

    const resolved = await resolveDeveloperWorktree({
      repo: isoRepo,
      sessionId: "s-219-left-new",
      branchName: "issue-219-leftover",
      baseBranch: "main",
      reuseBranch: true,
    });
    assert.equal(resolved.kind, "reused");
    if (resolved.kind !== "reused") return;
    assert.equal(resolved.path, leftover.path);
    assert.equal(git(leftover.path, "rev-parse", "HEAD"), pushedTip, "the reused leftover advances to the pushed tip");
    fs.rmSync(leftover.path, { recursive: true, force: true });
    await withRepoLock(isoRepo, async () => execFileSync("git", ["worktree", "prune"], { cwd: isoRepo }));
    execFileSync("git", ["branch", "-D", "issue-219-leftover"], { cwd: isoRepo });
  } finally {
    fs.rmSync(isoRepo, { recursive: true, force: true });
    fs.rmSync(isoRemote, { recursive: true, force: true });
  }
});

test("NOT-219: fastForwardLocalBranchToSha advances a stale ref, creates a missing one, and never discards local-only commits", async () => {
  const { fastForwardLocalBranchToSha } = await import("./git-worktree.js");
  const { isoRepo, isoRemote } = makeIsoRepoPair("219ff");
  try {
    const base = git(isoRepo, "rev-parse", "main");
    git(isoRepo, "branch", "issue-219-ff", base);
    git(isoRepo, "push", "-q", "origin", "issue-219-ff");
    const remoteTip = advanceOriginBranch(isoRemote, "issue-219-ff", ["remote.txt"]);
    // The helper classifies ancestry locally, so the pushed objects must be present
    // (in production the reuse-path fetch / the pushing worktree guarantees this).
    git(isoRepo, "fetch", "-q", "origin", "issue-219-ff");

    assert.equal(await fastForwardLocalBranchToSha({ repo: isoRepo, branch: "issue-219-ff", sha: remoteTip }), true);
    assert.equal(git(isoRepo, "rev-parse", "issue-219-ff"), remoteTip);

    // Missing local ref is created at the pushed SHA.
    execFileSync("git", ["branch", "-D", "issue-219-ff"], { cwd: isoRepo });
    assert.equal(await fastForwardLocalBranchToSha({ repo: isoRepo, branch: "issue-219-ff", sha: remoteTip }), true);
    assert.equal(git(isoRepo, "rev-parse", "issue-219-ff"), remoteTip);

    // Diverged: the local ref carries a commit the pushed SHA lacks — preserved.
    const localTip = commitLocally(isoRepo, "issue-219-ff", "local.txt");
    assert.equal(await fastForwardLocalBranchToSha({ repo: isoRepo, branch: "issue-219-ff", sha: remoteTip }), false);
    assert.equal(git(isoRepo, "rev-parse", "issue-219-ff"), localTip);
    execFileSync("git", ["branch", "-D", "issue-219-ff"], { cwd: isoRepo });
  } finally {
    fs.rmSync(isoRepo, { recursive: true, force: true });
    fs.rmSync(isoRemote, { recursive: true, force: true });
  }
});

test("NOT-197: fetchFreshBase uses the local base as-is when the repo has no origin remote", async () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-wt197-noorigin-"));
  try {
    git(bare, "init", "-b", "main");
    git(bare, "config", "user.email", "test@example.com");
    git(bare, "config", "user.name", "Test");
    fs.writeFileSync(path.join(bare, "README.md"), "hello\n");
    git(bare, "add", ".");
    git(bare, "commit", "-m", "init");

    const result = await fetchFreshBase(bare, "main");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.ref, "main");
      assert.equal(result.sha, git(bare, "rev-parse", "main"));
    }
  } finally {
    fs.rmSync(bare, { recursive: true, force: true });
  }
});
