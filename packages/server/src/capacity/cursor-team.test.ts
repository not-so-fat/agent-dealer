// packages/server/src/capacity/cursor-team.test.ts
//
// NOT-249: Cursor Team Admin API adapter — mocked-HTTP coverage only, never
// a live Cursor request. Every test injects a mock fetch (all asserted URLs
// target the mock host). Fixtures follow the documented Admin API shape:
// `POST /teams/spend` pages of `{ teamMemberSpend, subscriptionCycleStart,
// totalMembers, totalPages }`, Basic auth (key as username), per-member spend
// in cents, per-member limit overrides counted (never a team hard limit), no
// cycle end, and daily-usage rows carrying activity counts (never spend).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-cursor-team-"));

import {
  CURSOR_ADMIN_API_BASE_URL,
  CURSOR_TEAM_FAILURE_BACKOFF_MS,
  CURSOR_TEAM_MAX_SPEND_PAGES,
  cursorTeamAuthHeader,
  cursorTeamSpendPageToReadings,
  cursorTeamSpendPagesToReadings,
  getCursorTeamBillingSnapshot,
  ingestCursorTeamObservation,
  normalizeCursorApiDate,
  readCursorTeamBilling,
  refreshCursorTeamBilling,
  refreshCursorTeamBillingIfStale,
  resetCursorTeamPollStateForTests,
  type FetchImpl,
} from "./cursor-team.js";
const { migrate } = await import("../db/index.js");
const {
  clearCursorTeamBilling,
  readCursorTeamBillingRow,
  writeCursorTeamBillingRow,
} = await import("../repository/cursor-team-billing.js");
const {
  clearAllRuntimeAvailability,
  runtimeAvailability,
} = await import("../repository/runtime-availability.js");

const MOCK_BASE = "https://mock.test";
const CYCLE_START_MS = Date.parse("2026-09-01T00:00:00.000Z");

before(() => {
  migrate();
  delete process.env.CURSOR_ADMIN_API_KEY;
});

interface MockRoute {
  status: number;
  body: unknown;
}

type RouteValue = MockRoute | Error | ((reqBody: unknown) => MockRoute | Error);

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** Mock fetch keyed by path; records every call for assertion. */
function mockFetch(routes: Record<string, RouteValue>, calls: RecordedCall[] = []): FetchImpl {
  return async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const u = new URL(url);
    const route = routes[u.pathname];
    const resolved =
      typeof route === "function"
        ? route(init.body !== undefined ? JSON.parse(init.body) : undefined)
        : route;
    if (resolved instanceof Error) throw resolved;
    if (!resolved) return { status: 404, text: async () => "not found" };
    const text = typeof resolved.body === "string" ? resolved.body : JSON.stringify(resolved.body);
    return { status: resolved.status, text: async () => text };
  };
}

/** Documented spend shape: per-member cents, epoch-ms cycle start, paging. */
function spendPage(
  members: Array<Record<string, unknown>>,
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    teamMemberSpend: members,
    subscriptionCycleStart: CYCLE_START_MS,
    totalMembers: members.length,
    totalPages: 1,
    ...over,
  };
}

function okRoutes(): Record<string, RouteValue> {
  return {
    "/teams/spend": {
      status: 200,
      body: spendPage([
        { userId: "u1", email: "a@example.com", spendCents: 1000, fastPremiumRequests: 10 },
        {
          userId: "u2",
          email: "b@example.com",
          spendCents: 250,
          fastPremiumRequests: 2,
          hardLimitOverrideDollars: 50,
        },
      ]),
    },
    "/teams/daily-usage-data": {
      status: 200,
      // Activity/request-count rows — never spend.
      body: {
        data: [
          { date: "2026-09-20", email: "a@example.com", numRequests: 12, linesAdded: 40 },
          { date: "2026-09-21", email: "b@example.com", numRequests: 7, linesAdded: 11 },
        ],
      },
    },
  };
}

function expectedAuth(key: string): string {
  return `Basic ${Buffer.from(`${key}:`, "utf8").toString("base64")}`;
}

