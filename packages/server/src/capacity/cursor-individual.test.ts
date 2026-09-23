// packages/server/src/capacity/cursor-individual.test.ts
//
// NOT-250: experimental Cursor Individual dashboard adapter — mocked-HTTP
// coverage only, never the real local login nor the live dashboard. Every
// test injects a mock fetch (all asserted URLs target the allowlisted mock
// host `https://www.cursor.com`, which the mock intercepts) and temporary
// fixture credential files. Fixture payloads follow the brief's
// usage-summary/current-period shape; nothing here assumes those routes are
// a supported contract.
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-cursor-indiv-"));

import {
  CURSOR_INDIVIDUAL_ALLOWED_ORIGINS,
  CURSOR_INDIVIDUAL_DEFAULT_ORIGIN,
  CURSOR_INDIVIDUAL_MAX_BODY_BYTES,
  CURSOR_INDIVIDUAL_OPT_IN_ENV,
  CURSOR_INDIVIDUAL_OPT_IN_VALUE,
  CURSOR_INDIVIDUAL_USAGE_PATHS,
  cursorIndividualCapacityAdapter,
  cursorIndividualFailureReason,
  cursorIndividualPayloadToReadings,
  getCursorIndividualBillingSnapshot,
  ingestCursorIndividualObservation,
  isCursorIndividualExperimentalEnabled,
  readBoundedText,
  readCursorIndividualBilling,
  refreshCursorIndividualBilling,
  refreshCursorIndividualBillingIfStale,
  refreshCursorIndividualCapacityIfStale,
  resetCursorIndividualPollStateForTests,
  type FetchImpl,
} from "./cursor-individual.js";
import {
  CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV,
  cursorIndividualAuthHeader,
} from "./cursor-individual-credentials.js";

const { migrate } = await import("../db/index.js");
const {
  clearCursorIndividualBilling,
  readCursorIndividualBillingRow,
} = await import("../repository/cursor-individual-billing.js");
const { clearAllCapacitySnapshots } = await import("../repository/runtime-capacity.js");
const {
  clearAllRuntimeAvailability,
  runtimeAvailability,
} = await import("../repository/runtime-availability.js");
const { getRuntimeCapacitySnapshot } = await import("./service.js");
const { normalizeAdapterWindow, DEFAULT_STALE_AFTER_MS } = await import("./adapter.js");

const MOCK_BASE = "https://www.cursor.com";
const SECRET = "fixture-individual-secret-xyz789";
const USER_ID = "user_fixture_individual_abc";

let credDir: string;
let savedOptIn: string | undefined;
let savedCredFile: string | undefined;
let savedRefresh: string | undefined;

before(() => {
  migrate();
});

beforeEach(() => {
  credDir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-cursor-indiv-creds-"));
  savedOptIn = process.env[CURSOR_INDIVIDUAL_OPT_IN_ENV];
  savedCredFile = process.env[CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV];
  savedRefresh = process.env.AGENT_DEALER_CURSOR_INDIVIDUAL_REFRESH;
  delete process.env[CURSOR_INDIVIDUAL_OPT_IN_ENV];
  delete process.env[CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV];
  delete process.env.AGENT_DEALER_CURSOR_INDIVIDUAL_REFRESH;
  clearCursorIndividualBilling();
  clearAllCapacitySnapshots();
  clearAllRuntimeAvailability();
  resetCursorIndividualPollStateForTests();
});

afterEach(() => {
  if (savedOptIn === undefined) delete process.env[CURSOR_INDIVIDUAL_OPT_IN_ENV];
  else process.env[CURSOR_INDIVIDUAL_OPT_IN_ENV] = savedOptIn;
  if (savedCredFile === undefined) delete process.env[CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV];
  else process.env[CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV] = savedCredFile;
  if (savedRefresh === undefined) delete process.env.AGENT_DEALER_CURSOR_INDIVIDUAL_REFRESH;
  else process.env.AGENT_DEALER_CURSOR_INDIVIDUAL_REFRESH = savedRefresh;
  fs.rmSync(credDir, { recursive: true, force: true });
});

function enable(): void {
  process.env[CURSOR_INDIVIDUAL_OPT_IN_ENV] = CURSOR_INDIVIDUAL_OPT_IN_VALUE;
}

function fixtureCredential(body: unknown = { token: SECRET, userId: USER_ID }): void {
  const file = path.join(credDir, "auth.json");
  fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
  process.env[CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV] = file;
}

interface MockRoute {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

type RouteValue = MockRoute | Error | ((callCount: number) => MockRoute | Error);

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/** Mock fetch keyed by path; records every call for assertion. */
function mockFetch(routes: Record<string, RouteValue>, calls: RecordedCall[] = []): FetchImpl {
  let count = 0;
  return async (url, init) => {
    count += 1;
    if (init.signal.aborted) throw new Error("aborted");
    calls.push({ url, method: init.method, headers: init.headers });
    const u = new URL(url);
    const route = routes[u.pathname];
    const resolved = typeof route === "function" ? route(count) : route;
    if (resolved instanceof Error) throw resolved;
    if (!resolved) return { status: 404, headers: {}, text: async () => "not found" };
    const text =
      typeof resolved.body === "string" ? resolved.body : JSON.stringify(resolved.body ?? {});
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(resolved.headers ?? {})) headers[k.toLowerCase()] = v;
    return { status: resolved.status, headers, text: async () => text };
  };
}

