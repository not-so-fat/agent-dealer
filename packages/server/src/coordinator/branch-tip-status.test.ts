// packages/server/src/coordinator/branch-tip-status.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GitHubRepoIdentity } from "@agent-dealer/shared";

// Worktrees / managed clones resolve under AGENT_DEALER_HOME — set before adapters load.
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dealer-tip-home-")));
process.env.AGENT_DEALER_HOME = home;

const {
  classifyBranchTipStatus,
  branchTipStatusForIssue,
} = await import("./branch-tip-status.js");
const { managedRepoPath } = await import("../adapters/managed-repo.js");
const { createRoleWorktree } = await import("../adapters/git-worktree.js");

test("NOT-148: empty tip after a failed attempt flags restart risk", () => {
  const status = classifyBranchTipStatus({
    branch: "issue-x",
    progress: { state: "empty", branch: "issue-x" },
    hadFailedAttempt: true,
  });
  assert.equal(status.commitsAhead, 0);
  assert.equal(status.tipLabel, "no tip yet");
  assert.equal(status.restartRisk, true);
  assert.equal(status.worktree, null);
});

test("NOT-148: empty tip with no prior failure is not restart risk yet", () => {
  const status = classifyBranchTipStatus({
    branch: "issue-x",
    progress: { state: "absent", branch: "issue-x" },
    hadFailedAttempt: false,
  });
  assert.equal(status.tipLabel, "no tip yet");
  assert.equal(status.restartRisk, false);
});

test("NOT-148: tip with commits ahead is not restart risk even after failures", () => {
  const status = classifyBranchTipStatus({
    branch: "issue-x",
    progress: { state: "unpushed", branch: "issue-x", ahead: 2, unpushed: 2 },
    hadFailedAttempt: true,
  });
  assert.equal(status.commitsAhead, 2);
  assert.equal(status.tipLabel, "2 ahead");
  assert.equal(status.restartRisk, false);
});

test("NOT-148: published tip with ahead=0 (unresolved base) is not treated as empty tip", () => {
  // inspectBranchProgress can report published with ahead ?? 0 when base is unresolved.
  const status = classifyBranchTipStatus({
    branch: "issue-x",
    progress: { state: "published", branch: "issue-x", ahead: 0 },
    hadFailedAttempt: true,
  });
  assert.equal(status.state, "published");
  assert.equal(status.tipLabel, "0 ahead");
  assert.equal(status.restartRisk, false);
});

test("NOT-148: unknown progress after failure still flags restart risk conservatively", () => {
  const status = classifyBranchTipStatus({
    branch: "issue-x",
    progress: null,
    hadFailedAttempt: true,
  });
  assert.equal(status.state, "unknown");
  assert.equal(status.tipLabel, "unknown");
  assert.equal(status.restartRisk, true);
});

test("NOT-148: dirty preserved worktree hint passes through on the tip status", () => {
  const status = classifyBranchTipStatus({
    branch: "issue-x",
    progress: { state: "empty", branch: "issue-x" },
    hadFailedAttempt: true,
    worktree: { path: "/tmp/wt", dirty: true, preserved: true },
  });
  assert.deepEqual(status.worktree, { path: "/tmp/wt", dirty: true, preserved: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const identity = "github.com/acme/tip-status-fixture" as GitHubRepoIdentity;
let repo: string;
let remote: string;

before(() => {
  repo = managedRepoPath(identity);
  fs.mkdirSync(path.dirname(repo), { recursive: true });
  // Fresh clone dir each suite run under the temp home.
  if (fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "init");

  remote = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-tip-remote-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (remote) fs.rmSync(remote, { recursive: true, force: true });
});

test("NOT-148: branchTipStatusForIssue resolves managed github.com identity to local clone", async () => {
  const branch = "issue-tip-ahead";
  git(repo, "checkout", "-b", branch);
  fs.writeFileSync(path.join(repo, "feat.txt"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "feat");
  git(repo, "checkout", "main");

  const status = await branchTipStatusForIssue(
    {
      id: "tip-ahead",
      branch,
      repo: identity,
      baseBranch: "main",
      baseSha: null,
      infraAttempts: 1,
      status: "developing",
    },
    { hadFailedAttempt: true }
  );

  assert.ok(status);
  assert.equal(status!.commitsAhead, 1);
  assert.equal(status!.tipLabel, "1 ahead");
  assert.equal(status!.restartRisk, false);
  assert.equal(status!.worktree, null);
});

test("NOT-148: dirty leftover worktree (not the live session) surfaces as preserved", async () => {
  const branch = "issue-tip-dirty";
  git(repo, "branch", branch, "main");
  const wt = await createRoleWorktree({
    repo,
    role: "developer",
    sessionId: "s-dirty-tip",
    ref: branch,
  });
  fs.writeFileSync(path.join(wt.path, "wip.txt"), "uncommitted\n");

  const status = await branchTipStatusForIssue(
    {
      id: "tip-dirty",
      branch,
      repo: identity,
      baseBranch: "main",
      baseSha: null,
      infraAttempts: 1,
      status: "developing",
    },
    {
      hadFailedAttempt: true,
      activeWorktreePath: null,
    }
  );

  assert.ok(status);
  assert.ok(status!.worktree);
  assert.equal(status!.worktree!.dirty, true);
  assert.equal(status!.worktree!.preserved, true);
  assert.ok(status!.worktree!.path.includes("s-dirty-tip"));

  try {
    execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repo });
  } catch {
    fs.rmSync(wt.path, { recursive: true, force: true });
  }
});

test("NOT-148: dirty worktree owned by the live running session is not flagged as preserved", async () => {
  const branch = "issue-tip-live-dirty";
  git(repo, "branch", branch, "main");
  const wt = await createRoleWorktree({
    repo,
    role: "developer",
    sessionId: "s-live-dirty",
    ref: branch,
  });
  fs.writeFileSync(path.join(wt.path, "editing.txt"), "mid-run\n");

  const status = await branchTipStatusForIssue(
    {
      id: "tip-live",
      branch,
      repo: identity,
      baseBranch: "main",
      baseSha: null,
      infraAttempts: 0,
      status: "developing",
    },
    {
      hadFailedAttempt: false,
      activeWorktreePath: wt.path,
    }
  );

  assert.ok(status);
  assert.equal(status!.worktree, null, "live WIP must not read as salvage preserve");

  try {
    execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repo });
  } catch {
    fs.rmSync(wt.path, { recursive: true, force: true });
  }
});