test("spend + usage endpoints normalize with real units and source", async () => {
  const calls: RecordedCall[] = [];
  const now = Date.now();
  const obs = await readCursorTeamBilling({
    key: "test-key",
    baseUrl: MOCK_BASE,
    fetchImpl: mockFetch(okRoutes(), calls),
    nowMs: now,
  });
  assert.equal(obs.failure, null);
  // Exact sum of per-member spendCents, kept in the reported unit.
  assert.equal(obs.billing.spendValue, 1250);
  assert.equal(obs.billing.spendUnit, "cents");
  // No team hard limit exists: the per-member override is counted, not
  // relabeled — and no cycle end is invented.
  assert.equal(obs.billing.hardLimitValue, null);
  assert.equal(obs.billing.hardLimitUnit, null);
  assert.equal(obs.billing.memberCount, 2);
  assert.equal(obs.billing.memberLimitOverrideCount, 1);
  assert.equal(obs.billing.cycleStart, "2026-09-01T00:00:00.000Z");
  assert.equal(obs.billing.cycleEnd, null);
  // Daily-usage rows carry activity counts, not spend: the queried period is
  // recorded, but no monetary value is derived from them.
  assert.equal(obs.billing.usageSpendValue, null);
  assert.equal(obs.billing.usageSpendUnit, null);
  assert.equal(obs.billing.usagePeriodEnd, new Date(now).toISOString());
  assert.equal(obs.billing.source, "supported_protocol");
  assert.equal(obs.billing.unavailableReason, null);
  // Both documented endpoints polled via POST; key travels header-only.
  const paths = calls.map((c) => new URL(c.url).pathname).sort();
  assert.deepEqual(paths, ["/teams/daily-usage-data", "/teams/spend"]);
  for (const c of calls) {
    assert.ok(c.url.startsWith(MOCK_BASE), `mock host only, got ${c.url}`);
    assert.equal(c.method, "POST");
    assert.equal(c.headers.Authorization, expectedAuth("test-key"));
    assert.ok(!c.headers.Authorization.includes("test-key"), "raw key in header");
  }
  const spendCall = calls.find((c) => c.url.endsWith("/teams/spend"))!;
  assert.deepEqual(JSON.parse(spendCall.body!), { page: 1 });
  const usageCall = calls.find((c) => c.url.endsWith("/teams/daily-usage-data"))!;
  const body = JSON.parse(usageCall.body!) as { startDate: number; endDate: number };
  assert.ok(body.endDate - body.startDate === 30 * 24 * 3600_000);
});

test("spend pagination is 1-based, sums every page, counts overrides", async () => {
  const calls: RecordedCall[] = [];
  const routes: Record<string, RouteValue> = {
    "/teams/spend": (reqBody) => {
      const page = (reqBody as { page: number }).page;
      // The Admin API page parameter starts at 1: page 0 is rejected so a
      // regression that requests it fails loudly instead of double-reading.
      if (page === 0) {
        return { status: 400, body: { error: "invalid page" } };
      }
      if (page === 1) {
        return {
          status: 200,
          body: spendPage(
            [{ userId: "u1", spendCents: 1000, fastPremiumRequests: 4 }],
            { totalMembers: 3, totalPages: 2 }
          ),
        };
      }
      if (page === 2) {
        return {
          status: 200,
          body: spendPage(
            [
              { userId: "u2", spendCents: 250, fastPremiumRequests: 1 },
              { userId: "u3", spendCents: 500, fastPremiumRequests: 9, hardLimitOverrideDollars: 20 },
            ],
            { totalMembers: 3, totalPages: 2 }
          ),
        };
      }
      return { status: 400, body: { error: `unexpected page ${page}` } };
    },
    "/teams/daily-usage-data": { status: 200, body: { data: [] } },
  };
  const obs = await readCursorTeamBilling({
    key: "test-key",
    baseUrl: MOCK_BASE,
    fetchImpl: mockFetch(routes, calls),
  });
  assert.equal(obs.failure, null);
  assert.equal(obs.billing.spendValue, 1750);
  assert.equal(obs.billing.spendUnit, "cents");
  assert.equal(obs.billing.memberCount, 3);
  assert.equal(obs.billing.memberLimitOverrideCount, 1);
  assert.equal(obs.billing.hardLimitValue, null);
  const spendPages = calls
    .filter((c) => c.url.endsWith("/teams/spend"))
    .map((c) => (JSON.parse(c.body!) as { page: number }).page);
  assert.deepEqual(spendPages, [1, 2]);
});

