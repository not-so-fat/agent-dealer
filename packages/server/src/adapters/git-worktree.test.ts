// packages/server/src/adapters/git-worktree.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addWorktree, removeWorktree, isWorktreeClean, mergeBase, withRepoLock } from "./git-worktree.js";

const run = promisify(execFile);
let repo: string;

before(async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-git-repo-"));
  await run("git", ["init", "-b", "main", repo]);
  await run("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await run("git", ["-C", repo, "config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  await run("git", ["-C", repo, "add", "README.md"]);
  await run("git", ["-C", repo, "commit", "-m", "initial"]);
});

test("addWorktree creates a working checkout on a new branch", async () => {
  const wtPath = path.join(os.tmpdir(), `dealer-wt-${Date.now()}`);
  await addWorktree({ repo, path: wtPath, ref: "main", newBranch: "issue-1" });
  assert.ok(fs.existsSync(path.join(wtPath, "README.md")));
  await removeWorktree({ repo, path: wtPath });
});

test("addWorktree with detach checks out a detached HEAD at ref", async () => {
  const wtPath = path.join(os.tmpdir(), `dealer-wt-detached-${Date.now()}`);
  await addWorktree({ repo, path: wtPath, ref: "main", detach: true });
  const { stdout } = await run("git", ["-C", wtPath, "rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(stdout.trim(), "HEAD"); // detached HEAD reports literally "HEAD"
  await removeWorktree({ repo, path: wtPath });
});

test("isWorktreeClean reflects git status", async () => {
  const wtPath = path.join(os.tmpdir(), `dealer-wt-clean-${Date.now()}`);
  await addWorktree({ repo, path: wtPath, ref: "main", newBranch: "issue-2" });
  assert.equal(await isWorktreeClean(wtPath), true);
  fs.writeFileSync(path.join(wtPath, "new-file.txt"), "dirty\n");
  assert.equal(await isWorktreeClean(wtPath), false);
  await removeWorktree({ repo, path: wtPath, force: true });
});

test("removeWorktree without force refuses a dirty worktree", async () => {
  const wtPath = path.join(os.tmpdir(), `dealer-wt-refuse-${Date.now()}`);
  await addWorktree({ repo, path: wtPath, ref: "main", newBranch: "issue-3" });
  fs.writeFileSync(path.join(wtPath, "new-file.txt"), "dirty\n");
  await assert.rejects(() => removeWorktree({ repo, path: wtPath }));
  await removeWorktree({ repo, path: wtPath, force: true });
});

test("mergeBase returns the common ancestor SHA", async () => {
  const wtPath = path.join(os.tmpdir(), `dealer-wt-merge-${Date.now()}`);
  await addWorktree({ repo, path: wtPath, ref: "main", newBranch: "issue-4" });
  fs.writeFileSync(path.join(wtPath, "feature.txt"), "feature\n");
  await run("git", ["-C", wtPath, "add", "feature.txt"]);
  await run("git", ["-C", wtPath, "commit", "-m", "feature commit"]);
  const { stdout: mainSha } = await run("git", ["-C", repo, "rev-parse", "main"]);
  const base = await mergeBase({ repo: wtPath, base: "main", head: "issue-4" });
  assert.equal(base, mainSha.trim());
  await removeWorktree({ repo, path: wtPath, force: true });
});

test("withRepoLock serializes concurrent calls for the same repo", async () => {
  const order: number[] = [];
  const slow = (n: number) => withRepoLock(repo, async () => {
    order.push(n);
    await new Promise((r) => setTimeout(r, 10));
    order.push(-n);
  });
  await Promise.all([slow(1), slow(2), slow(3)]);
  // Each call's start (n) must be immediately followed by its own end (-n) — no interleaving.
  for (let i = 0; i < order.length; i += 2) {
    assert.equal(order[i], -order[i + 1]);
  }
});
