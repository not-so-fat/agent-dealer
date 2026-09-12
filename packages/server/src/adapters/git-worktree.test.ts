// packages/server/src/adapters/git-worktree.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// realpathSync: macOS's /tmp is a symlink to /private/tmp, and `git worktree list` reports
// the resolved path — without this, a path built from AGENT_DEALER_HOME would never
// string-equal what findWorktreeForBranch/resolveDeveloperWorktree read back from git.
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dealer-wt-home-")));
process.env.AGENT_DEALER_HOME = home;

const {
  createRoleWorktree,
  safeRemoveWorktree,
  inspectLeftoverWorktree,
  isWorktreeClean,
  withRepoLock,
  pushBranch,
  commitsAhead,
  findWorktreeForBranch,
  resolveDeveloperWorktree,
} = await import("./git-worktree.js");

let repo: string;
let remote: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
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

  fs.writeFileSync(path.join(dev.path, "feature2.txt"), "more\n");
  git(dev.path, "add", ".");
  git(dev.path, "commit", "-m", "feature2");
  const rejected = await pushBranch({ worktreePath: dev.path, branch: "issue-push" });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.rejected, true);

  const infra = await pushBranch({ worktreePath: "/no/such/worktree", branch: "issue-push" });
  assert.equal(infra.ok, false);
  if (!infra.ok) assert.equal(infra.rejected, false);

  fs.rmSync(dev.path, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
  await withRepoLock(repo, async () => execFileSync("git", ["worktree", "prune"], { cwd: repo }));
  execFileSync("git", ["branch", "-D", "issue-push"], { cwd: repo });
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
    assert.match(resolved.reason, /uncommitted or unpushed/);
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