test("pagination stays bounded when totalPages lies", async () => {
  const calls: RecordedCall[] = [];
  const routes: Record<string, RouteValue> = {
    "/teams/spend": () => ({
      status: 200,
      body: spendPage([{ userId: "ux", spendCents: 1 }], {
        totalMembers: 1_000_000,
        totalPages: 1_000_000,
      }),
    }),
    "/teams/daily-usage-data": { status: 200, body: { data: [] } },
  };
  const obs = await readCursorTeamBilling({
    key: "test-key",
    baseUrl: MOCK_BASE,
    fetchImpl: mockFetch(routes, calls),
  });
  assert.equal(obs.failure, null);
  const spendCalls = calls.filter((c) => c.url.endsWith("/teams/spend"));
  assert.equal(spendCalls.length, CURSOR_TEAM_MAX_SPEND_PAGES);
  assert.equal(obs.billing.spendValue, CURSOR_TEAM_MAX_SPEND_PAGES);
});

test("per-member overrides never become a team hard limit", () => {
  const page = cursorTeamSpendPageToReadings(
    spendPage([
      { userId: "u1", spendCents: 100, hardLimitOverrideDollars: 75 },
      { userId: "u2", spendCents: 0 },
    ])
  );
  assert.ok(page);
  const readings = cursorTeamSpendPagesToReadings([page]);
  assert.ok(readings);
  assert.equal(readings.spendValue, 100);
  assert.equal(readings.spendUnit, "cents");
  assert.equal(readings.hardLimitValue, null);
  assert.equal(readings.hardLimitUnit, null);
  assert.equal(readings.memberLimitOverrideCount, 1);
  assert.equal(readings.cycleEnd, null);
});

test("spend parsing tolerates snake_case; empty shapes read null", () => {
  const page = cursorTeamSpendPageToReadings({
    team_member_spend: [{ userId: "u1", spend_cents: 725 }],
    subscription_cycle_start: CYCLE_START_MS,
    total_members: 1,
    total_pages: 1,
  });
  assert.ok(page);
  const readings = cursorTeamSpendPagesToReadings([page!]);
  assert.ok(readings);
  assert.equal(readings!.spendValue, 725);
  assert.equal(readings!.spendUnit, "cents");
  assert.equal(readings!.cycleStart, "2026-09-01T00:00:00.000Z");
  assert.equal(cursorTeamSpendPageToReadings(null), null);
  assert.equal(cursorTeamSpendPageToReadings("nope"), null);
  // Well-formed pages with no evidence at all fold to null (unparsable).
  assert.equal(cursorTeamSpendPagesToReadings([]), null);
  assert.equal(
    cursorTeamSpendPagesToReadings([
      cursorTeamSpendPageToReadings({ nonsense: true })!,
    ]),
    null
  );
});

test("dates accept epoch ms and ISO; reject garbage", () => {
  const iso = "2026-09-01T00:00:00.000Z";
  assert.equal(normalizeCursorApiDate(Date.parse(iso)), iso);
  assert.equal(normalizeCursorApiDate(iso), iso);
  assert.equal(normalizeCursorApiDate("garbage"), null);
  assert.equal(normalizeCursorApiDate(null), null);
  assert.equal(normalizeCursorApiDate(-5), null);
});

test("auth header is Basic with the key as username", () => {
  assert.equal(cursorTeamAuthHeader("test-key"), expectedAuth("test-key"));
  assert.ok(!cursorTeamAuthHeader("test-key").includes("test-key"));
});

test("absent key performs no HTTP and reads missing/unconfigured", async () => {
  delete process.env.CURSOR_ADMIN_API_KEY;
  const calls: RecordedCall[] = [];
  const obs = await readCursorTeamBilling({
    baseUrl: MOCK_BASE,
    fetchImpl: mockFetch(okRoutes(), calls),
  });
  assert.equal(obs.failure?.kind, "absent-key");
  assert.equal(calls.length, 0);
  const snap = await getCursorTeamBillingSnapshot();
  assert.equal(snap.configured, false);
  assert.equal(snap.unavailableReason, "missing");
  assert.equal(snap.source, "unavailable");
});

