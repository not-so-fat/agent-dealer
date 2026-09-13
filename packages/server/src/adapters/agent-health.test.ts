// packages/server/src/adapters/agent-health.test.ts
//
// NOT-77: an agent bound to a deck that Agent Deck is reachable for (agentDeckOnline) but
// whose authenticated metadata call fails (missing/revoked enrollment, auth error) must
// surface a distinct issue — resolveDeckName silently swallows the same failure to null
// elsewhere, so this is the one place an operator can see why deck resolution is broken.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-agenthealth-"));

const { migrate } = await import("../db/index.js");
const { createAgent } = await import("../repository/agents.js");
const { healthForAgent } = await import("./agent-health.js");

migrate();

test("agentDeckOnline but no deckId configured: no deck-related issue", async () => {
  const agent = createAgent({ name: "no-deck", runtime: "claude_code", workspaceRoot: "/tmp" });
  const result = await healthForAgent(agent, true, new Map(), true, "authority secret invalid");
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
  const result = await healthForAgent(agent, false, new Map(), true, "irrelevant while offline");
  assert.deepEqual(
    result.issues.map((i) => i.code).sort(),
    ["deck_offline"]
  );
});

test("agent deck online but enrollment revoked: reports deck_unauthorized with the Deck message", async () => {
  const agent = createAgent({
    name: "revoked",
    runtime: "claude_code",
    workspaceRoot: "/tmp",
    deckId: randomUUID(),
  });
  const result = await healthForAgent(agent, true, new Map(), true, "enrollment is revoked");
  const issue = result.issues.find((i) => i.code === "deck_unauthorized");
  assert.ok(issue, "expected a deck_unauthorized issue");
  assert.equal(issue?.message, "enrollment is revoked");
});

test("agent deck online with no access error: healthy on the deck axis", async () => {
  const agent = createAgent({
    name: "healthy",
    runtime: "claude_code",
    workspaceRoot: "/tmp",
    deckId: randomUUID(),
  });
  const result = await healthForAgent(agent, true, new Map(), true, null);
  assert.equal(
    result.issues.some((i) => i.code === "deck_unauthorized" || i.code === "deck_offline"),
    false
  );
});
