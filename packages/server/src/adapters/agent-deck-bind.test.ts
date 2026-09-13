// packages/server/src/adapters/agent-deck-bind.test.ts
//
// acquireWorkerAuthority mints a short-lived execution authority for one attempt, verifies
// it with a live round-trip call, and writes a per-attempt MCP config the worker's own
// spawn is pointed at (NOT-87). Every Deck failure comes back typed — INTERACTION_REQUIRED
// is its own outcome kind (never retried blindly), everything else is infra_failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-deckbind-"));

const { migrate } = await import("../db/index.js");
const { acquireWorkerAuthority, releaseWorkerAuthority, parseDeckToolResult } = await import("./agent-deck-bind.js");
const { mintAuthority } = await import("./execution-authority.js");

migrate();

const DECK = "7eb62206-f3a3-44d1-99e5-8f40b39be084";
const WT = "/tmp/worktrees/session-a-developer";

const MINT_OK = {
  ok: true as const,
  authority: {
    authorityId: "authz_1",
    authoritySecret: "authzs_secret",
    deckId: DECK,
    audience: "dealer-worker" as const,
    allowedServices: ["slack"],
    allowedTools: [{ serviceId: "slack", toolName: "send_message" }],
    expiresAt: "2026-01-01T00:30:00Z",
  },
};

