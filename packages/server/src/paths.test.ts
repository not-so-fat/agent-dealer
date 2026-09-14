// packages/server/src/paths.test.ts
//
// cleanupOrphanedWorkerMcpConfig: a coordinator crash mid-attempt skips
// releaseWorkerDeckConnection's own cleanup, leaving leftover per-attempt MCP
// configs (claude JSON files, codex CODEX_HOME dirs) under worker-mcp-config.
// Every entry there is scoped to one already-unrecoverable attempt, so a startup
// sweep can remove all of them unconditionally.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-paths-"));

const { getWorkerMcpConfigDir, cleanupOrphanedWorkerMcpConfig } = await import("./paths.js");

test("cleanupOrphanedWorkerMcpConfig removes leftover per-attempt files and directories", () => {
  const dir = getWorkerMcpConfigDir();
  fs.writeFileSync(path.join(dir, "deck-abc.json"), JSON.stringify({ mcpServers: {} }));
  const codexHome = path.join(dir, "codex-home-deck-def");
  fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(codexHome, "config.toml"), "");

  cleanupOrphanedWorkerMcpConfig();

  assert.deepEqual(fs.readdirSync(dir), []);
});

test("cleanupOrphanedWorkerMcpConfig removes a leftover auth.json symlink without touching its target", () => {
  const dir = getWorkerMcpConfigDir();
  const ambientAuthPath = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-ambient-auth-"));
  const realAuth = path.join(ambientAuthPath, "auth.json");
  fs.writeFileSync(realAuth, "real-credential");
  const codexHome = path.join(dir, "codex-home-deck-ghi");
  fs.mkdirSync(codexHome);
  fs.symlinkSync(realAuth, path.join(codexHome, "auth.json"));

  cleanupOrphanedWorkerMcpConfig();

  assert.equal(fs.existsSync(codexHome), false);
  assert.ok(fs.existsSync(realAuth));
  assert.equal(fs.readFileSync(realAuth, "utf8"), "real-credential");
  fs.rmSync(ambientAuthPath, { recursive: true, force: true });
});

test("cleanupOrphanedWorkerMcpConfig is a no-op on an already-empty directory", () => {
  const dir = getWorkerMcpConfigDir();
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.doesNotThrow(() => cleanupOrphanedWorkerMcpConfig());
});
