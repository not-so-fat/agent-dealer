// packages/server/src/adapters/agent-deck.test.ts
//
// NOT-106: fetchDecks hits unauthenticated GET /api/launch/decks.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-agentdeck-"));

const { migrate } = await import("../db/index.js");
const {
  fetchDecks,
  fetchAuthorizedDecks,
  isAgentDeckMcpRegistered,
  checkAgentDeckMcpRegistration,
} = await import("./agent-deck.js");

migrate();

function writeClaudeMcpFixture(mcpServers: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-mcp-"));
  const configPath = path.join(dir, ".claude.json");
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2));
  return configPath;
}

function withClaudeMcpConfig<T>(configPath: string | null, fn: () => T): T {
  const prev = process.env.CLAUDE_MCP_CONFIG;
  if (configPath === null) delete process.env.CLAUDE_MCP_CONFIG;
  else process.env.CLAUDE_MCP_CONFIG = configPath;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_MCP_CONFIG;
    else process.env.CLAUDE_MCP_CONFIG = prev;
  }
}

test("fetchDecks returns decks on success from /api/launch/decks", async () => {
  let capturedUrl = "";
  const fetchMock = mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    capturedUrl = String(url);
    assert.equal((init?.headers as Record<string, string> | undefined)?.Authorization, undefined);
    return new Response(
      JSON.stringify({ success: true, data: { decks: [{ id: "d1", name: "personal-dev" }] } }),
      { status: 200 }
    );
  });
  try {
    const result = await fetchDecks();
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.decks, [{ id: "d1", name: "personal-dev" }]);
    assert.match(capturedUrl, /\/api\/launch\/decks$/);
  } finally {
    fetchMock.mock.restore();
  }
});

test("fetchDecks reports DECK_UNAVAILABLE on HTTP error, never an empty list", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    return new Response(JSON.stringify({ success: false, message: "boom" }), { status: 500 });
  });
  try {
    const result = await fetchDecks();
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "DECK_UNAVAILABLE");
      assert.match(result.message, /boom|500/);
    }
  } finally {
    fetchMock.mock.restore();
  }
});

test("fetchDecks reports DECK_UNAVAILABLE on a network error, never an empty list", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    throw new Error("ECONNREFUSED");
  });
  try {
    const result = await fetchDecks();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "DECK_UNAVAILABLE");
  } finally {
    fetchMock.mock.restore();
  }
});

test("fetchAuthorizedDecks is an alias of fetchDecks", () => {
  assert.equal(fetchAuthorizedDecks, fetchDecks);
});

// Default Agent Deck MCP endpoint under a fresh AGENT_DEALER_HOME is 127.0.0.1:1110
// (API port 1111 − 1). Fixtures below match that unless noted.

test("isAgentDeckMcpRegistered: stdio mcp-launch with matching env is registered (no url)", () => {
  const configPath = writeClaudeMcpFixture({
    "agent-deck": {
      type: "stdio",
      command: "agent-deck",
      args: ["mcp-launch"],
      env: { AGENT_DECK_MCP_PORT: "1110", AGENT_DECK_HOST: "127.0.0.1" },
    },
  });
  withClaudeMcpConfig(configPath, () => {
    assert.equal(isAgentDeckMcpRegistered(), true);
    assert.equal(checkAgentDeckMcpRegistration().status, "registered");
  });
});

test("isAgentDeckMcpRegistered: legacy HTTP url with matching host/port is registered", () => {
  const configPath = writeClaudeMcpFixture({
    "agent-deck": { url: "http://127.0.0.1:1110/mcp" },
  });
  withClaudeMcpConfig(configPath, () => {
    assert.equal(isAgentDeckMcpRegistered(), true);
  });
});

test("isAgentDeckMcpRegistered: missing entry returns false / missing", () => {
  const configPath = writeClaudeMcpFixture({
    other: { url: "http://127.0.0.1:9999/mcp" },
  });
  withClaudeMcpConfig(configPath, () => {
    assert.equal(isAgentDeckMcpRegistered(), false);
    assert.equal(checkAgentDeckMcpRegistration().status, "missing");
  });
});

test("checkAgentDeckMcpRegistration: wrong stdio port is endpoint_mismatch, not registered", () => {
  const configPath = writeClaudeMcpFixture({
    "agent-deck": {
      type: "stdio",
      command: "agent-deck",
      args: ["mcp-launch"],
      env: { AGENT_DECK_MCP_PORT: "9999", AGENT_DECK_HOST: "127.0.0.1" },
    },
  });
  withClaudeMcpConfig(configPath, () => {
    assert.equal(isAgentDeckMcpRegistered(), false);
    const result = checkAgentDeckMcpRegistration();
    assert.equal(result.status, "endpoint_mismatch");
    if (result.status === "endpoint_mismatch") {
      assert.equal(result.expectedPort, "1110");
      assert.equal(result.foundPort, "9999");
      assert.equal(result.expectedHost, "127.0.0.1");
      assert.equal(result.foundHost, "127.0.0.1");
    }
  });
});

test("isAgentDeckMcpRegistered: stdio without mcp-launch args is not registered", () => {
  const configPath = writeClaudeMcpFixture({
    "agent-deck": {
      type: "stdio",
      command: "agent-deck",
      args: ["mcp"],
      env: { AGENT_DECK_MCP_PORT: "1110", AGENT_DECK_HOST: "127.0.0.1" },
    },
  });
  withClaudeMcpConfig(configPath, () => {
    assert.equal(isAgentDeckMcpRegistered(), false);
    assert.equal(checkAgentDeckMcpRegistration().status, "missing");
  });
});
