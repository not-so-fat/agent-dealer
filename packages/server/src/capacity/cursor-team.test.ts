// packages/server/src/capacity/cursor-team.test.ts
//
// NOT-249: Cursor Team Admin API adapter — mocked-HTTP coverage only, never
// a live Cursor request. Every test injects a mock fetch (all asserted URLs
// target the mock host): cycle/spend/limit keep real units, failure modes
// map to explicit N/A reasons without touching runtime health, and the key
// never reaches adapter output.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-cursor-team-"));

import {
  CURSOR_ADMIN_API_BASE_URL,
  cursorTeamSpendToReadings,
  cursorTeamUsageToReadings,
  getCursorTeamBillingSnapshot,
  ingestCursorTeamObservation,
  normalizeCursorApiDate,
  readCursorTeamBilling,
  refreshCursorTeamBilling,
  refreshCursorTeamBillingIfStale,
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

before(() => {
  migrate();
  delete process.env.CURSOR_ADMIN_API_KEY;
});

interface MockRoute {
  status: number;
  body: unknown;
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** Mock fetch keyed by path; records every call for assertion. */
function mockFetch(routes: Record<string, MockRoute | Error>, calls: RecordedCall[] = []): FetchImpl {
  return async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const u = new URL(url);
    const route = routes[u.pathname];
    if (route instanceof Error) throw route;
    if (!route) return { status: 404, text: async () => "not found" };
    const text = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
    return { status: route.status, text: async () => text };
  };
}

function okRoutes(): Record<string, MockRoute> {
  return {
    "/teams/spend": {
      status: 200,
      body: {
        billingCycleStart: "2026-09-01T00:00:00.000Z",
        billingCycleEnd: "2026-10-01T00:00:00.000Z",
        spend: 12.5,
        spendCurrency: "USD",
        hardLimit: 100,
        hardLimitCurrency: "USD",
      },
    },
    "/teams/daily-usage-data": {
      status: 200,
      body: {
        data: [
          { date: "2026-09-20", spend: 1.5, currency: "USD" },
          { date: "2026-09-21", spend: 2.0, currency: "USD" },
        ],
      },
    },
  };
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
  assert.equal(obs.billing.spendValue, 12.5);
  assert.equal(obs.billing.spendUnit, "USD");
  assert.equal(obs.billing.hardLimitValue, 100);
  assert.equal(obs.billing.hardLimitUnit, "USD");
  assert.equal(obs.billing.cycleStart, "2026-09-01T00:00:00.000Z");
  assert.equal(obs.billing.cycleEnd, "2026-10-01T00:00:00.000Z");
  assert.equal(obs.billing.usageSpendValue, 3.5);
  assert.equal(obs.billing.usageSpendUnit, "USD");
  assert.equal(obs.billing.source, "supported_protocol");
  assert.equal(obs.billing.unavailableReason, null);
  // Both documented endpoints polled; key travels header-only.
  const paths = calls.map((c) => new URL(c.url).pathname).sort();
  assert.deepEqual(paths, ["/teams/daily-usage-data", "/teams/spend"]);
  for (const c of calls) {
    assert.ok(c.url.startsWith(MOCK_BASE), `mock host only, got ${c.url}`);
    assert.equal(c.headers.Authorization, "Bearer test-key");
  }
  const usageCall = calls.find((c) => c.url.endsWith("/teams/daily-usage-data"))!;
  assert.equal(usageCall.method, "POST");
  const body = JSON.parse(usageCall.body!) as { startDate: number; endDate: number };
  assert.ok(body.endDate - body.startDate === 30 * 24 * 3600_000);
});

test("spend parsing tolerates aliases, snake_case, and epoch dates", () => {
  const readings = cursorTeamSpendToReadings({
    data: {
      cycle_start: 1756684800,
      cycle_end: 1759276800000,
      total_spend: 7.25,
      currency: "EUR",
      spend_limit: 50,
    },
  });
  assert.ok(readings);
  assert.equal(readings.cycleStart, new Date(1756684800 * 1000).toISOString());
  assert.equal(readings.cycleEnd, new Date(1759276800000).toISOString());
  assert.equal(readings.spendValue, 7.25);
  assert.equal(readings.spendUnit, "EUR");
  assert.equal(readings.hardLimitValue, 50);
  // No reported limit currency: falls back to the spend currency, never invented.
  assert.equal(readings.hardLimitUnit, "EUR");
  assert.equal(cursorTeamSpendToReadings({ nonsense: true }), null);
  assert.equal(cursorTeamSpendToReadings(null), null);
});

