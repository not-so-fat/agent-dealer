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
const { fetchDecks, fetchAuthorizedDecks } = await import("./agent-deck.js");

migrate();

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
