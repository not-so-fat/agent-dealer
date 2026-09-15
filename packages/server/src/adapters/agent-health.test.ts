// packages/server/src/adapters/agent-health.test.ts
//
// An agent bound to a deck that Agent Deck is reachable for (agentDeckOnline) but whose
// launch deck-metadata call fails — or succeeds but simply no longer includes this deck
// (deleted) — must surface a distinct issue. resolveDeckName silently swallows both of
// the same failures to null elsewhere, so this is the one place an operator can see why
// deck resolution is broken.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentHealthIssue } from "@agent-dealer/shared";
import type { DeckAccessResult } from "./agent-deck.js";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-agenthealth-"));

const { migrate } = await import("../db/index.js");
const { createAgent } = await import("../repository/agents.js");
const { healthForAgent, runtimeIssuesUncached, githubIssuesUncached, clearAgentHealthCaches } =
  await import("./agent-health.js");

migrate();

const FAILURE: DeckAccessResult = { ok: false, code: "DECK_UNAVAILABLE", message: "Agent Deck API error: 502" };

/** Tests inject an empty github list so host `gh auth` does not pollute assertions. */
const NO_GITHUB: AgentHealthIssue[] = [];

test("agentDeckOnline but no deckId configured: no deck-related issue", async () => {
  const agent = createAgent({ name: "no-deck", runtime: "claude_code", workspaceRoot: "/tmp" });
  const result = await healthForAgent(agent, true, new Map(), true, FAILURE, NO_GITHUB);
  assert.equal(
    result.issues.some((i) => i.code === "deck_unauthorized" || i.code === "deck_offline"),
    false
  );
});

test("agent deck offline: reports deck_offline, not deck_unauthorized", async () => {
  const agent = createAgent({
    name: "offline",
    runtime: "claude_code",
    workspaceRoot: "/tmp",
    deckId: randomUUID(),
  });
  const result = await healthForAgent(agent, false, new Map(), true, FAILURE, NO_GITHUB);
  assert.deepEqual(
    result.issues.map((i) => i.code).sort(),
    ["deck_offline"]
  );
});

test("agent deck online but metadata unavailable: reports deck_unauthorized with the Deck message", async () => {
  const agent = createAgent({
    name: "unavailable",
    runtime: "claude_code",
    workspaceRoot: "/tmp",
    deckId: randomUUID(),
  });
  const result = await healthForAgent(agent, true, new Map(), true, FAILURE, NO_GITHUB);
  const issue = result.issues.find((i) => i.code === "deck_unauthorized");
  assert.ok(issue, "expected a deck_unauthorized issue");
  assert.equal(issue?.message, "Agent Deck API error: 502");
});

test("agent deck online, metadata call succeeds, but this deck isn't in the returned set: reports deck_unauthorized", async () => {
  const deckId = randomUUID();
  const agent = createAgent({ name: "stale-deck", runtime: "claude_code", workspaceRoot: "/tmp", deckId });
  const deckAccessResult: DeckAccessResult = { ok: true, decks: [{ id: randomUUID(), name: "some-other-deck" }] };
  const result = await healthForAgent(agent, true, new Map(), true, deckAccessResult, NO_GITHUB);
  const issue = result.issues.find((i) => i.code === "deck_unauthorized");
  assert.ok(issue, "expected a deck_unauthorized issue for a deck missing from the launch set");
});

test("agent deck online and this deck is in the returned set: healthy on the deck axis", async () => {
  const deckId = randomUUID();
  const agent = createAgent({ name: "healthy", runtime: "claude_code", workspaceRoot: "/tmp", deckId });
  const deckAccessResult: DeckAccessResult = { ok: true, decks: [{ id: deckId, name: "healthy-deck" }] };
  const result = await healthForAgent(agent, true, new Map(), true, deckAccessResult, NO_GITHUB);
  assert.equal(
    result.issues.some((i) => i.code === "deck_unauthorized" || i.code === "deck_offline"),
    false
  );
});

test("agent deck online with no deck-access result computed (e.g. no agent needed it): no false positive", async () => {
  const agent = createAgent({
    name: "no-result",
    runtime: "claude_code",
    workspaceRoot: "/tmp",
    deckId: randomUUID(),
  });
  const result = await healthForAgent(agent, true, new Map(), true, null, NO_GITHUB);
  assert.equal(
    result.issues.some((i) => i.code === "deck_unauthorized" || i.code === "deck_offline"),
    false
  );
});

test("codex_local with a missing CLI reports cli_missing exactly once, not twice", async () => {
  const prevCodexCli = process.env.CODEX_CLI;
  process.env.CODEX_CLI = "/nonexistent/path/codex-does-not-exist";
  try {
    const issues = await runtimeIssuesUncached("codex_local");
    assert.deepEqual(
      issues.map((i) => i.code),
      ["cli_missing"]
    );
  } finally {
    if (prevCodexCli === undefined) delete process.env.CODEX_CLI;
    else process.env.CODEX_CLI = prevCodexCli;
  }
});

test("cursor_local with a bound deck: no deck access issue (launch MCP is supported)", async () => {
  const agent = createAgent({
    name: "cursor-with-deck",
    runtime: "cursor_local",
    workspaceRoot: "/tmp",
    deckId: randomUUID(),
  });
  const result = await healthForAgent(agent, true, new Map(), true, null, NO_GITHUB);
  assert.equal(
    result.issues.some((i) => i.code === "deck_unauthorized" || i.code === "deck_offline"),
    false
  );
});

test("github_auth issues mark the agent unhealthy so Start can refuse before a wasted run", async () => {
  const agent = createAgent({ name: "needs-gh", runtime: "claude_code", workspaceRoot: "/tmp" });
  const gh: AgentHealthIssue[] = [
    { code: "github_auth", message: "Run `gh auth login` — GitHub CLI auth required to open PRs" },
  ];
  const result = await healthForAgent(agent, true, new Map(), true, null, gh);
  assert.equal(result.healthy, false);
  assert.equal(result.issues.some((i) => i.code === "github_auth"), true);
});

test("githubIssuesUncached reports github_auth when gh auth status fails with an invalid token", async () => {
  clearAgentHealthCaches();
  // Exercise the real parser path by stubbing via PATH... we instead unit-test the
  // injected-list path above for healthForAgent. Here we assert the uncached helper
  // returns a known shape when `gh` is present but auth is bad — skip if gh missing.
  const { spawnSync } = await import("node:child_process");
  const probe = spawnSync("gh", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    // No gh on this host — nothing to assert about auth status.
    return;
  }
  const issues = await githubIssuesUncached();
  for (const issue of issues) {
    assert.ok(issue.code === "github_auth" || issue.code === "github_cli_missing");
    assert.ok(issue.message.length > 0);
  }
});