function usagePayload(nowMs: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cycleLabel: "September 2026",
    cycleStart: "2026-09-01T00:00:00.000Z",
    cycleEnd: new Date(nowMs + 8 * 24 * 3600_000).toISOString(),
    usageValue: 7.5,
    usageUnit: "USD",
    usedPercent: 37.5,
    ...over,
  };
}

function okRoutes(nowMs: number): Record<string, RouteValue> {
  return { [CURSOR_INDIVIDUAL_USAGE_PATHS[0]]: { status: 200, body: usagePayload(nowMs) } };
}

test("disabled reads N/A with no credential or endpoint access", async () => {
  delete process.env[CURSOR_INDIVIDUAL_OPT_IN_ENV];
  assert.equal(isCursorIndividualExperimentalEnabled(), false);
  fixtureCredential();
  const calls: RecordedCall[] = [];
  const loadCredential = () => {
    throw new Error("credential must not be read while disabled");
  };
  const fetchImpl: FetchImpl = async () => {
    throw new Error("HTTP must not be attempted while disabled");
  };
  const obs = await readCursorIndividualBilling({
    baseUrl: MOCK_BASE,
    fetchImpl,
    loadCredential,
  });
  assert.equal(obs.failure?.kind, "disabled");
  assert.equal(obs.enabled, false);
  assert.equal(obs.configured, false);
  assert.equal(obs.billing.source, "unavailable");
  assert.equal(obs.billing.unavailableReason, "missing");
  void calls;
  // The adapter degrades to an explicit unavailable reading, same conditions.
  const result = await cursorIndividualCapacityAdapter({
    baseUrl: MOCK_BASE,
    fetchImpl,
    loadCredential,
  }).read();
  assert.equal(result.windows.length, 0);
  assert.equal(result.unavailable.length, 1);
  assert.equal(result.unavailable[0].windowKey, "billing_cycle");
  assert.equal(result.unavailable[0].reason, "missing");
  // Stale refreshes are strict no-ops while disabled.
  await refreshCursorIndividualBillingIfStale();
  await refreshCursorIndividualCapacityIfStale();
  assert.equal(readCursorIndividualBillingRow(), null);
  // And the serve path reads disabled without touching the database.
  const snap = await getCursorIndividualBillingSnapshot();
  assert.equal(snap.enabled, false);
  assert.equal(snap.configured, false);
  assert.equal(snap.unavailableReason, "missing");
});

test("opt-in with fixture credential/response reports cycle label/reset/remaining", async () => {
  enable();
  fixtureCredential();
  const now = Date.now();
  const calls: RecordedCall[] = [];
  const obs = await readCursorIndividualBilling({
    baseUrl: MOCK_BASE,
    fetchImpl: mockFetch(okRoutes(now), calls),
    nowMs: now,
  });
  assert.equal(obs.failure, null);
  assert.equal(obs.enabled, true);
  assert.equal(obs.configured, true);
  assert.equal(obs.viaSupportedApi, false);
  assert.equal(obs.billing.cycleLabel, "September 2026");
  assert.equal(obs.billing.cycleStart, "2026-09-01T00:00:00.000Z");
  assert.equal(obs.billing.cycleEnd, new Date(now + 8 * 24 * 3600_000).toISOString());
  assert.equal(obs.billing.usageValue, 7.5);
  assert.equal(obs.billing.usageUnit, "USD");
  // 37.5% used → 62.5 remaining — no unsupported windows guessed.
  assert.equal(obs.billing.remainingPercent, 62.5);
  assert.equal(obs.billing.source, "experimental_api");
  assert.equal(obs.billing.unavailableReason, null);
  assert.equal(obs.evidenceRef, "cursor-dashboard:usage-summary/current-period");
  // Allowlisted origin, GET, credential header-only (never in URL/body).
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith(MOCK_BASE), `mock host only, got ${calls[0].url}`);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].headers.Cookie, cursorIndividualAuthHeader(USER_ID, SECRET));
  const url = new URL(calls[0].url);
  assert.ok(!url.search.includes(SECRET) && !url.pathname.includes(SECRET));
  // The raw token appears nowhere outside the in-memory auth header.
  const serialized = JSON.stringify({ billing: obs.billing, failure: obs.failure });
  assert.ok(!serialized.includes(SECRET), "raw token must not appear in the observation");
});

