// packages/server/src/adapters/agent-deck.test.ts
//
// NOT-77: fetchAuthorizedDecks replaces the old bare, unauthenticated GET /api/decks call
// (which now always 401s — the Dealer server process never holds an interactive workspace
// grant) with the NOT-85/86 enrollment-authenticated GET /api/execution-authority/decks.
// A missing/invalid/revoked enrollment must come back as a distinct typed outcome, never
// as a silently empty deck list.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-agentdeck-"));

const { migrate } = await import("../db/index.js");
const { fetchAuthorizedDecks } = await import("./agent-deck.js");

migrate();

const ENV_KEYS = ["AGENT_DECK_COORDINATOR_ID", "AGENT_DECK_ENROLLMENT_ID", "AGENT_DECK_ENROLLMENT_SECRET"] as const;

function withEnv(vars: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  return fn().finally(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

const ENROLLED = {
  AGENT_DECK_COORDINATOR_ID: "coord-1",
  AGENT_DECK_ENROLLMENT_ID: "enr_abc",
  AGENT_DECK_ENROLLMENT_SECRET: "enrs_secret",
};

test("fetchAuthorizedDecks returns NOT_ENROLLED without calling fetch when no enrollment env is set", async () => {
  await withEnv({}, async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      throw new Error("fetch should not be called");
    });
    try {
      const result = await fetchAuthorizedDecks();
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, "NOT_ENROLLED");
      assert.equal(fetchMock.mock.callCount(), 0);
    } finally {
      fetchMock.mock.restore();
    }
  });
});

test("fetchAuthorizedDecks sends the enrollment bearer and returns decks on success", async () => {
  await withEnv(ENROLLED, async () => {
    let capturedUrl = "";
    let capturedAuth = "";
    const fetchMock = mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      return new Response(
        JSON.stringify({ ok: true, data: { decks: [{ id: "d1", name: "personal-dev" }] } }),
        { status: 200 }
      );
    });
    try {
      const result = await fetchAuthorizedDecks();
      assert.equal(result.ok, true);
      if (result.ok) assert.deepEqual(result.decks, [{ id: "d1", name: "personal-dev" }]);
      assert.match(capturedUrl, /\/api\/execution-authority\/decks$/);
      assert.equal(capturedAuth, "Bearer enr_abc:enrs_secret");
    } finally {
      fetchMock.mock.restore();
    }
  });
});

test("fetchAuthorizedDecks maps a Deck-reported ENROLLMENT_REVOKED error", async () => {
  await withEnv(ENROLLED, async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      return new Response(
        JSON.stringify({ ok: false, error_code: "ENROLLMENT_REVOKED", message: "enrollment is revoked" }),
        { status: 403 }
      );
    });
    try {
      const result = await fetchAuthorizedDecks();
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, "ENROLLMENT_REVOKED");
        assert.equal(result.message, "enrollment is revoked");
      }
    } finally {
      fetchMock.mock.restore();
    }
  });
});

test("fetchAuthorizedDecks maps a 404 with no error_code to COORDINATOR_NOT_ENROLLED", async () => {
  await withEnv(ENROLLED, async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      return new Response(null, { status: 404 });
    });
    try {
      const result = await fetchAuthorizedDecks();
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, "COORDINATOR_NOT_ENROLLED");
    } finally {
      fetchMock.mock.restore();
    }
  });
});

test("fetchAuthorizedDecks reports DECK_UNAVAILABLE on a network error, never an empty list", async () => {
  await withEnv(ENROLLED, async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    try {
      const result = await fetchAuthorizedDecks();
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, "DECK_UNAVAILABLE");
    } finally {
      fetchMock.mock.restore();
    }
  });
});
