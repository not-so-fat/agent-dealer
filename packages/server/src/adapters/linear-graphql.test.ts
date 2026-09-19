// packages/server/src/adapters/linear-graphql.test.ts
//
// NOT-152: failed Linear GraphQL calls must log HTTP status + rate-limit headers,
// and expose a structured error so NOT-104 can back off until the reset window.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const {
  LinearHttpError,
  computeRetryAfterMs,
  getLinearUsageLogPath,
  getLinearUsageSnapshot,
  linearGraphqlRequest,
  parseLinearRateLimitHeaders,
  resetLinearUsageForTests,
  setLinearUsageLogPathForTests,
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

test("computeRetryAfterMs prefers requests-reset over Retry-After when both are set", () => {
  const now = 1_760_000_000_000;
  const ms = computeRetryAfterMs(
    429,
    {
      requestsRemaining: "0",
      requestsReset: String(now + 45_000),
      retryAfter: "5",
    },
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
  resetLinearUsageForTests();
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
    const usage = getLinearUsageSnapshot();
    assert.equal(usage.byOperation.listLinearCandidates?.error, 1);
    assert.equal(usage.byOperation.listLinearCandidates?.ok, 0);
    assert.equal(usage.lastRateLimit?.requestsRemaining, "0");
  } finally {
    errorMock.mock.restore();
    fetchMock.mock.restore();
    resetLinearUsageForTests();
  }
});

test("NOT-159: successful GraphQL increments ok counter and last requests-remaining", async () => {
  process.env.LINEAR_API_KEY = "lin_test";
  resetLinearUsageForTests();
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lin-usage-")), "linear-usage.jsonl");
  setLinearUsageLogPathForTests(logPath);
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    return new Response(JSON.stringify({ data: { viewer: { id: "u1" } } }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-RateLimit-Requests-Remaining": "2497",
        "X-RateLimit-Requests-Limit": "2500",
        "X-RateLimit-Requests-Reset": "1760000100000",
      },
    });
  });
  try {
    const data = await linearGraphqlRequest({
      operation: "getLinearViewer",
      query: "query { viewer { id } }",
    });
    assert.deepEqual(data, { viewer: { id: "u1" } });
    const usage = getLinearUsageSnapshot();
    assert.equal(usage.totalOk, 1);
    assert.equal(usage.totalError, 0);
    assert.equal(usage.byOperation.getLinearViewer?.ok, 1);
    assert.equal(usage.lastOperation, "getLinearViewer");
    assert.equal(usage.lastRateLimit?.requestsRemaining, "2497");
    assert.equal(usage.lastRateLimit?.requestsLimit, "2500");
    assert.equal(usage.logPath, logPath);
    assert.equal(getLinearUsageLogPath(), logPath);
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]!) as { kind: string; op: string; ok: boolean; requestsRemaining: string };
    assert.equal(row.kind, "call");
    assert.equal(row.op, "getLinearViewer");
    assert.equal(row.ok, true);
    assert.equal(row.requestsRemaining, "2497");
  } finally {
    fetchMock.mock.restore();
    resetLinearUsageForTests();
  }
});

test("NOT-159: counters accumulate per operation across success and failure", async () => {
  process.env.LINEAR_API_KEY = "lin_test";
  resetLinearUsageForTests();
  let n = 0;
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    n += 1;
    if (n === 2) {
      return new Response("nope", {
        status: 502,
        headers: { "X-RateLimit-Requests-Remaining": "9" },
      });
    }
    return new Response(JSON.stringify({ data: { ok: true } }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-RateLimit-Requests-Remaining": String(11 - n),
      },
    });
  });
  const errorMock = mock.method(console, "error", () => {});
  try {
    await linearGraphqlRequest({ operation: "fetchLinearBlockers", query: "query { a }" });
    await assert.rejects(() =>
      linearGraphqlRequest({ operation: "fetchLinearBlockers", query: "query { a }" })
    );
    await linearGraphqlRequest({ operation: "listLinearCandidates", query: "query { b }" });
    const usage = getLinearUsageSnapshot();
    assert.deepEqual(usage.byOperation.fetchLinearBlockers, { ok: 1, error: 1 });
    assert.deepEqual(usage.byOperation.listLinearCandidates, { ok: 1, error: 0 });
    assert.equal(usage.totalOk, 2);
    assert.equal(usage.totalError, 1);
  } finally {
    errorMock.mock.restore();
    fetchMock.mock.restore();
    resetLinearUsageForTests();
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
