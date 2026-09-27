// packages/server/src/coordinator/worktree-cwd-guard.test.ts
//
// NOT-273: the developer/reviewer spawn path refuses to spawn outside a
// recognized coordinator-managed worktree — in particular the primary repo
// root itself — before any child process exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { assertWorktreeCwd, isManagedWorktreeCwd } = await import("./worktree-cwd-guard.js");
const { realDeveloperSpawn, realReviewerSpawn } = await import("./spawn.js");

const SESSION_ID = "00000000-0000-4000-8000-000000000001";

test("real worktree-shaped paths pass the guard", () => {
  // Legacy layout: <repo>/.agent-dealer-worktrees/<sessionId>-<role>.
  assert.equal(isManagedWorktreeCwd(`/repo/.agent-dealer-worktrees/${SESSION_ID}-developer`), true);
  assert.equal(isManagedWorktreeCwd(`/repo/.agent-dealer-worktrees/${SESSION_ID}-reviewer`), true);
  // Managed layout (NOT-149): <executionRoot>/worktrees/<identity>/<sessionId>-<role>.
  assert.equal(
    isManagedWorktreeCwd(`/data/execution/worktrees/github.com/acme/app/${SESSION_ID}-developer`),
    true
  );
  assert.equal(
    isManagedWorktreeCwd(`/data/execution/worktrees/github.com/acme/app/${SESSION_ID}-reviewer`),
    true
  );
  // Dev-mode equivalent under a dev data dir.
  assert.equal(
    isManagedWorktreeCwd(
      path.join(os.homedir(), ".agent-dealer-dev", "worktrees", "github.com", "acme", "app", `${SESSION_ID}-developer`)
    ),
    true
  );
  assert.doesNotThrow(() => assertWorktreeCwd(`/repo/.agent-dealer-worktrees/${SESSION_ID}-developer`));
});

test("the primary repo root and other non-worktree paths are rejected", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-guard-repo-"));
  try {
    assert.equal(isManagedWorktreeCwd(repoRoot), false, "primary repo root itself");
    assert.equal(isManagedWorktreeCwd(process.cwd()), false, "ambient process cwd");
    assert.equal(isManagedWorktreeCwd(os.tmpdir()), false, "bare temp dir");
    assert.equal(isManagedWorktreeCwd(path.join(os.tmpdir(), `${SESSION_ID}-developer`)), false, "role suffix without a worktrees parent");
    assert.equal(isManagedWorktreeCwd("/repo/.agent-dealer-worktrees"), false, "worktrees root without a session dir");
    assert.equal(isManagedWorktreeCwd(""), false, "empty cwd");
    assert.throws(() => assertWorktreeCwd(repoRoot), /managed worktree/);
    assert.throws(() => assertWorktreeCwd(process.cwd()), /managed worktree/);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("realDeveloperSpawn refuses the primary repo root before any process is spawned", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-guard-dev-"));
  try {
    await assert.rejects(
      realDeveloperSpawn({
        sessionId: SESSION_ID,
        runtime: "claude_code",
        policy: { worktreeWrite: true } as never,
        model: null,
        prompt: "Implement it",
        cwd: repoRoot,
        timeoutMs: 1000,
      }),
      /managed worktree/,
      "repo-root cwd throws instead of spawning"
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("realReviewerSpawn refuses the primary repo root before any process is spawned", async () => {
  await assert.rejects(
    realReviewerSpawn({
      sessionId: SESSION_ID,
      runtime: "claude_code",
      policy: { worktreeWrite: false } as never,
      model: null,
      prompt: "Review it",
      cwd: process.cwd(),
      timeoutMs: 1000,
    }),
    /managed worktree/,
    "repo-root cwd throws instead of spawning"
  );
});