test("usage rows sum only on one shared currency; mixed yields null spend", () => {
  const single = cursorTeamUsageToReadings({
    data: [
      { spend: 1, currency: "USD" },
      { totalSpend: 2, currency: "usd" },
      { linesAdded: 40 },
    ],
  });
  assert.ok(single);
  assert.equal(single.spendValue, 3);
  assert.equal(single.spendUnit, "USD");
  const mixed = cursorTeamUsageToReadings({
    data: [
      { spend: 1, currency: "USD" },
      { spend: 2, currency: "EUR" },
    ],
  });
  assert.ok(mixed);
  assert.equal(mixed.spendValue, null);
  assert.equal(mixed.spendUnit, null);
  assert.equal(cursorTeamUsageToReadings({ data: [] })?.spendValue, null);
});

test("dates accept epoch seconds/ms and ISO; reject garbage", () => {
  const iso = "2026-09-01T00:00:00.000Z";
  assert.equal(normalizeCursorApiDate(Date.parse(iso) / 1000), iso);
  assert.equal(normalizeCursorApiDate(Date.parse(iso)), iso);
  assert.equal(normalizeCursorApiDate(iso), iso);
  assert.equal(normalizeCursorApiDate("garbage"), null);
  assert.equal(normalizeCursorApiDate(null), null);
  assert.equal(normalizeCursorApiDate(-5), null);
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
  routes: Record<string, MockRoute | Error>,
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
  const denied: Record<string, MockRoute> = {
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
  // Both documented paths absent: missing, not a parse verdict.
  await expectMissing({}, "unavailable");
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
          "/teams/spend": { status: 200, body: "not-json{{{" },
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
    assert.equal(readCursorTeamBillingRow()?.spendValue, 12.5);
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
    assert.equal(snap.spendValue, 12.5);
  } finally {
    delete process.env.CURSOR_ADMIN_API_KEY;
  }
});

test("stale, expired, and past-cycle snapshots read N/A with distinct reasons", async () => {
  process.env.CURSOR_ADMIN_API_KEY = "test-key";
  try {
    const now = Date.now();
    const fresh = {
      cycleStart: new Date(now - 10 * 24 * 3600_000).toISOString(),
      cycleEnd: new Date(now + 20 * 24 * 3600_000).toISOString(),
      spendValue: 12.5,
      spendUnit: "USD",
      hardLimitValue: 100,
      hardLimitUnit: "USD",
      usagePeriodStart: new Date(now - 30 * 24 * 3600_000).toISOString(),
      usagePeriodEnd: new Date(now).toISOString(),
      usageSpendValue: 3.5,
      usageSpendUnit: "USD",
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
    // Finished billing cycle → expired even inside the TTLs.
    clearCursorTeamBilling();
    writeCursorTeamBillingRow({
      ...fresh,
      cycleEnd: new Date(now - 1000).toISOString(),
      observedAt: new Date(now - 60_000).toISOString(),
      freshUntil: new Date(now + 600_000).toISOString(),
      expiresAt: new Date(now + 3600_000).toISOString(),
    });
    snap = await getCursorTeamBillingSnapshot(now);
    assert.equal(snap.spendValue, null);
    assert.equal(snap.unavailableReason, "expired");
  } finally {
    delete process.env.CURSOR_ADMIN_API_KEY;
  }
});

test("stale snapshots refresh on demand; fresh ones short-circuit", async () => {
  process.env.CURSOR_ADMIN_API_KEY = "test-key";
  try {
    clearCursorTeamBilling();
    const calls: RecordedCall[] = [];
    const now = Date.now();
    await refreshCursorTeamBillingIfStale(now, {
      key: "test-key",
      baseUrl: MOCK_BASE,
      fetchImpl: mockFetch(okRoutes(), calls),
    });
    assert.equal(calls.length, 2);
    assert.equal(readCursorTeamBillingRow()?.spendValue, 12.5);
    // Fresh snapshots short-circuit before any HTTP: a throwing fetch would
    // fail, so reaching here unchanged proves no request ran.
    await refreshCursorTeamBillingIfStale(Date.now(), {
      key: "test-key",
      baseUrl: MOCK_BASE,
      fetchImpl: () => {
        throw new Error("must not be called while fresh");
      },
    });
    assert.equal(readCursorTeamBillingRow()?.spendValue, 12.5);
  } finally {
    delete process.env.CURSOR_ADMIN_API_KEY;
  }
});

test("concurrent stale refreshes share one result", async () => {
  process.env.CURSOR_ADMIN_API_KEY = "test-key";
  try {
    clearCursorTeamBilling();
    const now = Date.now();
    const mkFetch = () => mockFetch(okRoutes(), []);
    await Promise.all([
      refreshCursorTeamBillingIfStale(now, { key: "t", baseUrl: MOCK_BASE, fetchImpl: mkFetch() }),
      refreshCursorTeamBillingIfStale(now, { key: "t", baseUrl: MOCK_BASE, fetchImpl: mkFetch() }),
    ]);
    assert.equal(readCursorTeamBillingRow()?.spendValue, 12.5);
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
  // The documented base URL is the only non-mock host the adapter may use.
  assert.equal(CURSOR_ADMIN_API_BASE_URL, "https://api.cursor.com");
});