test("adapter maps billing to one billing-cycle window without invented durations", async () => {
  enable();
  fixtureCredential();
  const now = Date.now();
  const result = await cursorIndividualCapacityAdapter({
    baseUrl: MOCK_BASE,
    fetchImpl: mockFetch(okRoutes(now)),
    nowMs: now,
  }).read(now);
  assert.equal(result.runtime, "cursor_local");
  assert.equal(result.unavailable.length, 0);
  assert.equal(result.windows.length, 1);
  const w = result.windows[0];
  assert.equal(w.windowKey, "billing_cycle");
  assert.equal(w.providerBucket, "individual");
  assert.equal(w.durationMinutes, null);
  assert.equal(w.source, "experimental_api");
  assert.equal(w.resetAt, new Date(now + 8 * 24 * 3600_000).toISOString());
  // Normalization keeps the provider label (no 5H/1W invention) and recovers
  // the remaining percent through the shared used scale.
  const normalized = normalizeAdapterWindow("cursor_local", w, now);
  assert.equal(normalized.displayLabel, "billing cycle");
  assert.equal(normalized.remainingPercent, 62.5);
  assert.equal(normalized.unavailableReason, null);
});

test("supported surface is preferred and skips credential + dashboard", async () => {
  enable();
  fixtureCredential();
  const now = Date.now();
  const fetchImpl: FetchImpl = async () => {
    throw new Error("dashboard must not be touched when a supported API answers");
  };
  const obs = await readCursorIndividualBilling({
    baseUrl: MOCK_BASE,
    fetchImpl,
    loadCredential: () => {
      throw new Error("credential must not be read when a supported API answers");
    },
    supportedReader: () => ({
      cycleLabel: "September 2026",
      cycleEnd: new Date(now + 8 * 24 * 3600_000).toISOString(),
      remainingPercent: 80,
    }),
    nowMs: now,
  });
  assert.equal(obs.failure, null);
  assert.equal(obs.viaSupportedApi, true);
  assert.equal(obs.billing.source, "supported_protocol");
  assert.equal(obs.billing.cycleLabel, "September 2026");
  assert.equal(obs.billing.remainingPercent, 80);
});

test("absent credential performs no HTTP and reads missing/unconfigured", async () => {
  enable();
  process.env[CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV] = path.join(credDir, "does-not-exist.json");
  const calls: RecordedCall[] = [];
  const obs = await readCursorIndividualBilling({
    baseUrl: MOCK_BASE,
    fetchImpl: mockFetch(okRoutes(Date.now()), calls),
  });
  assert.equal(obs.failure?.kind, "absent-credential");
  assert.equal(obs.configured, false);
  assert.equal(calls.length, 0);
  await ingestCursorIndividualObservation(obs);
  assert.equal(readCursorIndividualBillingRow(), null);
  const snap = await getCursorIndividualBillingSnapshot();
  assert.equal(snap.enabled, true);
  assert.equal(snap.configured, false);
  assert.equal(snap.unavailableReason, "missing");
});

test("changed credential format reads unparsable", async () => {
  enable();
  fixtureCredential({ brandNewShape: true });
  const calls: RecordedCall[] = [];
  const obs = await readCursorIndividualBilling({
    baseUrl: MOCK_BASE,
    fetchImpl: mockFetch(okRoutes(Date.now()), calls),
  });
  assert.equal(obs.failure?.kind, "bad-credential");
  assert.equal(obs.billing.unavailableReason, "unparsable");
  assert.equal(calls.length, 0);
  assert.equal(cursorIndividualFailureReason("bad-credential"), "unparsable");
});

test("endpoint drift falls through to the next candidate path", async () => {
  enable();
  fixtureCredential();
  const now = Date.now();
  const calls: RecordedCall[] = [];
  const obs = await readCursorIndividualBilling({
    baseUrl: MOCK_BASE,
    fetchImpl: mockFetch(
      {
        [CURSOR_INDIVIDUAL_USAGE_PATHS[0]]: { status: 404, body: {} },
        [CURSOR_INDIVIDUAL_USAGE_PATHS[1]]: { status: 200, body: usagePayload(now) },
      },
      calls
    ),
    nowMs: now,
  });
  assert.equal(obs.failure, null);
  assert.equal(obs.billing.cycleLabel, "September 2026");
  assert.equal(obs.billing.remainingPercent, 62.5);
  assert.equal(calls.length, 2);
});

