import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-managed-repo-"));

const { migrate } = await import("../db/index.js");
migrate();

const {
  classifyIssueRepo,
  ensureIssueRepoCheckout,
  managedRepoPath,
  managedWorktreePath,
  resolveRemoteDefaultBranch,
  tryResolveOriginGitHubIdentity,
} = await import("./managed-repo.js");
const { getExecutionRoot } = await import("../paths.js");

function initFixtureRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-repo-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "hi\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

test("classifyIssueRepo: GitHub identity maps to managed path under execution root", () => {
  const r = classifyIssueRepo("acme/app");
  assert.equal(r.kind, "managed");
  if (r.kind === "managed") {
    assert.equal(r.identity, "github.com/acme/app");
    assert.equal(r.repoPath, path.join(getExecutionRoot(), "repos", "github.com/acme/app"));
    assert.equal(managedRepoPath(r.identity), r.repoPath);
    assert.equal(
      managedWorktreePath(r.identity, "sess-1", "developer"),
      path.join(getExecutionRoot(), "worktrees", "github.com/acme/app", "sess-1-developer")
    );
  }
});

test("classifyIssueRepo: legacy local path is recoverable when present, errors when missing", () => {
  const fixture = initFixtureRepo();
  const ok = classifyIssueRepo(fixture);
  assert.equal(ok.kind, "legacy_local");
  if (ok.kind === "legacy_local") assert.equal(ok.repoPath, fixture);

  assert.throws(
    () => classifyIssueRepo(path.join(os.tmpdir(), "missing-dealer-repo-xyz")),
    /Legacy issue repo path is missing/
  );
});

test("ensureIssueRepoCheckout clones from override into managed layout and reads default branch", async () => {
  const fixture = initFixtureRepo();
  const resolved = await ensureIssueRepoCheckout("test-org/fixture-app", {
    cloneUrlOverride: fixture,
  });
  assert.equal(resolved.kind, "managed");
  assert.ok(fs.existsSync(path.join(resolved.repoPath, ".git")));
  assert.equal(resolved.defaultBranch, "main");
  assert.equal(await resolveRemoteDefaultBranch(resolved.repoPath), "main");
});

test("tryResolveOriginGitHubIdentity returns null when origin is not GitHub", async () => {
  const fixture = initFixtureRepo();
  assert.equal(await tryResolveOriginGitHubIdentity(fixture), null);
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/from-origin.git"], {
    cwd: fixture,
  });
  assert.equal(await tryResolveOriginGitHubIdentity(fixture), "github.com/acme/from-origin");
});
