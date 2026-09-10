// packages/server/src/adapters/git-worktree.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-wt-home-"));
process.env.AGENT_DEALER_HOME = home;

const {
  createRoleWorktree,
  safeRemoveWorktree,
  inspectLeftoverWorktree,
  isWorktreeClean,
  withRepoLock,
} = await import("./git-worktree.js");

let repo: string;

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
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
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

test("inspectLeftoverWorktree classifies missing / clean / dirty", async () => {
  assert.equal(await inspectLeftoverWorktree("/no/such/path"), "missing");
  const dev = await createRoleWorktree({ repo, role: "developer", sessionId: "s-dev4", ref: "issue-1" });
  assert.equal(await inspectLeftoverWorktree(dev.path), "clean");
  fs.writeFileSync(path.join(dev.path, "x.txt"), "y");
  assert.equal(await inspectLeftoverWorktree(dev.path), "dirty_or_unpushed");
  fs.rmSync(dev.path, { recursive: true, force: true });
  await withRepoLock(repo, async () => execFileSync("git", ["worktree", "prune"], { cwd: repo }));
});