test("failure modes return explicit N/A without affecting runtime health", async () => {
  enable();
  fixtureCredential();
  async function expectOutcome(
    routes: Record<string, RouteValue>,
    kind: string,
    reason: "missing" | "unparsable"
  ): Promise<void> {
    clearCursorIndividualBilling();
    clearAllRuntimeAvailability();
    const obs = await readCursorIndividualBilling({
      baseUrl: MOCK_BASE,
      fetchImpl: mockFetch(routes),
    });
    assert.equal(obs.failure?.kind, kind);
    assert.equal(obs.billing.unavailableReason, reason);
    await ingestCursorIndividualObservation(obs);
    assert.equal(runtimeAvailability("cursor_local", Date.now()).available, true);
  }
  const ep = CURSOR_INDIVIDUAL_USAGE_PATHS[0];
  await expectOutcome({ [ep]: { status: 401, body: {} } }, "forbidden", "missing");
  await expectOutcome({ [ep]: { status: 403, body: {} } }, "forbidden", "missing");
  await expectOutcome({ [ep]: { status: 429, body: {} } }, "rate-limited", "missing");
  await expectOutcome({ [ep]: { status: 500, body: {} } }, "unavailable", "missing");
  await expectOutcome({ [ep]: new Error("socket hang up") }, "unavailable", "missing");
  // Both candidate paths absent: endpoint drift reads missing, not a parse verdict.
  await expectOutcome({}, "unavailable", "missing");
  // Malformed data reads unparsable.
  await expectOutcome({ [ep]: { status: 200, body: { nonsense: true } } }, "malformed", "unparsable");
  await expectOutcome({ [ep]: { status: 200, body: "not-json{{{" } }, "malformed", "unparsable");
  await expectOutcome(
    { [ep]: { status: 200, body: "x".repeat(CURSOR_INDIVIDUAL_MAX_BODY_BYTES + 1) } },
    "malformed",
    "unparsable"
  );
});