async function expectMissing(
  routes: Record<string, RouteValue>,
  kind: string
): Promise<void> {
  clearCursorTeamBilling();
  clearAllRuntimeAvailability();
  const calls: RecordedCall[] = [];
  const obs = await readCursorTeamBilling({
    key: "test-key",
    baseUrl: MOCK_BASE,
    fetchImpl: mockFetch(routes, calls),
  });
  assert.equal(obs.failure?.kind, kind);
  assert.equal(obs.billing.unavailableReason, "missing");
  // Nothing usable stored; the snapshot reads missing too.
  await ingestCursorTeamObservation(obs);
  assert.equal(readCursorTeamBillingRow(), null);
  const snap = await getCursorTeamBillingSnapshot();
  assert.equal(snap.configured, false);
  // Runtime health is untouched: no availability row, still available.
  assert.equal(runtimeAvailability("cursor_local", Date.now()).available, true);
}

test("failure modes return explicit N/A without affecting runtime health", async () => {
  // No env key here: the key travels via opts, so the snapshot assertions
  // in expectMissing observe `configured: false` with no ambient leakage.
  const denied: Record<string, RouteValue> = {
    "/teams/spend": { status: 403, body: { error: "missing admin permission" } },
    "/teams/daily-usage-data": { status: 403, body: {} },
  };
  await expectMissing(denied, "forbidden");
  await expectMissing(
    {
      "/teams/spend": { status: 401, body: {} },
      "/teams/daily-usage-data": { status: 401, body: {} },
    },
    "forbidden"
  );
  await expectMissing(
    {
      "/teams/spend": { status: 429, body: {} },
      "/teams/daily-usage-data": { status: 200, body: { data: [] } },
    },
    "rate-limited"
  );
  await expectMissing(
    {
      "/teams/spend": { status: 500, body: {} },
      "/teams/daily-usage-data": { status: 500, body: {} },
    },
    "unavailable"
  );
  await expectMissing(
    {
      "/teams/spend": new Error("socket hang up"),
      "/teams/daily-usage-data": new Error("socket hang up"),
    },
    "unavailable"
  );
  // Spend path absent and usage silent: missing, not a parse verdict.
  await expectMissing({}, "unavailable");
});

test("a daily-usage failure keeps a successful spend read (period unknown)", async () => {
  for (const usage of [
    { status: 403, body: {} },
    { status: 429, body: {} },
    { status: 500, body: {} },
  ]) {
    const obs = await readCursorTeamBilling({
      key: "test-key",
      baseUrl: MOCK_BASE,
      fetchImpl: mockFetch({
        "/teams/spend": {
          status: 200,
          body: spendPage([{ userId: "u1", spendCents: 1000 }]),
        },
        "/teams/daily-usage-data": usage,
      }),
    });
    assert.equal(obs.failure, null);
    assert.equal(obs.billing.spendValue, 1000);
    assert.equal(obs.billing.spendUnit, "cents");
    assert.equal(obs.billing.usagePeriodStart, null);
    assert.equal(obs.billing.usagePeriodEnd, null);
    assert.equal(obs.billing.source, "supported_protocol");
  }
});

test("malformed payloads read unparsable and persist as N/A", async () => {
  process.env.CURSOR_ADMIN_API_KEY = "test-key";
  try {
    clearCursorTeamBilling();
    const obs = await readCursorTeamBilling({
      key: "test-key",
      baseUrl: MOCK_BASE,
      fetchImpl: mockFetch(
        {
          "/teams/spend": { status: 200, body: { nonsense: true } },
          "/teams/daily-usage-data": { status: 200, body: { nonsense: true } },
        },
        []
      ),
    });
    assert.equal(obs.failure?.kind, "malformed");
    assert.equal(obs.billing.unavailableReason, "unparsable");
    await ingestCursorTeamObservation(obs);
    const snap = await getCursorTeamBillingSnapshot();
    assert.equal(snap.configured, true);
    assert.equal(snap.unavailableReason, "unparsable");
    assert.equal(snap.spendValue, null);
  } finally {
    delete process.env.CURSOR_ADMIN_API_KEY;
  }
});