function textResult(obj: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

function errorResult(msg: string) {
  return { isError: true, content: [{ type: "text", text: msg }] };
}

const BASE_OPTS = {
  deckId: DECK,
  runId: "run-1",
  attemptId: "wi-1",
  idempotencyKey: "wi-1:1",
  worktreePath: WT,
  runtime: "claude_code" as const,
};

test("parseDeckToolResult extracts and parses the text payload", () => {
  assert.deepEqual(parseDeckToolResult(textResult({ a: 1 })), { a: 1 });
  assert.throws(() => parseDeckToolResult({ content: [] }));
});

test("acquireWorkerAuthority mints, verifies, and writes a per-attempt MCP config on success", async () => {
  let verifyCalled = false;
  const result = await acquireWorkerAuthority({
    ...BASE_OPTS,
    mint: async () => MINT_OK,
    verifyCallTool: async (name) => {
      verifyCalled = true;
      assert.equal(name, "get_bound_deck");
      return textResult({ deckId: DECK });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(verifyCalled, true);
  if (result.ok) {
    assert.equal(result.authorityId, "authz_1");
    assert.ok(fs.existsSync(result.mcpConfigPath));
    const written = JSON.parse(fs.readFileSync(result.mcpConfigPath, "utf8"));
    assert.equal(written.mcpServers["agent-deck"].headers.Authorization, "Bearer authz_1:authzs_secret");
    assert.equal(written.mcpServers["agent-deck"].headers["x-agent-deck-workspace"], WT);
    await releaseWorkerAuthority({ authorityId: result.authorityId, mcpConfigPath: result.mcpConfigPath });
    assert.equal(fs.existsSync(result.mcpConfigPath), false);
  }
});

test("acquireWorkerAuthority returns interaction_required without writing a config when Deck denies mint", async () => {
  const result = await acquireWorkerAuthority({
    ...BASE_OPTS,
    mint: async () => ({ ok: false, code: "INTERACTION_REQUIRED", message: "Control-plane decision required" }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.kind, "interaction_required");
    assert.equal(result.reason, "Control-plane decision required");
  }
});

test("acquireWorkerAuthority returns infra_failure for a non-interaction contract error", async () => {
  const result = await acquireWorkerAuthority({
    ...BASE_OPTS,
    mint: async () => ({ ok: false, code: "DECK_UNAVAILABLE", message: "ECONNREFUSED" }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.kind, "infra_failure");
    assert.match(result.reason, /DECK_UNAVAILABLE/);
  }
});

test("acquireWorkerAuthority returns infra_failure when the mint succeeds but issues no secret", async () => {
  const result = await acquireWorkerAuthority({
    ...BASE_OPTS,
    mint: async () => ({ ok: true, authority: { ...MINT_OK.authority, authoritySecret: null } }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.kind, "infra_failure");
});

test("acquireWorkerAuthority revokes and returns infra_failure when the live verify call fails", async () => {
  let revokeUrl: string | undefined;
  const fetchMock = (await import("node:test")).mock.method(globalThis, "fetch", async (url: string) => {
    revokeUrl = String(url);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  process.env.AGENT_DECK_ENROLLMENT_ID = "enr_abc";
  process.env.AGENT_DECK_ENROLLMENT_SECRET = "enrs_secret";
  try {
    const result = await acquireWorkerAuthority({
      ...BASE_OPTS,
      mint: async () => MINT_OK,
      verifyCallTool: async () => errorResult("no session"),
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, "infra_failure");
      assert.match(result.reason, /get_bound_deck returned an error/);
    }
    assert.match(revokeUrl ?? "", /\/authorities\/authz_1\/revoke$/);
  } finally {
    fetchMock.mock.restore();
    delete process.env.AGENT_DECK_ENROLLMENT_ID;
    delete process.env.AGENT_DECK_ENROLLMENT_SECRET;
  }
});

test("mintAuthority import stays wired for the release path (sanity)", () => {
  assert.equal(typeof mintAuthority, "function");
});

test("acquireWorkerAuthority materializes a CODEX_HOME directory with a bearer-env-var config for codex_local", async () => {
  const result = await acquireWorkerAuthority({
    ...BASE_OPTS,
    runtime: "codex_local",
    mint: async () => MINT_OK,
    verifyCallTool: async () => textResult({ deckId: DECK }),
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(fs.statSync(result.mcpConfigPath).isDirectory());
    const toml = fs.readFileSync(path.join(result.mcpConfigPath, "config.toml"), "utf8");
    assert.match(toml, /\[mcp_servers\.agent-deck\]/);
    assert.match(toml, /bearer_token_env_var = "AGENT_DECK_AUTHORITY_BEARER"/);
    assert.doesNotMatch(toml, /authzs_secret/); // the secret itself never touches disk
    assert.equal(result.mcpEnv?.AGENT_DECK_AUTHORITY_BEARER, "authz_1:authzs_secret");
    await releaseWorkerAuthority({ authorityId: result.authorityId, mcpConfigPath: result.mcpConfigPath });
    assert.equal(fs.existsSync(result.mcpConfigPath), false);
  }
});

test("acquireWorkerAuthority writes a scoped .cursor/mcp.json inside the worktree for cursor_local, excluded from git add -A", async () => {
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-cursor-wt-"));
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "-q"], { cwd: worktreePath });
  try {
    const result = await acquireWorkerAuthority({
      ...BASE_OPTS,
      worktreePath,
      runtime: "cursor_local",
      mint: async () => MINT_OK,
      verifyCallTool: async () => textResult({ deckId: DECK }),
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.mcpConfigPath, path.join(worktreePath, ".cursor", "mcp.json"));
      const written = JSON.parse(fs.readFileSync(result.mcpConfigPath, "utf8"));
      assert.equal(written.mcpServers["agent-deck"].headers.Authorization, "Bearer authz_1:authzs_secret");
      assert.equal(result.mcpEnv, undefined);
      // The worker's own `git add -A` (its normal way of committing/pushing its change)
      // must never be able to stage this secret file.
      const status = execFileSync("git", ["status", "--porcelain", "--ignored"], { cwd: worktreePath }).toString();
      assert.match(status, /!! \.cursor\//);
      await releaseWorkerAuthority({ authorityId: result.authorityId, mcpConfigPath: result.mcpConfigPath });
      assert.equal(fs.existsSync(result.mcpConfigPath), false);
    }
  } finally {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
});
