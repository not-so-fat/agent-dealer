// packages/server/src/adapters/agent-deck-bind.test.ts
//
// prepareWorkerDeckConnection materializes a per-attempt MCP config with deck launch
// headers (no Authorization) and verifies with get_bound_deck (NOT-106).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parse as parseToml } from "smol-toml";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-deckbind-"));

const { migrate } = await import("../db/index.js");
const { prepareWorkerDeckConnection, releaseWorkerDeckConnection, parseDeckToolResult } = await import("./agent-deck-bind.js");

migrate();

const DECK = "7eb62206-f3a3-44d1-99e5-8f40b39be084";
const WT = "/tmp/worktrees/session-a-developer";

function textResult(obj: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

function errorResult(msg: string) {
  return { isError: true, content: [{ type: "text", text: msg }] };
}

const BASE_OPTS = {
  deckId: DECK,
  worktreePath: WT,
  runtime: "claude_code" as const,
};

test("parseDeckToolResult extracts and parses the text payload", () => {
  assert.deepEqual(parseDeckToolResult(textResult({ a: 1 })), { a: 1 });
  assert.throws(() => parseDeckToolResult({ content: [] }));
});

test("prepareWorkerDeckConnection verifies and writes a claude MCP config with deck headers, no Auth", async () => {
  let verifyCalled = false;
  const result = await prepareWorkerDeckConnection({
    ...BASE_OPTS,
    verifyCallTool: async (name) => {
      verifyCalled = true;
      assert.equal(name, "get_bound_deck");
      return textResult({ id: DECK, name: "personal-dev" });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(verifyCalled, true);
  if (result.ok) {
    assert.ok(fs.existsSync(result.mcpConfigPath));
    const written = JSON.parse(fs.readFileSync(result.mcpConfigPath, "utf8"));
    const headers = written.mcpServers["agent-deck"].headers;
    assert.equal(headers["x-agent-deck-deck-id"], DECK);
    assert.equal(headers["x-agent-deck-workspace"], WT);
    assert.equal(headers.Authorization, undefined);
    await releaseWorkerDeckConnection({ mcpConfigPath: result.mcpConfigPath });
    assert.equal(fs.existsSync(result.mcpConfigPath), false);
  }
});

test("prepareWorkerDeckConnection rejects when get_bound_deck reports a different deck", async () => {
  const result = await prepareWorkerDeckConnection({
    ...BASE_OPTS,
    verifyCallTool: async () => textResult({ id: "some-other-deck-id" }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.kind, "infra_failure");
    assert.match(result.reason, /returned deck some-other-deck-id, expected/);
  }
});

test("prepareWorkerDeckConnection returns infra_failure when verify fails", async () => {
  const result = await prepareWorkerDeckConnection({
    ...BASE_OPTS,
    verifyCallTool: async () => errorResult("no session"),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.kind, "infra_failure");
    assert.match(result.reason, /get_bound_deck returned an error/);
  }
});

test("prepareWorkerDeckConnection for codex_local writes http_headers (no bearer) and CODEX_HOME env", async () => {
  const result = await prepareWorkerDeckConnection({
    ...BASE_OPTS,
    runtime: "codex_local",
    verifyCallTool: async () => textResult({ id: DECK }),
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(fs.statSync(result.mcpConfigPath).isDirectory());
    const toml = fs.readFileSync(path.join(result.mcpConfigPath, "config.toml"), "utf8");
    assert.match(toml, /\[mcp_servers\.agent-deck\]/);
    assert.match(toml, /http_headers/);
    assert.doesNotMatch(toml, /bearer_token_env_var/);
    assert.doesNotMatch(toml, /Authorization/);
    assert.equal(result.mcpEnv?.CODEX_HOME, result.mcpConfigPath);
    assert.equal(result.mcpEnv?.AGENT_DECK_AUTHORITY_BEARER, undefined);
    await releaseWorkerDeckConnection({ mcpConfigPath: result.mcpConfigPath });
    assert.equal(fs.existsSync(result.mcpConfigPath), false);
  }
});

test("prepareWorkerDeckConnection for codex_local symlinks ambient auth.json and preserves auth policy", async () => {
  const ambientCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-ambient-codex-"));
  const ambientAuthPath = path.join(ambientCodexHome, "auth.json");
  fs.writeFileSync(ambientAuthPath, JSON.stringify({ tokens: { access_token: "real-secret-token" } }));
  fs.writeFileSync(
    path.join(ambientCodexHome, "config.toml"),
    [
      'cli_auth_credentials_store = "file"',
      'chatgpt_base_url = "https://chatgpt.example.com"',
      'forced_login_method = "chatgpt"',
      'forced_chatgpt_workspace_id = "ws_123"',
      'model = "should-not-be-copied"',
      "",
    ].join("\n")
  );
  const prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = ambientCodexHome;
  try {
    const result = await prepareWorkerDeckConnection({
      ...BASE_OPTS,
      runtime: "codex_local",
      verifyCallTool: async () => textResult({ id: DECK }),
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      const isolatedAuthPath = path.join(result.mcpConfigPath, "auth.json");
      assert.ok(fs.lstatSync(isolatedAuthPath).isSymbolicLink());
      assert.equal(fs.readlinkSync(isolatedAuthPath), ambientAuthPath);

      const isolated = parseToml(fs.readFileSync(path.join(result.mcpConfigPath, "config.toml"), "utf8")) as Record<string, unknown>;
      assert.equal(isolated.cli_auth_credentials_store, "file");
      assert.equal(isolated.chatgpt_base_url, "https://chatgpt.example.com");
      assert.equal(isolated.forced_login_method, "chatgpt");
      assert.equal(isolated.forced_chatgpt_workspace_id, "ws_123");
      assert.equal(isolated.model, undefined);

      const mcpServers = isolated.mcp_servers as Record<string, { http_headers?: Record<string, string> }>;
      assert.equal(mcpServers["agent-deck"].http_headers?.["x-agent-deck-deck-id"], DECK);
      assert.equal(mcpServers["agent-deck"].http_headers?.Authorization, undefined);

      await releaseWorkerDeckConnection({ mcpConfigPath: result.mcpConfigPath });
      assert.equal(fs.existsSync(result.mcpConfigPath), false);
      assert.ok(fs.existsSync(ambientAuthPath));
    }
  } finally {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    fs.rmSync(ambientCodexHome, { recursive: true, force: true });
  }
});

test("prepareWorkerDeckConnection for codex_local tolerates no ambient auth.json", async () => {
  const ambientCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-ambient-codex-nokey-"));
  const prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = ambientCodexHome;
  try {
    const result = await prepareWorkerDeckConnection({
      ...BASE_OPTS,
      runtime: "codex_local",
      verifyCallTool: async () => textResult({ id: DECK }),
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(fs.existsSync(path.join(result.mcpConfigPath, "auth.json")), false);
      await releaseWorkerDeckConnection({ mcpConfigPath: result.mcpConfigPath });
    }
  } finally {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    fs.rmSync(ambientCodexHome, { recursive: true, force: true });
  }
});

function initGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "README"), "x\n");
  execFileSync("git", ["add", "README"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
}

test("prepareWorkerDeckConnection for cursor_local writes mcp.json and excludes it", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-cursor-wt-"));
  initGitRepo(repo);
  try {
    const result = await prepareWorkerDeckConnection({
      deckId: DECK,
      worktreePath: repo,
      runtime: "cursor_local",
      verifyCallTool: async () => textResult({ id: DECK }),
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.mcpConfigPath, path.join(repo, ".cursor", "mcp.json"));
      assert.ok(fs.existsSync(result.mcpConfigPath));
      const written = JSON.parse(fs.readFileSync(result.mcpConfigPath, "utf8"));
      const headers = written.mcpServers["agent-deck"].headers;
      assert.equal(headers["x-agent-deck-deck-id"], DECK);
      assert.equal(headers.Authorization, undefined);

      const exclude = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
      assert.match(exclude, /\/\.cursor\/mcp\.json/);

      await releaseWorkerDeckConnection({ mcpConfigPath: result.mcpConfigPath });
      assert.equal(fs.existsSync(result.mcpConfigPath), false);
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("prepareWorkerDeckConnection refuses cursor_local when .cursor/mcp.json is tracked", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-cursor-tracked-"));
  initGitRepo(repo);
  try {
    fs.mkdirSync(path.join(repo, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".cursor", "mcp.json"), "{}\n");
    execFileSync("git", ["add", ".cursor/mcp.json"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "track mcp"], { cwd: repo, stdio: "ignore" });

    const result = await prepareWorkerDeckConnection({
      deckId: DECK,
      worktreePath: repo,
      runtime: "cursor_local",
      verifyCallTool: async () => textResult({ id: DECK }),
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, "infra_failure");
      assert.match(result.reason, /tracked/);
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