test("transient failures never overwrite a stored snapshot", async () => {
  process.env.CURSOR_ADMIN_API_KEY = "test-key";
  try {
    clearCursorTeamBilling();
    const calls: RecordedCall[] = [];
    const now = Date.now();
    await refreshCursorTeamBilling({
      key: "test-key",
      baseUrl: MOCK_BASE,
      fetchImpl: mockFetch(okRoutes(), calls),
      nowMs: now,
    });
    assert.equal(readCursorTeamBillingRow()?.spendValue, 1250);
    assert.equal(readCursorTeamBillingRow()?.spendUnit, "cents");
    // A later 500 keeps last-known values serving (fresh → still known).
    await refreshCursorTeamBilling({
      key: "test-key",
      baseUrl: MOCK_BASE,
      fetchImpl: mockFetch({
        "/teams/spend": { status: 500, body: {} },
        "/teams/daily-usage-data": { status: 500, body: {} },
      }),
      nowMs: now + 60_000,
    });
    const snap = await getCursorTeamBillingSnapshot(now + 60_000);
    assert.equal(snap.unavailableReason, null);
    assert.equal(snap.spendValue, 1250);
  } finally {
    delete process.env.CURSOR_ADMIN_API_KEY;
  }
});

test("stale, expired, and past-cycle snapshots read N/A with distinct reasons", async () => {
  process.env.CURSOR_ADMIN_API_KEY = "test-key";
  try {
    const now = Date.now();
    const fresh = {
      cycleStart: new Date(CYCLE_START_MS).toISOString(),
      cycleEnd: null as string | null,
      spendValue: 1250,
      spendUnit: "cents",
      hardLimitValue: null as number | null,
      hardLimitUnit: null as string | null,
      memberCount: 2,
      memberLimitOverrideCount: 1,
      usagePeriodStart: new Date(now - 30 * 24 * 3600_000).toISOString(),
      usagePeriodEnd: new Date(now).toISOString(),
      usageSpendValue: null as number | null,
      usageSpendUnit: null as string | null,
      source: "supported_protocol" as const,
      unavailableReason: null,
      evidenceRef: "cursor-admin-api:teams/spend",
    };
    // Past freshness (30 min ago) but inside expiry → stale, values nulled.
    clearCursorTeamBilling();
    writeCursorTeamBillingRow({
      ...fresh,
      observedAt: new Date(now - 30 * 60_000).toISOString(),
      freshUntil: new Date(now - 15 * 60_000).toISOString(),
      expiresAt: new Date(now + 30 * 60_000).toISOString(),
    });
    let snap = await getCursorTeamBillingSnapshot(now);
    assert.equal(snap.spendValue, null);
    assert.equal(snap.unavailableReason, "stale");
    // Past expiry → expired.
    clearCursorTeamBilling();
    writeCursorTeamBillingRow({
      ...fresh,
      observedAt: new Date(now - 2 * 3600_000).toISOString(),
      freshUntil: new Date(now - 3600_000).toISOString(),
      expiresAt: new Date(now - 1000).toISOString(),
    });
    snap = await getCursorTeamBillingSnapshot(now);
    assert.equal(snap.unavailableReason, "expired");
  } finally {
    delete process.env.CURSOR_ADMIN_API_KEY;
  }
});

test("stale snapshots refresh on demand; fresh ones short-circuit", async () => {
  process.env.CURSOR_ADMIN_API_KEY = "test-key";
  try {
    clearCursorTeamBilling();
    resetCursorTeamPollStateForTests();
    const calls: RecordedCall[] = [];
    const now = Date.now();
    await refreshCursorTeamBillingIfStale(now, {
      key: "test-key",
      baseUrl: MOCK_BASE,
      fetchImpl: mockFetch(okRoutes(), calls),
    });
    assert.equal(calls.length, 2);
    assert.equal(readCursorTeamBillingRow()?.spendValue, 1250);
    // Fresh snapshots short-circuit before any HTTP: a throwing fetch would
    // fail, so reaching here unchanged proves no request ran.
    await refreshCursorTeamBillingIfStale(Date.now(), {
      key: "test-key",
      baseUrl: MOCK_BASE,
      fetchImpl: () => {
        throw new Error("must not be called while fresh");
      },
    });
    assert.equal(readCursorTeamBillingRow()?.spendValue, 1250);
  } finally {
    delete process.env.CURSOR_ADMIN_API_KEY;
  }
});