test("timeout degrades to an explicit unavailable reason", async () => {
  enable();
  fixtureCredential();
  const hanging: FetchImpl = async (_url, init) =>
    new Promise((_resolve, reject) => {
      if (init.signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  const obs = await readCursorIndividualBilling({
    baseUrl: MOCK_BASE,
    fetchImpl: hanging,
    timeoutMs: 20,
  });
  assert.equal(obs.failure?.kind, "unavailable");
  assert.equal(obs.billing.unavailableReason, "missing");
});

test("the same deadline also covers a stalled body read, not just the header response", async () => {
  enable();
  fixtureCredential();
  // Headers arrive immediately (200), but the body stream never delivers —
  // the SAME per-hop timeout must still fire and abort it. Before the fix,
  // the timer was cleared right after headers arrived, so a server that
  // sent headers and then stalled left the request pending indefinitely.
  const stallingBody: FetchImpl = async (_url, init) => ({
    status: 200,
    headers: {},
    text: () =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  });
  const started = Date.now();
  const obs = await readCursorIndividualBilling({
    baseUrl: MOCK_BASE,
    fetchImpl: stallingBody,
    timeoutMs: 20,
  });
  assert.ok(Date.now() - started < 5000, "the stalled body read must be aborted, not hang");
  assert.equal(obs.failure?.kind, "unavailable");
  assert.equal(obs.billing.unavailableReason, "missing");
});

test("unsafe redirects are rejected before the credential travels", async () => {
  enable();
  fixtureCredential();
  const calls: RecordedCall[] = [];
  const obs = await readCursorIndividualBilling({
    baseUrl: MOCK_BASE,
    fetchImpl: mockFetch(
      {
        [CURSOR_INDIVIDUAL_USAGE_PATHS[0]]: {
          status: 302,
          headers: { location: "https://evil.example/capture" },
          body: {},
        },
      },
      calls
    ),
  });
  assert.equal(obs.failure?.kind, "unsafe-redirect");
  assert.equal(obs.billing.unavailableReason, "missing");
  // Exactly one request left the client — nothing followed the evil Location.
  assert.equal(calls.length, 1);
  assert.ok(!calls.some((c) => c.url.includes("evil.example")));
});

test("same-allowlist redirects are followed", async () => {
  enable();
  fixtureCredential();
  const now = Date.now();
  const calls: RecordedCall[] = [];
  const obs = await readCursorIndividualBilling({
    baseUrl: MOCK_BASE,
    fetchImpl: mockFetch(
      {
        [CURSOR_INDIVIDUAL_USAGE_PATHS[0]]: {
          status: 302,
          headers: { location: "https://api.cursor.com/api/usage-summary" },
          body: {},
        },
        [CURSOR_INDIVIDUAL_USAGE_PATHS[1]]: { status: 200, body: usagePayload(now) },
      },
      calls
    ),
    nowMs: now,
  });
  // The redirect target answers under the other allowlisted origin.
  assert.equal(obs.failure, null);
  assert.equal(obs.billing.cycleLabel, "September 2026");
});

test("the default origin is the bare apex domain, and www's canonical redirect to it succeeds", async () => {
  // www.cursor.com canonicalizes to cursor.com — that redirect target must
  // itself be allowlisted, or the adapter would reject its own default.
  assert.equal(CURSOR_INDIVIDUAL_DEFAULT_ORIGIN, "https://cursor.com");
  assert.ok((CURSOR_INDIVIDUAL_ALLOWED_ORIGINS as readonly string[]).includes("https://cursor.com"));
  enable();
  fixtureCredential();
  const now = Date.now();
  const obs = await readCursorIndividualBilling({
    baseUrl: MOCK_BASE, // https://www.cursor.com
    fetchImpl: mockFetch({
      [CURSOR_INDIVIDUAL_USAGE_PATHS[0]]: (count) =>
        count === 1
          ? { status: 301, headers: { location: `https://cursor.com${CURSOR_INDIVIDUAL_USAGE_PATHS[0]}` }, body: {} }
          : { status: 200, body: usagePayload(now) },
    }),
    nowMs: now,
  });
  assert.equal(obs.failure, null);
  assert.equal(obs.billing.cycleLabel, "September 2026");
});

test("non-allowlisted base URLs are rejected without any HTTP", async () => {
  enable();
  fixtureCredential();
  const calls: RecordedCall[] = [];
  const obs = await readCursorIndividualBilling({
    baseUrl: "https://evil.example",
    fetchImpl: mockFetch({}, calls),
  });
  assert.equal(obs.failure?.kind, "unsafe-redirect");
  assert.equal(calls.length, 0);
});

test("malformed payloads persist as N/A; transient failures keep last-known values", async () => {
  enable();
  fixtureCredential();
  const now = Date.now();
  const good = {
    baseUrl: MOCK_BASE,
    fetchImpl: mockFetch(okRoutes(now)),
    nowMs: now,
  };
  await refreshCursorIndividualBilling(good);
  const stored = readCursorIndividualBillingRow();
  assert.equal(stored?.cycleLabel, "September 2026");
  assert.equal(stored?.remainingPercent, 62.5);
  assert.equal(stored?.source, "experimental_api");
  assert.ok(!JSON.stringify(stored).includes(SECRET), "stored row must not carry the token");
  let snap = await getCursorIndividualBillingSnapshot(now);
  assert.equal(snap.enabled, true);
  assert.equal(snap.configured, true);
  assert.equal(snap.unavailableReason, null);
  assert.equal(snap.remainingPercent, 62.5);
  assert.ok(!JSON.stringify(snap).includes(SECRET), "browser response must not carry the token");
  // A later 500 keeps last-known values serving.
  await refreshCursorIndividualBilling({
    baseUrl: MOCK_BASE,
    fetchImpl: mockFetch({ [CURSOR_INDIVIDUAL_USAGE_PATHS[0]]: { status: 500, body: {} } }),
    nowMs: now + 60_000,
  });
  snap = await getCursorIndividualBillingSnapshot(now + 60_000);
  assert.equal(snap.unavailableReason, null);
  assert.equal(snap.remainingPercent, 62.5);
  // Malformed data overwrites with an explicit unparsable N/A.
  await refreshCursorIndividualBilling({
    baseUrl: MOCK_BASE,
    fetchImpl: mockFetch({ [CURSOR_INDIVIDUAL_USAGE_PATHS[0]]: { status: 200, body: { nope: 1 } } }),
    nowMs: now + 120_000,
  });
  snap = await getCursorIndividualBillingSnapshot(now + 120_000);
  assert.equal(snap.unavailableReason, "unparsable");
  assert.equal(snap.remainingPercent, null);
});

test("a bad-credential response overwrites the stored billing row too — the other non-transient sibling (billing table)", async () => {
  // ingestCursorIndividualObservation() has the same two-kind non-transient
  // gate (malformed, bad-credential) as pollCursorIndividualShared's
  // capacity-strip write — malformed-overwrites-billing is covered above;
  // cover the bad-credential sibling at this (billing-table) layer too.
  enable();
  fixtureCredential();
  const now = Date.now();
  await refreshCursorIndividualBilling({
    baseUrl: MOCK_BASE,
    fetchImpl: mockFetch(okRoutes(now)),
    nowMs: now,
  });
  let snap = await getCursorIndividualBillingSnapshot(now);
  assert.equal(snap.remainingPercent, 62.5);
  // The credential file changes shape before the next refresh.
  fixtureCredential({ brandNewShape: true });
  await refreshCursorIndividualBilling({
    baseUrl: MOCK_BASE,
    fetchImpl: mockFetch(okRoutes(now + 60_000)),
    nowMs: now + 60_000,
  });
  snap = await getCursorIndividualBillingSnapshot(now + 60_000);
  assert.equal(snap.unavailableReason, "unparsable");
  assert.equal(snap.remainingPercent, null);
});

test("stale, expired, and past-cycle snapshots read N/A with distinct reasons", async () => {
  enable();
  fixtureCredential();
  const now = Date.now();
  const { writeCursorIndividualBillingRow } = await import(
    "../repository/cursor-individual-billing.js"
  );
  const fresh = {
    cycleLabel: "September 2026",
    cycleStart: "2026-09-01T00:00:00.000Z",
    cycleEnd: new Date(now + 8 * 24 * 3600_000).toISOString(),
    usageValue: 7.5,
    usageUnit: "USD",
    remainingPercent: 62.5,
    source: "experimental_api" as const,
    unavailableReason: null,
    evidenceRef: "cursor-dashboard:usage-summary/current-period",
  };
  clearCursorIndividualBilling();
  writeCursorIndividualBillingRow({
    ...fresh,
    observedAt: new Date(now - 30 * 60_000).toISOString(),
    freshUntil: new Date(now - 15 * 60_000).toISOString(),
    expiresAt: new Date(now + 30 * 60_000).toISOString(),
  });
  let snap = await getCursorIndividualBillingSnapshot(now);
  assert.equal(snap.remainingPercent, null);
  assert.equal(snap.unavailableReason, "stale");
  writeCursorIndividualBillingRow({
    ...fresh,
    observedAt: new Date(now - 2 * 3600_000).toISOString(),
    freshUntil: new Date(now - 3600_000).toISOString(),
    expiresAt: new Date(now - 1000).toISOString(),
  });
  snap = await getCursorIndividualBillingSnapshot(now);
  assert.equal(snap.unavailableReason, "expired");
  // A finished billing cycle is never presented as current capacity.
  writeCursorIndividualBillingRow({
    ...fresh,
    cycleEnd: new Date(now - 1000).toISOString(),
    observedAt: new Date(now - 60_000).toISOString(),
    freshUntil: new Date(now + 600_000).toISOString(),
    expiresAt: new Date(now + 3600_000).toISOString(),
  });
  snap = await getCursorIndividualBillingSnapshot(now);
  assert.equal(snap.remainingPercent, null);
  assert.equal(snap.unavailableReason, "expired");
});

test("capacity-strip refresh ingests the billing-cycle window; disabled writes nothing", async () => {
  enable();
  fixtureCredential();
  const now = Date.now();
  await refreshCursorIndividualCapacityIfStale(now, {
    baseUrl: MOCK_BASE,
    fetchImpl: mockFetch(okRoutes(now)),
    nowMs: now,
  });
  let snap = getRuntimeCapacitySnapshot(now);
  const cursor = snap.runtimes.find((r) => r.runtime === "cursor_local")!;
  assert.ok(cursor, "cursor_local entry exists from the stored window");
  assert.equal(cursor.windows.length, 1);
  assert.equal(cursor.windows[0].windowKey, "billing_cycle");
  assert.equal(cursor.windows[0].displayLabel, "billing cycle");
  assert.equal(cursor.windows[0].remainingPercent, 62.5);
  assert.equal(cursor.windows[0].source, "experimental_api");
  assert.equal(cursor.unavailableReason, null);
  assert.ok(!JSON.stringify(snap).includes(SECRET));
  // Disabled: strict no-op, existing rows untouched.
  delete process.env[CURSOR_INDIVIDUAL_OPT_IN_ENV];
  clearAllCapacitySnapshots();
  await refreshCursorIndividualCapacityIfStale(now, {
    baseUrl: MOCK_BASE,
    fetchImpl: async () => {
      throw new Error("no HTTP while disabled");
    },
    nowMs: now,
  });
  snap = getRuntimeCapacitySnapshot(now);
  assert.ok(
    !snap.runtimes.some((r) => r.runtime === "cursor_local" && r.windows.length > 0),
    "no individual window is written while disabled"
  );
});

test("capacity-strip refresh is stale-aware: a fresh stored window skips HTTP, concurrent callers single-flight", async () => {
  enable();
  fixtureCredential();
  const now = Date.now();
  let calls = 0;
  const opts = {
    baseUrl: MOCK_BASE,
    fetchImpl: mockFetch(okRoutes(now)) as FetchImpl,
    nowMs: now,
  };
  const countingFetch: FetchImpl = async (url, init) => {
    calls += 1;
    return opts.fetchImpl(url, init);
  };
  // Two calls one millisecond apart against an empty store: both see the
  // stored snapshot as missing, so — absent single-flight — each would fire
  // its own dashboard request. They must share one instead.
  await Promise.all([
    refreshCursorIndividualCapacityIfStale(now, { ...opts, fetchImpl: countingFetch }),
    refreshCursorIndividualCapacityIfStale(now + 1, { ...opts, fetchImpl: countingFetch }),
  ]);
  assert.equal(calls, 1, "concurrent refreshes single-flight into one HTTP call");
  // A third call immediately after, against the now-fresh stored window,
  // must not poll again either.
  await refreshCursorIndividualCapacityIfStale(now + 2, { ...opts, fetchImpl: countingFetch });
  assert.equal(calls, 1, "a fresh stored window is served with no further HTTP");
});

test("the billing-card and capacity-strip refresh paths share one poll, not two", async () => {
  // The two paths read different stored tables (cursor_individual_billing
  // vs runtime_capacity_snapshots), so each independently sees an empty
  // database as stale. Without a shared single-flight, the billing card and
  // the capacity strip mounting at once — the real Agents-page shape — fire
  // two separate dashboard polls.
  enable();
  fixtureCredential();
  const now = Date.now();
  let calls = 0;
  const baseFetch = mockFetch(okRoutes(now));
  const countingFetch: FetchImpl = async (url, init) => {
    calls += 1;
    return baseFetch(url, init);
  };
  const opts = { baseUrl: MOCK_BASE, fetchImpl: countingFetch, nowMs: now };
  await Promise.all([
    refreshCursorIndividualBillingIfStale(now, opts),
    refreshCursorIndividualCapacityIfStale(now, opts),
  ]);
  assert.equal(calls, 1, "both refresh paths share one HTTP call");
  // The single poll's observation must have been ingested into BOTH stores.
  const billingRow = readCursorIndividualBillingRow();
  assert.equal(billingRow?.cycleLabel, "September 2026");
  const snap = getRuntimeCapacitySnapshot(now);
  const cursor = snap.runtimes.find((r) => r.runtime === "cursor_local");
  assert.equal(cursor?.windows[0]?.remainingPercent, 62.5);
});

test("a transient shared-poll failure keeps the capacity strip's last-known window, same as the billing card", async () => {
  enable();
  fixtureCredential();
  const now = Date.now();
  // A successful poll populates both stores.
  await refreshCursorIndividualCapacityIfStale(now, {
    baseUrl: MOCK_BASE,
    fetchImpl: mockFetch(okRoutes(now)),
    nowMs: now,
  });
  const before = getRuntimeCapacitySnapshot(now).runtimes.find((r) => r.runtime === "cursor_local");
  assert.equal(before?.windows[0]?.remainingPercent, 62.5);
  // Advance past the stale horizon; the next poll 500s — a transient
  // failure. Both the billing table AND the capacity table must keep the
  // last-known value instead of one of them overwriting it with `missing`.
  const later = now + DEFAULT_STALE_AFTER_MS + 60_000;
  await refreshCursorIndividualCapacityIfStale(later, {
    baseUrl: MOCK_BASE,
    fetchImpl: mockFetch({ [CURSOR_INDIVIDUAL_USAGE_PATHS[0]]: { status: 500, body: {} } }),
    nowMs: later,
  });
  const snap = getRuntimeCapacitySnapshot(later);
  const cursor = snap.runtimes.find((r) => r.runtime === "cursor_local");
  // The stored window is still THIS poll's window (source: experimental_api,
  // freshUntil from the earlier successful poll) — read-time freshness
  // classification names it `stale`, not the transient failure's `missing`.
  assert.equal(cursor?.unavailableReason, "stale");
  assert.equal(cursor?.windows.length, 1);
  assert.equal(cursor?.windows[0]?.unavailableReason, "stale");
  assert.equal(cursor?.windows[0]?.remainingPercent, null);
  const billingSnap = await getCursorIndividualBillingSnapshot(later);
  assert.equal(billingSnap.unavailableReason, "stale");
});

test("a malformed shared-poll response DOES overwrite the capacity strip, unlike a transient failure", async () => {
  // The `!transient` gate must not swallow every failure — a genuine
  // verdict on data that arrived (malformed/bad-credential) is not a
  // transport hiccup and must still replace stale-but-stored data with an
  // explicit `unparsable`, exactly like the billing table already does.
  enable();
  fixtureCredential();
  const now = Date.now();
  await refreshCursorIndividualCapacityIfStale(now, {
    baseUrl: MOCK_BASE,
    fetchImpl: mockFetch(okRoutes(now)),
    nowMs: now,
  });
  const before = getRuntimeCapacitySnapshot(now).runtimes.find((r) => r.runtime === "cursor_local");
  assert.equal(before?.windows[0]?.remainingPercent, 62.5);
  const later = now + DEFAULT_STALE_AFTER_MS + 60_000;
  await refreshCursorIndividualCapacityIfStale(later, {
    baseUrl: MOCK_BASE,
    fetchImpl: mockFetch({ [CURSOR_INDIVIDUAL_USAGE_PATHS[0]]: { status: 200, body: { nope: 1 } } }),
    nowMs: later,
  });
  const cursor = getRuntimeCapacitySnapshot(later).runtimes.find((r) => r.runtime === "cursor_local");
  assert.equal(cursor?.unavailableReason, "unparsable");
  assert.equal(cursor?.windows[0]?.unavailableReason, "unparsable");
});

test("a bad-credential shared-poll response DOES overwrite the capacity strip too — the other non-transient sibling", async () => {
  // `transient` treats `malformed` and `bad-credential` as one non-transient
  // class (both should overwrite); the previous test only covers `malformed`
  // at the capacity-strip level — cover the sibling the same way.
  enable();
  fixtureCredential();
  const now = Date.now();
  await refreshCursorIndividualCapacityIfStale(now, {
    baseUrl: MOCK_BASE,
    fetchImpl: mockFetch(okRoutes(now)),
    nowMs: now,
  });
  const before = getRuntimeCapacitySnapshot(now).runtimes.find((r) => r.runtime === "cursor_local");
  assert.equal(before?.windows[0]?.remainingPercent, 62.5);
  // The credential file changes shape before the next poll — the same
  // "changed format" drift the credentials module itself calls unparsable.
  fixtureCredential({ brandNewShape: true });
  const later = now + DEFAULT_STALE_AFTER_MS + 60_000;
  await refreshCursorIndividualCapacityIfStale(later, {
    baseUrl: MOCK_BASE,
    fetchImpl: mockFetch(okRoutes(later)),
    nowMs: later,
  });
  const cursor = getRuntimeCapacitySnapshot(later).runtimes.find((r) => r.runtime === "cursor_local");
  assert.equal(cursor?.unavailableReason, "unparsable");
  assert.equal(cursor?.windows[0]?.unavailableReason, "unparsable");
});

test("payload parsing keeps reported values and rejects empty shapes", () => {
  const now = Date.now();
  const readings = cursorIndividualPayloadToReadings(usagePayload(now));
  assert.ok(readings);
  assert.equal(readings.cycleLabel, "September 2026");
  assert.equal(readings.remainingPercent, 62.5);
  // Remaining-direct and fraction scales normalize without guessing.
  assert.equal(cursorIndividualPayloadToReadings({ remainingPercent: 80 })?.remainingPercent, 80);
  assert.equal(cursorIndividualPayloadToReadings({ usedFraction: 0.2 })?.remainingPercent, 80);
  assert.equal(cursorIndividualPayloadToReadings({ remaining_fraction: 0.5 })?.remainingPercent, 50);
  // Out-of-range percents clamp instead of leaking impossible values.
  assert.equal(cursorIndividualPayloadToReadings({ remainingPercent: 140 })?.remainingPercent, 100);
  // Snake_case aliases tolerated; empty shapes read null (unparsable).
  const snake = cursorIndividualPayloadToReadings({
    cycle_label: "September 2026",
    reset_at: new Date(now + 3600_000).toISOString(),
    used_percent: 10,
  });
  assert.ok(snake);
  assert.equal(snake.cycleLabel, "September 2026");
  assert.equal(snake.remainingPercent, 90);
  assert.equal(cursorIndividualPayloadToReadings(null), null);
  assert.equal(cursorIndividualPayloadToReadings("nope"), null);
  assert.equal(cursorIndividualPayloadToReadings({ nonsense: true }), null);
  assert.equal(cursorIndividualPayloadToReadings({ usageUnit: "USD" }), null);
});

test("the live dashboard shape (billingCycleStart/End + nested individualUsage.plan.totalPercentUsed) parses", () => {
  const now = Date.now();
  const live = cursorIndividualPayloadToReadings({
    billingCycleStart: "2026-09-01T00:00:00.000Z",
    billingCycleEnd: new Date(now + 8 * 24 * 3600_000).toISOString(),
    individualUsage: {
      plan: {
        totalPercentUsed: 37.5,
      },
    },
  });
  assert.ok(live);
  assert.equal(live.cycleStart, "2026-09-01T00:00:00.000Z");
  assert.equal(live.cycleEnd, new Date(now + 8 * 24 * 3600_000).toISOString());
  // 37.5% used → 62.5 remaining, same scale as the top-level usedPercent path.
  assert.equal(live.remainingPercent, 62.5);
  // A top-level usedPercent still wins over a nested totalPercentUsed — the
  // merge only fills gaps, it never lets the nested plan override a scale
  // the top-level payload already reported.
  const clash = cursorIndividualPayloadToReadings({
    billingCycleStart: "2026-09-01T00:00:00.000Z",
    usedPercent: 10,
    individualUsage: { plan: { totalPercentUsed: 90 } },
  });
  assert.equal(clash?.remainingPercent, 90);
  // A non-object individualUsage/plan is ignored, not a crash.
  assert.equal(
    cursorIndividualPayloadToReadings({ individualUsage: "nope" })?.remainingPercent ?? null,
    null
  );
  assert.equal(cursorIndividualPayloadToReadings({ individualUsage: { plan: "nope" } }), null);
});

test("readBoundedText aborts once the body exceeds the size cap, without buffering it all first", async () => {
  const chunkSize = 64 * 1024;
  const chunk = new Uint8Array(chunkSize).fill(97);
  // A stream far larger than the cap (well over 10x) — an attacker/broken
  // server sending an oversized or unbounded body. Only ~8-9 chunks are
  // needed to cross the 512 KiB cap; the assertion below proves the read
  // stops there instead of buffering the whole thing.
  const availableChunks = 100;
  let delivered = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (delivered >= availableChunks) {
        controller.close();
        return;
      }
      delivered += 1;
      controller.enqueue(chunk);
    },
  });
  const res = new Response(stream);
  const controller = new AbortController();
  await assert.rejects(() => readBoundedText(res, controller.signal));
  // The stream must have been cancelled well before the full body was
  // pulled — i.e. the cap is enforced during the read, not after buffering
  // it all. A few chunks of slack above the exact cap boundary is fine; the
  // bulk of the 100-chunk body must never be read.
  assert.ok(
    delivered <= 15,
    `expected the read to abort well before all ${availableChunks} chunks were pulled, got ${delivered}`
  );

  // A body within the cap still reads through normally.
  const smallStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("hello"));
      controller.close();
    },
  });
  const smallRes = new Response(smallStream);
  const text = await readBoundedText(smallRes, new AbortController().signal);
  assert.equal(text, "hello");

  // An already-aborted signal aborts the read too.
  const abortedController = new AbortController();
  abortedController.abort();
  const anotherStream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("x"));
    },
  });
  await assert.rejects(() => readBoundedText(new Response(anotherStream), abortedController.signal));
});
