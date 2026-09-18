// packages/server/src/adapters/linear-graphql.test.ts
//
// NOT-152: failed Linear GraphQL calls must log HTTP status + rate-limit headers,
// and expose a structured error so NOT-104 can back off until the reset window.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const {
  LinearHttpError,
  computeRetryAfterMs,
  linearGraphqlRequest,
  parseLinearRateLimitHeaders,
} = await import("./linear-graphql.js");

test("parseLinearRateLimitHeaders reads requests + complexity headers", () => {
  const headers = new Headers({
    "X-RateLimit-Requests-Limit": "2500",
    "X-RateLimit-Requests-Remaining": "0",
    "X-RateLimit-Requests-Reset": "1760000000000",
    "X-RateLimit-Complexity-Limit": "1000000",
    "X-RateLimit-Complexity-Remaining": "12",
    "X-RateLimit-Complexity-Reset": "1760000000000",
    "X-Complexity": "42",
  });
  assert.deepEqual(parseLinearRateLimitHeaders(headers), {
    requestsLimit: "2500",
    requestsRemaining: "0",
    requestsReset: "1760000000000",
    complexityLimit: "1000000",
    complexityRemaining: "12",
    complexityReset: "1760000000000",
    complexity: "42",
  });
});

test("computeRetryAfterMs uses Linear reset epoch-ms on 429", () => {
  const now = 1_760_000_000_000;
  const ms = computeRetryAfterMs(
    429,
    { requestsRemaining: "0", requestsReset: String(now + 45_000) },
    now
  );
  assert.equal(ms, 45_000);
});

test("computeRetryAfterMs falls back to Retry-After seconds when reset missing", () => {
  const ms = computeRetryAfterMs(429, { retryAfter: "30" }, 1_000);
  assert.equal(ms, 30_000);
});

test("linearGraphqlRequest logs HTTP status and rate-limit headers on non-OK", async () => {
  process.env.LINEAR_API_KEY = "lin_test";
  const errors: unknown[][] = [];
  const errorMock = mock.method(console, "error", (...args: unknown[]) => {
    errors.push(args);
  });
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    return new Response("rate limited", {
      status: 429,
      headers: {
        "X-RateLimit-Requests-Remaining": "0",
        "X-RateLimit-Requests-Reset": "1760000045000",
        "X-RateLimit-Requests-Limit": "2500",
      },
    });
  });
  try {
    await assert.rejects(
      () =>
        linearGraphqlRequest({
          operation: "listLinearCandidates",
          query: "query { viewer { id } }",
        }),
      (err: unknown) => {
        assert.ok(err instanceof LinearHttpError);
        assert.equal(err.status, 429);
        assert.equal(err.operation, "listLinearCandidates");
        assert.equal(err.rateLimit.requestsRemaining, "0");
        assert.equal(err.rateLimit.requestsReset, "1760000045000");
        assert.match(err.message, /429/);
        return true;
      }
    );
    const joined = errors.map((a) => a.map(String).join(" ")).join("\n");
    assert.match(joined, /\[linear\]/);
    assert.match(joined, /listLinearCandidates/);
    assert.match(joined, /429/);
    assert.match(joined, /requests-remaining[=:]?\s*0/i);
    assert.match(joined, /requests-reset[=:]?\s*1760000045000/i);
  } finally {
    errorMock.mock.restore();
    fetchMock.mock.restore();
  }
});

test("listLinearCandidates leaves a [linear] log line on HTTP 502 (intake path)", async () => {
  // Mirrors GET /api/intake/linear: route returns String(e) to the client; dealer logs must
  // still carry status + rate-limit headers from linearGraphqlRequest.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not152-"));
  process.env.LINEAR_API_KEY = "lin_test";
  const { migrate } = await import("../db/index.js");
  migrate();
  const { listLinearCandidates } = await import("./linear-inbox.js");

  const errors: unknown[][] = [];
  const errorMock = mock.method(console, "error", (...args: unknown[]) => {
    errors.push(args);
  });
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    return new Response("bad gateway", {
      status: 502,
      headers: {
        "X-RateLimit-Requests-Remaining": "12",
        "X-RateLimit-Requests-Reset": "1760000099000",
      },
    });
  });
  try {
    await assert.rejects(() => listLinearCandidates(), (err: unknown) => {
      assert.ok(err instanceof LinearHttpError);
      assert.equal(err.status, 502);
      assert.equal(err.operation, "listLinearCandidates");
      return true;
    });
    const joined = errors.map((a) => a.map(String).join(" ")).join("\n");
    assert.match(joined, /\[linear\]/);
    assert.match(joined, /listLinearCandidates/);
    assert.match(joined, /status=502/);
    assert.match(joined, /requests-remaining=12/);
    assert.match(joined, /requests-reset=1760000099000/);
  } finally {
    errorMock.mock.restore();
    fetchMock.mock.restore();
  }
});
