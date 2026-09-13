// packages/server/src/adapters/execution-authority.test.ts
//
// mintAuthority/revokeAuthority never throw — every Deck failure (missing enrollment,
// a typed contract error, or the backend being unreachable) comes back as a typed result
// the caller branches on (NOT-87).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-execauth-"));

const { migrate } = await import("../db/index.js");
const { mintAuthority, revokeAuthority } = await import("./execution-authority.js");

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

const MINT_INPUT = {
  runId: "run-1",
  attemptId: "attempt-1",
  deckId: "deck-1",
  ttlMs: 60_000,
  idempotencyKey: "attempt-1",
};

test("mintAuthority returns COORDINATOR_NOT_ENROLLED without calling fetch when no enrollment env is set", async () => {
  await withEnv({}, async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      throw new Error("fetch should not be called");
    });
    try {
      const result = await mintAuthority(MINT_INPUT);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, "COORDINATOR_NOT_ENROLLED");
      assert.equal(fetchMock.mock.callCount(), 0);
    } finally {
      fetchMock.mock.restore();
    }
  });
});

test("mintAuthority sends the enrollment bearer and returns the minted authority on success", async () => {
  await withEnv(ENROLLED, async () => {
    let capturedUrl = "";
    let capturedAuth = "";
    let capturedBody: Record<string, unknown> = {};
    const fetchMock = mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            authority: {
              authorityId: "authz_1",
              deckId: "deck-1",
              audience: "dealer-worker",
              allowedServices: ["slack"],
              allowedTools: [{ serviceId: "slack", toolName: "send_message" }],
              expiresAt: "2026-01-01T00:01:00Z",
            },
            authoritySecret: "authzs_secret",
            secretIssued: true,
          },
        }),
        { status: 200 }
      );
    });
    try {
      const result = await mintAuthority(MINT_INPUT);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.authority.authorityId, "authz_1");
        assert.equal(result.authority.authoritySecret, "authzs_secret");
        assert.deepEqual(result.authority.allowedTools, [{ serviceId: "slack", toolName: "send_message" }]);
      }
      assert.match(capturedUrl, /\/api\/execution-authority\/authorities$/);
      assert.equal(capturedAuth, "Bearer enr_abc:enrs_secret");
      assert.equal(capturedBody.runId, "run-1");
      assert.equal(capturedBody.idempotencyKey, "attempt-1");
      assert.equal(capturedBody.audience, "dealer-worker");
    } finally {
      fetchMock.mock.restore();
    }
  });
});

test("mintAuthority maps a typed contract error (INTERACTION_REQUIRED) instead of throwing", async () => {
  await withEnv(ENROLLED, async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      return new Response(
        JSON.stringify({ ok: false, error_code: "INTERACTION_REQUIRED", message: "Control-plane decision required" }),
        { status: 409 }
      );
    });
    try {
      const result = await mintAuthority(MINT_INPUT);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, "INTERACTION_REQUIRED");
        assert.equal(result.message, "Control-plane decision required");
      }
    } finally {
      fetchMock.mock.restore();
    }
  });
});

test("mintAuthority maps a network failure to DECK_UNAVAILABLE", async () => {
  await withEnv(ENROLLED, async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    try {
      const result = await mintAuthority(MINT_INPUT);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, "DECK_UNAVAILABLE");
    } finally {
      fetchMock.mock.restore();
    }
  });
});

test("revokeAuthority is a best-effort no-op when unreachable (never throws)", async () => {
  await withEnv(ENROLLED, async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    try {
      await assert.doesNotReject(revokeAuthority("authz_1"));
    } finally {
      fetchMock.mock.restore();
    }
  });
});

test("revokeAuthority skips the call entirely when not enrolled", async () => {
  await withEnv({}, async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      throw new Error("fetch should not be called");
    });
    try {
      await revokeAuthority("authz_1");
      assert.equal(fetchMock.mock.callCount(), 0);
    } finally {
      fetchMock.mock.restore();
    }
  });
});