test("failed polls back off: no HTTP storm right after a 429/5xx", async () => {
  process.env.CURSOR_ADMIN_API_KEY = "test-key";
  try {
    clearCursorTeamBilling();
    resetCursorTeamPollStateForTests();
    const now = Date.now();
    const firstCalls: RecordedCall[] = [];
    await refreshCursorTeamBillingIfStale(now, {
      key: "test-key",
      baseUrl: MOCK_BASE,
      fetchImpl: mockFetch(
        {
          "/teams/spend": { status: 500, body: {} },
          "/teams/daily-usage-data": { status: 500, body: {} },
        },
        firstCalls
      ),
    });
    assert.ok(firstCalls.length > 0, "the first poll runs");
    assert.equal(readCursorTeamBillingRow(), null);
    // Immediately after the failure, the refresh backs off: a throwing fetch
    // proves no HTTP runs.
    await refreshCursorTeamBillingIfStale(now + 1000, {
      key: "test-key",
      baseUrl: MOCK_BASE,
      fetchImpl: () => {
        throw new Error("must not poll inside the failure backoff");
      },
    });
    // Past the backoff the poll runs again.
    const laterCalls: RecordedCall[] = [];
    await refreshCursorTeamBillingIfStale(now + CURSOR_TEAM_FAILURE_BACKOFF_MS + 1000, {
      key: "test-key",
      baseUrl: MOCK_BASE,
      fetchImpl: mockFetch(
        {
          "/teams/spend": { status: 500, body: {} },
          "/teams/daily-usage-data": { status: 500, body: {} },
        },
        laterCalls
      ),
    });
    assert.ok(laterCalls.length > 0, "polling resumes after the backoff");
  } finally {
    resetCursorTeamPollStateForTests();
    delete process.env.CURSOR_ADMIN_API_KEY;
  }
});

test("concurrent stale refreshes share one result", async () => {
  process.env.CURSOR_ADMIN_API_KEY = "test-key";
  try {
    clearCursorTeamBilling();
    resetCursorTeamPollStateForTests();
    const now = Date.now();
    const mkFetch = () => mockFetch(okRoutes(), []);
    await Promise.all([
      refreshCursorTeamBillingIfStale(now, { key: "t", baseUrl: MOCK_BASE, fetchImpl: mkFetch() }),
      refreshCursorTeamBillingIfStale(now, { key: "t", baseUrl: MOCK_BASE, fetchImpl: mkFetch() }),
    ]);
    assert.equal(readCursorTeamBillingRow()?.spendValue, 1250);
  } finally {
    delete process.env.CURSOR_ADMIN_API_KEY;
  }
});

test("refresh opt-out performs no HTTP and stores nothing", async () => {
  process.env.CURSOR_ADMIN_API_KEY = "test-key";
  process.env.AGENT_DEALER_CURSOR_TEAM_CAPACITY_REFRESH = "off";
  try {
    clearCursorTeamBilling();
    await refreshCursorTeamBillingIfStale(Date.now(), {
      key: "test-key",
      baseUrl: MOCK_BASE,
      fetchImpl: () => {
        throw new Error("must not be called when refresh is off");
      },
    });
    assert.equal(readCursorTeamBillingRow(), null);
  } finally {
    delete process.env.AGENT_DEALER_CURSOR_TEAM_CAPACITY_REFRESH;
    delete process.env.CURSOR_ADMIN_API_KEY;
  }
});

test("no key or raw payload reaches adapter output or evidence refs", async () => {
  const calls: RecordedCall[] = [];
  const obs = await readCursorTeamBilling({
    key: "super-secret-admin-key",
    baseUrl: MOCK_BASE,
    fetchImpl: mockFetch(okRoutes(), calls),
  });
  const raw = JSON.stringify(obs);
  assert.ok(!raw.includes("super-secret-admin-key"), "key leaked into observation");
  for (const secret of ["Bearer", "password", "token"]) {
    assert.ok(!raw.toLowerCase().includes(secret), `leaked ${secret}`);
  }
  assert.equal(obs.evidenceRef, "cursor-admin-api:teams/spend");
  for (const c of calls) {
    assert.ok(c.headers.Authorization.startsWith("Basic "), "documented Basic auth");
    assert.ok(!c.headers.Authorization.includes("super-secret-admin-key"), "raw key in header");
  }
  // The documented base URL is the only non-mock host the adapter may use.
  assert.equal(CURSOR_ADMIN_API_BASE_URL, "https://api.cursor.com");
});
