// packages/server/src/paths.test.ts
//
// cleanupOrphanedWorkerMcpConfig (PR #19 review round 3): a coordinator crash mid-attempt
// skips releaseWorkerAuthority's own cleanup, leaving a live credential (claude's authority
// bearer, or codex's symlinked login) under worker-mcp-config indefinitely. Every entry
// there is scoped to one already-unrecoverable attempt, so a startup sweep can remove all
// of them unconditionally.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-paths-"));

const { getExecutionAuthorityConfigDir, cleanupOrphanedWorkerMcpConfig } = await import("./paths.js");

test("cleanupOrphanedWorkerMcpConfig removes leftover per-attempt files and directories", () => {
  const dir = getExecutionAuthorityConfigDir();
  fs.writeFileSync(path.join(dir, "authz_1-abc.json"), JSON.stringify({ authorityId: "authz_1" }));
  const codexHome = path.join(dir, "codex-home-authz_2-def");
  fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(codexHome, "config.toml"), "");

  cleanupOrphanedWorkerMcpConfig();

  assert.deepEqual(fs.readdirSync(dir), []);
});

test("cleanupOrphanedWorkerMcpConfig removes a leftover auth.json symlink without touching its target", () => {
  const dir = getExecutionAuthorityConfigDir();
  const ambientAuthPath = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-ambient-auth-"));
  const realAuth = path.join(ambientAuthPath, "auth.json");
  fs.writeFileSync(realAuth, "real-credential");
  const codexHome = path.join(dir, "codex-home-authz_3-ghi");
  fs.mkdirSync(codexHome);
  fs.symlinkSync(realAuth, path.join(codexHome, "auth.json"));

  cleanupOrphanedWorkerMcpConfig();

  assert.equal(fs.existsSync(codexHome), false);
  assert.ok(fs.existsSync(realAuth));
  assert.equal(fs.readFileSync(realAuth, "utf8"), "real-credential");
  fs.rmSync(ambientAuthPath, { recursive: true, force: true });
});

test("cleanupOrphanedWorkerMcpConfig is a no-op on an already-empty directory", () => {
  const dir = getExecutionAuthorityConfigDir();
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.doesNotThrow(() => cleanupOrphanedWorkerMcpConfig());
});
