// Unit coverage for bounded gh timeout classification (NOT-102) and NOT-151 spawn ENOENT mapping.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not151-unit-"));

const {
  GH_MERGE_TIMEOUT_MS,
  ghErrorReason,
  ghSpawnEnoentReason,
  isGhTimeoutError,
  resolveAutoMergeCwd,
} = await import("./auto-merge.js");
const { managedRepoPath } = await import("../adapters/managed-repo.js");

before(async () => {
  const { migrate } = await import("../db/index.js");
  migrate();
});

test("isGhTimeoutError detects killed / SIGTERM from execFile timeout", () => {
  assert.equal(isGhTimeoutError({ killed: true }), true);
  assert.equal(isGhTimeoutError({ signal: "SIGTERM" }), true);
  assert.equal(isGhTimeoutError({ killed: false, signal: null, stderr: "boom" }), false);
});

test("ghErrorReason maps timeout before stderr", () => {
  assert.equal(
    ghErrorReason({ killed: true, stderr: "ignored" }, "fallback"),
    `gh timed out after ${GH_MERGE_TIMEOUT_MS}ms`
  );
  assert.equal(ghErrorReason({ stderr: " checks failed \n" }, "fallback"), "checks failed");
  assert.equal(ghErrorReason({}, "gh pr merge failed"), "gh pr merge failed");
});

test("NOT-151: ghSpawnEnoentReason distinguishes bad cwd from missing gh", () => {
  const missing = path.join(os.tmpdir(), "dealer-missing-merge-cwd-xyz");
  assert.match(
    ghSpawnEnoentReason({ code: "ENOENT", message: "spawn gh ENOENT" }, missing) ?? "",
    /invalid merge cwd/
  );
  const existing = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-merge-cwd-"));
  assert.match(
    ghSpawnEnoentReason({ code: "ENOENT", message: "spawn gh ENOENT" }, existing) ?? "",
    /gh not on PATH/
  );
  assert.equal(ghSpawnEnoentReason({ stderr: "checks failed" }, existing), null);
});

test("NOT-151: resolveAutoMergeCwd maps portable identity to managed path when clone exists", () => {
  const identity = "github.com/not-so-fat/agent-dealer";
  const managed = managedRepoPath(identity);
  fs.mkdirSync(path.join(managed, ".git"), { recursive: true });
  const ok = resolveAutoMergeCwd(identity);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.cwd, managed);
});

test("NOT-151: resolveAutoMergeCwd fails closed when managed clone is missing", () => {
  const missing = resolveAutoMergeCwd("github.com/missing/not-cloned");
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.match(missing.reason, /Managed clone missing/);
    assert.doesNotMatch(missing.reason, /ENOENT/);
  }
});

test("NOT-151: resolveAutoMergeCwd accepts a real legacy local checkout", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-merge-cwd-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  const ok = resolveAutoMergeCwd(dir);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.cwd, dir);
});
