// packages/server/src/capacity/claude-local-cache.test.ts
//
// NOT-268: Claude capacity local-first ladder — local cache 5H/1W plus a
// free `/usage` refresh; NOT-281 retargeted the trigger to either window at
// least 14 minutes old (per-window, inside the 15-minute display freshness).
// No test here performs a live provider request: every probe spawn goes
// through an injected fake runner.
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProbeRunner } from "./claude-local-cache.js";
import type { AdapterWindowReading } from "./adapter.js";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-claude-cache-"));

const { migrate } = await import("../db/index.js");
const { createAgent } = await import("../repository/agents.js");
const {
  listCapacitySnapshots,
  clearAllCapacitySnapshots,
} = await import("../repository/runtime-capacity.js");
const { parseNdjson } = await import("../runners/stream-json.js");
const { getRuntimeCapacitySnapshot } = await import("./service.js");
const { recordClaudeCapacityFromEvents, recordClaudeWindowReadings } = await import(
  "./claude-events.js"
);
const {
  CLAUDE_CACHE_FILE_ENV,
  CLAUDE_CAPACITY_REFRESH_ENV,
  CLAUDE_PROBE_STALE_AFTER_MS,
  buildClaudeProbeArgv,
  claudeCacheFilePath,
  extractClaudeCacheSubtree,
  ingestClaudeLocalCache,
  isClaudePaidFallbackEnabled,
  maybeProbeClaudeCapacity,
  newestValidClaudeObservationMs,
  newestValidClaudeObservationMsByRole,
  parseClaudeCachedUtilization,
  probeDiagnosticLogPath,
  readClaudeLocalCache,
  recordClaudeAcquisitionFailure,
  refreshClaudeCapacityIfStale,
  resetClaudeCapacityRefreshState,
  runClaudeCapacityProbe,
} = await import("./claude-local-cache.js");

const NOW_MS = Date.parse("2026-09-20T12:00:00.000Z");
const FIVE_HOUR_RESET_SEC = Math.floor(NOW_MS / 1000) + 2 * 3600;
const SEVEN_DAY_RESET_SEC = Math.floor(NOW_MS / 1000) + 3 * 24 * 3600;

let cacheDir: string;
let cacheFile: string;
const savedEnv: Record<string, string | undefined> = {};

function fullCacheFixture(fetchedAtMs: number): string {
  return JSON.stringify({
    fetchedAtMs,
    accountUuid: "acct-must-never-persist",
    email: "someone@example.com",
    credentials: { token: "secret-must-never-persist" },
    extraUsage: { spendUsd: 12.34 },
    experiments: ["exp-a"],
    utilization: {
      five_hour: { utilization: 0.17, resets_at: FIVE_HOUR_RESET_SEC },
      seven_day: { utilization: 0.42, resets_at: SEVEN_DAY_RESET_SEC },
      limits: [
        { name: "session", utilization: 0.17, resets_at: FIVE_HOUR_RESET_SEC },
        { name: "weekly_all", utilization: 0.42, resets_at: SEVEN_DAY_RESET_SEC },
        { name: "sonnet", utilization: 0.9, resets_at: SEVEN_DAY_RESET_SEC },
        { name: "extra_usage", utilization: 0.1, resets_at: SEVEN_DAY_RESET_SEC },
      ],
    },
  });
}

// Mirrors a real `claude -p "/usage"` stream at 2.1.283: a local-command
// result event carrying `usage_report.rate_limits.limits[]` (verified live
// 2026-09-27 — see claude-local-cache.ts module header), followed by the
// terminal `result` event. Real runs cost $0 (no model call); `costUsd`
// defaults to 0 but stays overridable for the cost-plumbing assertions.
function probeStreamFixture(observedIso: string, costUsd = 0): string {
  return [
    JSON.stringify({
      type: "assistant",
      timestamp: observedIso,
      local_command_run: { command: "usage", args: "" },
      usage_report: {
        session: { total_cost_usd: 0 },
        rate_limits: {
          limits: [
            {
              kind: "session",
              group: "session",
              percent: 20,
              resets_at: new Date(FIVE_HOUR_RESET_SEC * 1000).toISOString(),
              severity: "normal",
              is_active: false,
            },
            {
              kind: "weekly_all",
              group: "weekly",
              percent: 40,
              resets_at: new Date(SEVEN_DAY_RESET_SEC * 1000).toISOString(),
              severity: "normal",
              is_active: true,
            },
          ],
        },
      },
    }),
    JSON.stringify({
      type: "result",
      is_error: false,
      result: "ok",
      total_cost_usd: costUsd,
    }),
  ].join("\n");
}

const throwingRunner: ProbeRunner = () => {
  throw new Error("probe runner must not be called while disabled/fresh");
};

/**
 * Seed the snapshot store with per-window ages (NOT-281): the shared cache
 * fixture always stamps both windows together, so split-freshness cases
 * need direct per-role rows. Resets stay in the future so rows count as
 * valid observations at NOW_MS.
 */
function seedWindowAges(
  fiveHourAgeMs: number | null,
  weeklyAgeMs: number | null,
  nowMs: number = NOW_MS,
  expectedPersisted?: number
): void {
  const readings: AdapterWindowReading[] = [];
  const role = (five: boolean, ageMs: number): AdapterWindowReading => ({
    windowKey: five ? "claude_unified_five_hour" : "claude_unified_seven_day",
    providerBucket: five ? "five_hour" : "seven_day",
    durationMinutes: five ? 300 : 10080,
    providerLabel: five ? "five_hour" : "seven_day",
    usedValue: five ? 0.17 : 0.42,
    usedUnit: "fraction",
    usedFraction: five ? 0.17 : 0.42,
    resetAt: new Date((five ? FIVE_HOUR_RESET_SEC : SEVEN_DAY_RESET_SEC) * 1000).toISOString(),
    observedAt: new Date(nowMs - ageMs).toISOString(),
    source: "observed_event",
    evidenceRef: "test:split-window-seed",
    criticalRole: five ? "five_hour" : "weekly",
  });
  if (fiveHourAgeMs !== null) readings.push(role(true, fiveHourAgeMs));
  if (weeklyAgeMs !== null) readings.push(role(false, weeklyAgeMs));
  assert.equal(
    recordClaudeWindowReadings(readings, "claude_code", nowMs),
    expectedPersisted ?? readings.length
  );
}

function successRunner(atMs: number = NOW_MS): ProbeRunner {
  return async () => ({
    stdout: probeStreamFixture(new Date(atMs).toISOString()),
    exitCode: 0,
    timedOut: false,
    spawnError: null,
  });
}

before(() => {
  migrate();
  createAgent({
    name: "claude-cap-cache",
    runtime: "claude_code",
    deckId: "44444444-4444-4444-8444-444444444444",
  });
});

beforeEach(() => {
  clearAllCapacitySnapshots();
  resetClaudeCapacityRefreshState();
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-claude-cache-file-"));
  cacheFile = path.join(cacheDir, "cachedUsageUtilization.json");
  for (const key of [CLAUDE_CACHE_FILE_ENV, CLAUDE_CAPACITY_REFRESH_ENV]) {
    savedEnv[key] = process.env[key];
  }
  process.env[CLAUDE_CACHE_FILE_ENV] = cacheFile;
  delete process.env[CLAUDE_CAPACITY_REFRESH_ENV];
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

test("fixture yields exactly Claude 5H/1W and drops account/extra fields", () => {
  fs.writeFileSync(cacheFile, fullCacheFixture(NOW_MS - 5 * 60_000));
  const result = readClaudeLocalCache(NOW_MS);
  assert.ok(result);
  assert.equal(result!.runtime, "claude_code");
  assert.equal(result!.unavailable.length, 0);
  assert.equal(result!.windows.length, 2);
  const fiveHour = result!.windows.find((w) => w.criticalRole === "five_hour")!;
  const weekly = result!.windows.find((w) => w.criticalRole === "weekly")!;
  assert.ok(fiveHour && weekly);
  assert.equal(fiveHour.windowKey, "claude_unified_five_hour");
  assert.equal(fiveHour.providerBucket, "five_hour");
  assert.equal(fiveHour.durationMinutes, 300);
  assert.equal(fiveHour.usedFraction, 0.17);
  assert.equal(weekly.windowKey, "claude_unified_seven_day");
  assert.equal(weekly.providerBucket, "seven_day");
  assert.equal(weekly.durationMinutes, 10080);
  assert.equal(weekly.usedFraction, 0.42);
  for (const w of result!.windows) {
    assert.equal(w.source, "observed_event");
    assert.equal(w.evidenceRef, "claude-cache:cachedUsageUtilization");
    // fetchedAtMs is the observed time.
    assert.equal(w.observedAt, new Date(NOW_MS - 5 * 60_000).toISOString());
    assert.ok(!JSON.stringify(w).includes("acct-must-never-persist"));
    assert.ok(!JSON.stringify(w).includes("someone@example.com"));
    assert.ok(!JSON.stringify(w).includes("secret-must-never-persist"));
  }
  // Model-specific/overage limits never become rows.
  assert.equal(
    result!.windows.some((w) => w.providerBucket === "sonnet" || w.providerBucket === "extra_usage"),
    false
  );

  assert.equal(ingestClaudeLocalCache(NOW_MS), 2);
  const rows = listCapacitySnapshots("claude_code");
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => !JSON.stringify(r).includes("acct-must-never-persist")));
  const snap = getRuntimeCapacitySnapshot(NOW_MS);
  const claude = snap.runtimes.find((r) => r.runtime === "claude_code")!;
  assert.equal(claude.windows.find((w) => w.displayLabel === "5H")!.remainingPercent, 83);
  assert.equal(claude.windows.find((w) => w.displayLabel === "1W")!.remainingPercent, 58);
});

test("limits[] wins per role; named fields are the compatibility path", () => {
  const raw = {
    fetchedAtMs: NOW_MS - 60_000,
    utilization: {
      five_hour: { utilization: 0.99, resets_at: FIVE_HOUR_RESET_SEC },
      seven_day: { utilization: 0.42, resets_at: SEVEN_DAY_RESET_SEC },
      limits: [{ name: "session", utilization: 0.1, resets_at: FIVE_HOUR_RESET_SEC }],
    },
  };
  const readings = parseClaudeCachedUtilization(raw, NOW_MS);
  assert.ok(readings);
  // limits[] session (0.1) beats named five_hour (0.99); seven_day has no
  // limits entry so the named field fills it.
  assert.equal(readings!.find((w) => w.criticalRole === "five_hour")!.usedFraction, 0.1);
  assert.equal(readings!.find((w) => w.criticalRole === "weekly")!.usedFraction, 0.42);

  const namedOnly = parseClaudeCachedUtilization(
    {
      fetchedAtMs: NOW_MS - 60_000,
      utilization: {
        five_hour: { utilization: 0.2, resets_at: FIVE_HOUR_RESET_SEC },
        seven_day: { utilization: 0.3, resets_at: SEVEN_DAY_RESET_SEC },
      },
    },
    NOW_MS
  );
  assert.ok(namedOnly);
  assert.equal(namedOnly!.length, 2);
});

test("limit role names are exact and case-insensitive; extras are dropped", () => {
  const readings = parseClaudeCachedUtilization(
    {
      fetchedAtMs: NOW_MS - 60_000,
      utilization: {
        limits: [
          { name: "Session", utilization: 0.1, resets_at: FIVE_HOUR_RESET_SEC },
          { name: "WEEKLY_ALL", utilization: 0.2, resets_at: SEVEN_DAY_RESET_SEC },
          { name: "seven_day_sonnet", utilization: 0.9, resets_at: SEVEN_DAY_RESET_SEC },
          { name: "session_extra", utilization: 0.9, resets_at: FIVE_HOUR_RESET_SEC },
        ],
      },
    },
    NOW_MS
  );
  assert.ok(readings);
  assert.equal(readings!.length, 2);
  // Near-miss names never claim the account-wide identity.
  assert.ok(readings!.every((w) => w.providerBucket === "five_hour" || w.providerBucket === "seven_day"));
});

test("future/missing fetchedAtMs rejects the whole observation", () => {
  assert.equal(
    parseClaudeCachedUtilization({ fetchedAtMs: NOW_MS + 60_000, utilization: {} }, NOW_MS),
    null
  );
  assert.equal(parseClaudeCachedUtilization({ utilization: {} }, NOW_MS), null);
  assert.equal(parseClaudeCachedUtilization({ fetchedAtMs: "soon", utilization: {} }, NOW_MS), null);
  assert.equal(parseClaudeCachedUtilization(null, NOW_MS), null);
  assert.equal(
    parseClaudeCachedUtilization({ fetchedAtMs: NOW_MS, utilization: null }, NOW_MS),
    null
  );
  // File-level: missing file, garbage JSON, and future cache all read null.
  fs.writeFileSync(cacheFile, fullCacheFixture(NOW_MS + 60_000));
  assert.equal(readClaudeLocalCache(NOW_MS), null);
  fs.writeFileSync(cacheFile, "{not json");
  assert.equal(readClaudeLocalCache(NOW_MS), null);
  fs.rmSync(cacheFile);
  assert.equal(readClaudeLocalCache(NOW_MS), null);
  assert.equal(ingestClaudeLocalCache(NOW_MS), null);
});

test("malformed scales and expired resets are rejected, never fabricated", () => {
  // Bare `utilization` is dual-scale (≤ 1 fraction, above percent to 100 —
  // the real cache carries percent values like 9 there), so 1.5 is a valid
  // 1.5%, not malformed. Out-of-range on both scales stays rejected, as do
  // explicit fraction spellings above 1.
  const bad: unknown[] = [
    { utilization: 101, resets_at: FIVE_HOUR_RESET_SEC },
    { utilization: -0.1, resets_at: FIVE_HOUR_RESET_SEC },
    { utilization: "high", resets_at: FIVE_HOUR_RESET_SEC },
    { utilization: null, resets_at: FIVE_HOUR_RESET_SEC },
    { usedPercent: 101, resets_at: FIVE_HOUR_RESET_SEC },
    { usedFraction: 1.5, resets_at: FIVE_HOUR_RESET_SEC },
    { percent: -1, resets_at: FIVE_HOUR_RESET_SEC },
  ];
  for (const entry of bad) {
    assert.equal(
      parseClaudeCachedUtilization(
        { fetchedAtMs: NOW_MS - 60_000, utilization: { five_hour: entry } },
        NOW_MS
      ),
      null
    );
  }
  // Expired reset (at or before observed time) drops the window; the fresh
  // sibling still normalizes.
  const partial = parseClaudeCachedUtilization(
    {
      fetchedAtMs: NOW_MS - 60_000,
      utilization: {
        five_hour: { utilization: 0.2, resets_at: Math.floor(NOW_MS / 1000) - 3600 },
        seven_day: { utilization: 0.3, resets_at: SEVEN_DAY_RESET_SEC },
      },
    },
    NOW_MS
  );
  assert.ok(partial);
  assert.equal(partial!.length, 1);
  assert.equal(partial![0]!.criticalRole, "weekly");
});

test("stale cache renders N/A with honest age; older cache never overwrites a newer event", () => {
  // A Dealer event observed 10 minutes ago.
  const eventAt = NOW_MS - 10 * 60_000;
  const eventNdjson = JSON.stringify({
    type: "rate_limit_event",
    timestamp: new Date(eventAt).toISOString(),
    rate_limit_info: {
      status: "allowed",
      unifiedWindows: [{ window: "five_hour", utilization: 0.5, resetsAt: FIVE_HOUR_RESET_SEC }],
    },
  });
  assert.equal(
    recordClaudeCapacityFromEvents(parseNdjson(eventNdjson), "claude_code", NOW_MS, eventAt),
    1
  );
  // An older cache (20 minutes ago) cannot clobber it.
  fs.writeFileSync(
    cacheFile,
    JSON.stringify({
      fetchedAtMs: NOW_MS - 20 * 60_000,
      utilization: {
        five_hour: { utilization: 0.1, resets_at: FIVE_HOUR_RESET_SEC },
        seven_day: { utilization: 0.3, resets_at: SEVEN_DAY_RESET_SEC },
      },
    })
  );
  assert.equal(ingestClaudeLocalCache(NOW_MS), 1);
  const rows = listCapacitySnapshots("claude_code");
  // five_hour keeps the newer event reading (50% remaining); seven_day is
  // new from the cache.
  assert.equal(rows.find((r) => r.providerBucket === "five_hour")!.remainingPercent, 50);
  assert.equal(
    rows.find((r) => r.providerBucket === "five_hour")!.observedAt,
    new Date(eventAt).toISOString()
  );
  assert.equal(rows.find((r) => r.providerBucket === "seven_day")!.remainingPercent, 70);
  // A newer cache does win its own window.
  fs.writeFileSync(cacheFile, fullCacheFixture(NOW_MS - 5 * 60_000));
  assert.equal(ingestClaudeLocalCache(NOW_MS), 2);
  assert.equal(
    listCapacitySnapshots("claude_code").find((r) => r.providerBucket === "five_hour")!
      .remainingPercent,
    83
  );
});

test("a 2-hour-old cache ingests with its true age and reads expired, never live", () => {
  fs.writeFileSync(cacheFile, fullCacheFixture(NOW_MS - 2 * 3600_000));
  assert.equal(ingestClaudeLocalCache(NOW_MS), 2);
  const snap = getRuntimeCapacitySnapshot(NOW_MS);
  const claude = snap.runtimes.find((r) => r.runtime === "claude_code")!;
  assert.ok(claude.windows.length > 0);
  for (const w of claude.windows) {
    assert.equal(w.remainingPercent, null);
    assert.equal(w.unavailableReason, "expired");
  }
});

test("refresh defaults on; explicit off and unrecognized values never spawn", async () => {
  for (const value of [undefined, "", "paid-after-1h"] as const) {
    if (value === undefined) delete process.env[CLAUDE_CAPACITY_REFRESH_ENV];
    else process.env[CLAUDE_CAPACITY_REFRESH_ENV] = value;
    assert.equal(isClaudePaidFallbackEnabled(), true);
  }
  for (const value of ["off", "auto", "paid-after-1h "] as const) {
    process.env[CLAUDE_CAPACITY_REFRESH_ENV] = value;
    assert.equal(isClaudePaidFallbackEnabled(), false);
    const outcome = await maybeProbeClaudeCapacity(NOW_MS, { runner: throwingRunner });
    assert.deepEqual(outcome, { probed: false, reason: "disabled" });
  }
  delete process.env[CLAUDE_CAPACITY_REFRESH_ENV];
  assert.equal(isClaudePaidFallbackEnabled(), true);
});

test("extractClaudeUsageReportLimits reads the /usage local-command result", async () => {
  const { extractClaudeUsageReportLimits } = await import("./claude-local-cache.js");
  const observedIso = new Date(NOW_MS).toISOString();
  const events = probeStreamFixture(observedIso).split("\n").map((l) => JSON.parse(l));
  const readings = extractClaudeUsageReportLimits(events, NOW_MS);
  assert.ok(readings);
  assert.equal(readings!.length, 2);
  const fiveHour = readings!.find((w) => w.criticalRole === "five_hour")!;
  const weekly = readings!.find((w) => w.criticalRole === "weekly")!;
  assert.equal(fiveHour.usedPercent, 20);
  assert.equal(weekly.usedPercent, 40);
  assert.equal(fiveHour.observedAt, observedIso);
  assert.equal(fiveHour.evidenceRef, "claude-probe:usage-command");
  // No usage_report anywhere in the stream — nothing fabricated.
  assert.equal(extractClaudeUsageReportLimits([{ type: "result" }], NOW_MS), null);
});

test("default-on refresh suppresses a fresh sample; stale data triggers exactly one", async () => {
  assert.equal(CLAUDE_PROBE_STALE_AFTER_MS, 14 * 60_000);
  fs.writeFileSync(cacheFile, fullCacheFixture(NOW_MS - 10 * 60_000));
  assert.equal(ingestClaudeLocalCache(NOW_MS), 2);
  assert.ok((newestValidClaudeObservationMs(NOW_MS) ?? 0) > NOW_MS - CLAUDE_PROBE_STALE_AFTER_MS);
  const fresh = await maybeProbeClaudeCapacity(NOW_MS, { runner: throwingRunner });
  assert.deepEqual(fresh, { probed: false, reason: "fresh" });

  // All samples past the 14-minute trigger: five concurrent readers share one probe.
  clearAllCapacitySnapshots();
  resetClaudeCapacityRefreshState();
  fs.writeFileSync(cacheFile, fullCacheFixture(NOW_MS - 61 * 60_000));
  assert.equal(ingestClaudeLocalCache(NOW_MS), 2);
  let calls = 0;
  const runner: ProbeRunner = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return { stdout: probeStreamFixture(new Date(NOW_MS).toISOString()), exitCode: 0, timedOut: false, spawnError: null };
  };
  const outcomes = await Promise.all(
    Array.from({ length: 5 }, () => maybeProbeClaudeCapacity(NOW_MS, { runner }))
  );
  assert.equal(calls, 1);
  assert.equal(outcomes.filter((o) => o.reason === "completed").length, 1);
  assert.equal(outcomes.filter((o) => o.reason === "shared").length, 4);
  assert.ok(outcomes.every((o) => o.probed && o.ok));
});

test("a stale twin triggers one refresh even when its sibling is newer", async () => {
  // NOT-281: the old newest-of-pair gate let one fresh window suppress the
  // refresh while its sibling went stale. Freshness is per window now.
  seedWindowAges(5 * 60_000, 20 * 60_000);
  const byRole = newestValidClaudeObservationMsByRole(NOW_MS);
  assert.equal(byRole.five_hour, NOW_MS - 5 * 60_000);
  assert.equal(byRole.weekly, NOW_MS - 20 * 60_000);

  let calls = 0;
  const runner: ProbeRunner = async () => {
    calls++;
    return {
      stdout: probeStreamFixture(new Date(NOW_MS).toISOString()),
      exitCode: 0,
      timedOut: false,
      spawnError: null,
    };
  };
  const outcome = await maybeProbeClaudeCapacity(NOW_MS, { runner });
  assert.equal(calls, 1);
  assert.equal(outcome.probed, true);
  assert.equal(outcome.reason, "completed");
  assert.equal(outcome.ok, true);

  // On success both windows are fresh again …
  const after = newestValidClaudeObservationMsByRole(NOW_MS);
  assert.equal(after.five_hour, NOW_MS);
  assert.equal(after.weekly, NOW_MS);
  // … and the next API/UI poll (a minute later, well inside the ordinary
  // 15-minute stale boundary) reports known values with no new spawn.
  const poll = await maybeProbeClaudeCapacity(NOW_MS + 60_000, { runner: throwingRunner });
  assert.deepEqual(poll, { probed: false, reason: "fresh" });
  const snap = getRuntimeCapacitySnapshot(NOW_MS + 60_000);
  const claude = snap.runtimes.find((r) => r.runtime === "claude_code")!;
  assert.equal(claude.windows.find((w) => w.displayLabel === "5H")!.remainingPercent, 80);
  assert.equal(claude.windows.find((w) => w.displayLabel === "1W")!.remainingPercent, 60);
});

test("a missing window triggers a refresh even when the sibling is newer", async () => {
  seedWindowAges(5 * 60_000, null);
  assert.deepEqual(newestValidClaudeObservationMsByRole(NOW_MS), {
    five_hour: NOW_MS - 5 * 60_000,
    weekly: null,
  });
  let calls = 0;
  const runner: ProbeRunner = async () => {
    calls++;
    return {
      stdout: probeStreamFixture(new Date(NOW_MS).toISOString()),
      exitCode: 0,
      timedOut: false,
      spawnError: null,
    };
  };
  const outcome = await maybeProbeClaudeCapacity(NOW_MS, { runner });
  assert.equal(calls, 1);
  assert.equal(outcome.ok, true);
  assert.deepEqual(newestValidClaudeObservationMsByRole(NOW_MS), {
    five_hour: NOW_MS,
    weekly: NOW_MS,
  });
});

test("the freshness boundary is 14 minutes: just under stays quiet, exactly at triggers", async () => {
  seedWindowAges(13 * 60_000, 13 * 60_000);
  const fresh = await maybeProbeClaudeCapacity(NOW_MS, { runner: throwingRunner });
  assert.deepEqual(fresh, { probed: false, reason: "fresh" });

  clearAllCapacitySnapshots();
  resetClaudeCapacityRefreshState();
  seedWindowAges(14 * 60_000, 0);
  const stale = await maybeProbeClaudeCapacity(NOW_MS, { runner: successRunner() });
  assert.equal(stale.probed, true);
  assert.equal(stale.reason, "completed");
  assert.equal(stale.ok, true);
});

test("a healthy refresh buys 14 minutes: no second attempt inside the interval", async () => {
  seedWindowAges(20 * 60_000, 20 * 60_000);
  let calls = 0;
  const runner: ProbeRunner = async () => {
    calls++;
    return {
      stdout: probeStreamFixture(new Date(NOW_MS).toISOString()),
      exitCode: 0,
      timedOut: false,
      spawnError: null,
    };
  };
  const first = await maybeProbeClaudeCapacity(NOW_MS, { runner });
  assert.equal(first.ok, true);
  assert.equal(calls, 1);
  // A 5-second-poll cadence sees fresh rows and spawns nothing.
  const poll = await maybeProbeClaudeCapacity(NOW_MS + 5_000, { runner: throwingRunner });
  assert.deepEqual(poll, { probed: false, reason: "fresh" });
  // Even if the rows go missing mid-interval (e.g. a reset passes), the
  // attempt cooldown stamped by the healthy run holds — at most one
  // refresh per 14 minutes, never a retry per poll.
  clearAllCapacitySnapshots();
  const missing = await maybeProbeClaudeCapacity(NOW_MS + 5 * 60_000, { runner: throwingRunner });
  assert.deepEqual(missing, { probed: false, reason: "backoff" });
  assert.equal(calls, 1);
  // Past the interval the gate opens again.
  const later = await maybeProbeClaudeCapacity(NOW_MS + 15 * 60_000, { runner });
  assert.equal(later.probed, true);
  assert.equal(calls, 2);
});

test("disabled refresh never spawns and stale readings stay honestly N/A", async () => {
  process.env[CLAUDE_CAPACITY_REFRESH_ENV] = "off";
  // 20 minutes old: past the 15-minute display freshness, inside expiry.
  fs.writeFileSync(cacheFile, fullCacheFixture(NOW_MS - 20 * 60_000));
  assert.equal(ingestClaudeLocalCache(NOW_MS), 2);
  const outcome = await maybeProbeClaudeCapacity(NOW_MS, { runner: throwingRunner });
  assert.deepEqual(outcome, { probed: false, reason: "disabled" });
  const snap = getRuntimeCapacitySnapshot(NOW_MS);
  const claude = snap.runtimes.find((r) => r.runtime === "claude_code")!;
  for (const w of claude.windows) {
    assert.equal(w.remainingPercent, null);
    assert.equal(w.unavailableReason, "stale");
  }
});

test("probe argv pins the fixed /usage command plus structural model-turn safeguards", async () => {
  fs.writeFileSync(cacheFile, fullCacheFixture(NOW_MS - 61 * 60_000));
  assert.equal(ingestClaudeLocalCache(NOW_MS), 2);
  let seenBin = "";
  let seenArgv: string[] = [];
  let seenCwd = "";
  const runner: ProbeRunner = async (bin, argv, opts) => {
    seenBin = bin;
    seenArgv = argv;
    seenCwd = opts.cwd;
    return { stdout: probeStreamFixture(new Date(NOW_MS).toISOString()), exitCode: 0, timedOut: false, spawnError: null };
  };
  const outcome = await maybeProbeClaudeCapacity(NOW_MS, { runner, bin: "/fake/claude" });
  assert.equal(outcome.probed, true);
  assert.equal(seenBin, "/fake/claude");
  assert.deepEqual(seenArgv, [
    "-p",
    "/usage",
    "--model",
    "haiku",
    "--max-turns",
    "1",
    "--tools",
    "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-budget-usd",
    "0.01",
  ]);
  // Semantic pins behind the exact match: no MCP config passed, cheapest
  // model + hard one-turn bound + no tools kept as structural safeguards
  // (2026-09-27 review hardening) even though `/usage` never reaches the
  // model on 2.1.283, plus the defensive budget cap.
  assert.ok(!seenArgv.includes("--mcp-config"));
  assert.equal(seenArgv[seenArgv.indexOf("--model") + 1], "haiku");
  assert.equal(seenArgv[seenArgv.indexOf("--max-turns") + 1], "1");
  assert.equal(seenArgv[seenArgv.indexOf("--tools") + 1], "");
  const budget = Number(seenArgv[seenArgv.indexOf("--max-budget-usd") + 1]);
  assert.ok(Number.isFinite(budget) && budget <= 0.01);
  assert.equal(seenArgv.filter((a) => a === "-p").length, 1);
  // No worktree, no repo checkout — the probe runs in the OS temp dir.
  assert.equal(seenCwd, os.tmpdir());
  assert.deepEqual(buildClaudeProbeArgv(), seenArgv);
});

test("probe success updates both 5H and 1W and records cost without prompt/output", async () => {
  process.env[CLAUDE_CAPACITY_REFRESH_ENV] = "paid-after-1h";
  fs.writeFileSync(cacheFile, fullCacheFixture(NOW_MS - 61 * 60_000));
  assert.equal(ingestClaudeLocalCache(NOW_MS), 2);
  const marker = "probe-stream-marker-must-never-reach-log";
  const runner: ProbeRunner = async () => ({
    stdout: `${probeStreamFixture(new Date(NOW_MS).toISOString())}\n${JSON.stringify({ type: "assistant", text: marker })}`,
    exitCode: 0,
    timedOut: false,
    spawnError: null,
  });
  const result = await runClaudeCapacityProbe(NOW_MS, { runner });
  assert.equal(result.ok, true);
  assert.equal(result.failureKind, null);
  assert.equal(result.costUsd, 0);
  assert.deepEqual(result.windowsUpdated, ["claude_unified_five_hour", "claude_unified_seven_day"]);
  const rows = listCapacitySnapshots("claude_code");
  assert.equal(rows.find((r) => r.providerBucket === "five_hour")!.remainingPercent, 80);
  assert.equal(rows.find((r) => r.providerBucket === "seven_day")!.remainingPercent, 60);
  assert.equal(rows.find((r) => r.providerBucket === "five_hour")!.observedAt, new Date(NOW_MS).toISOString());
  const logText = fs.readFileSync(probeDiagnosticLogPath(), "utf8");
  assert.ok(logText.includes('"costUsd":0'));
  assert.ok(!logText.includes("Reply with exactly"));
  assert.ok(!logText.includes(marker));
});

test("probe rejects and ingests nothing when the result reports nonzero cost", async () => {
  // Reviewer-requested hardening (PR #165): any charge means /usage did not
  // resolve locally as expected — reject the whole run rather than trusting
  // windows a real (unexpected) model turn happened to produce.
  process.env[CLAUDE_CAPACITY_REFRESH_ENV] = "paid-after-1h";
  fs.writeFileSync(cacheFile, fullCacheFixture(NOW_MS - 61 * 60_000));
  assert.equal(ingestClaudeLocalCache(NOW_MS), 2);
  const runner: ProbeRunner = async () => ({
    stdout: probeStreamFixture(new Date(NOW_MS).toISOString(), 0.0007),
    exitCode: 0,
    timedOut: false,
    spawnError: null,
  });
  const result = await runClaudeCapacityProbe(NOW_MS, { runner });
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, "unexpected_cost");
  assert.equal(result.costUsd, 0.0007);
  assert.deepEqual(result.windowsUpdated, []);
  // Last-good rows from before the rejected run are untouched.
  const rows = listCapacitySnapshots("claude_code");
  assert.equal(rows.find((r) => r.providerBucket === "five_hour")!.remainingPercent, 83);
});

test("probe rejects and ingests nothing when cost cannot be verified as zero", async () => {
  // Reviewer-requested hardening, round 2 (PR #165): a stream with the
  // local-command marker and well-formed windows, but a `result` event that
  // omits `total_cost_usd` (costUsd === null), must fail closed exactly like
  // a confirmed positive charge — null is not evidence of zero cost.
  process.env[CLAUDE_CAPACITY_REFRESH_ENV] = "paid-after-1h";
  fs.writeFileSync(cacheFile, fullCacheFixture(NOW_MS - 61 * 60_000));
  assert.equal(ingestClaudeLocalCache(NOW_MS), 2);
  const runner: ProbeRunner = async () => ({
    stdout: [
      JSON.stringify({
        type: "assistant",
        timestamp: new Date(NOW_MS).toISOString(),
        local_command_run: { command: "usage", args: "" },
        usage_report: {
          rate_limits: {
            limits: [
              { kind: "session", percent: 20, resets_at: new Date(FIVE_HOUR_RESET_SEC * 1000).toISOString() },
              { kind: "weekly_all", percent: 40, resets_at: new Date(SEVEN_DAY_RESET_SEC * 1000).toISOString() },
            ],
          },
        },
      }),
      // No `result` event at all — total_cost_usd is unknowable.
    ].join("\n"),
    exitCode: 0,
    timedOut: false,
    spawnError: null,
  });
  const result = await runClaudeCapacityProbe(NOW_MS, { runner });
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, "unexpected_cost");
  assert.equal(result.costUsd, null);
  assert.deepEqual(result.windowsUpdated, []);
  const rows = listCapacitySnapshots("claude_code");
  assert.equal(rows.find((r) => r.providerBucket === "five_hour")!.remainingPercent, 83);
});

test("probe rejects and ingests nothing when the local-command marker is absent", async () => {
  // Reviewer-requested hardening (PR #165): a stream that never shows
  // `/usage` resolving locally must not be trusted, even if it happens to
  // carry a well-formed usage_report (e.g. a different CLI build echoing it
  // from a real turn) or a fresh cache-file side effect.
  process.env[CLAUDE_CAPACITY_REFRESH_ENV] = "paid-after-1h";
  fs.writeFileSync(cacheFile, fullCacheFixture(NOW_MS - 61 * 60_000));
  assert.equal(ingestClaudeLocalCache(NOW_MS), 2);
  const runner: ProbeRunner = async () => {
    fs.writeFileSync(cacheFile, fullCacheFixture(NOW_MS + 5_000));
    return {
      stdout: [
        JSON.stringify({
          type: "assistant",
          timestamp: new Date(NOW_MS).toISOString(),
          usage_report: {
            rate_limits: { limits: [{ kind: "session", percent: 20, resets_at: null }] },
          },
        }),
        JSON.stringify({ type: "result", is_error: false, total_cost_usd: 0 }),
      ].join("\n"),
      exitCode: 0,
      timedOut: false,
      spawnError: null,
    };
  };
  const result = await runClaudeCapacityProbe(NOW_MS, { runner });
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, "not_local_command");
  assert.deepEqual(result.windowsUpdated, []);
  const rows = listCapacitySnapshots("claude_code");
  assert.equal(rows.find((r) => r.providerBucket === "five_hour")!.remainingPercent, 83);
});

test("probe success via the cache side effect when usage_report carries no windows", async () => {
  process.env[CLAUDE_CAPACITY_REFRESH_ENV] = "paid-after-1h";
  fs.writeFileSync(cacheFile, fullCacheFixture(NOW_MS - 61 * 60_000));
  // The local-command marker is present (so the run is trusted) and cost is
  // $0, but usage_report carries no usable limits[] — the cache re-read
  // (the probe run itself refreshes Claude's own cache file) still counts
  // as corroborating success.
  const runner: ProbeRunner = async () => {
    // A real probe refreshes Claude's own cache file while it runs, so the
    // new `fetchedAtMs` is later than the pre-spawn `NOW_MS` stamp — the
    // post-spawn re-read must accept it, not reject it as future.
    fs.writeFileSync(cacheFile, fullCacheFixture(NOW_MS + 5_000));
    return {
      stdout: [
        JSON.stringify({
          type: "assistant",
          timestamp: new Date(NOW_MS).toISOString(),
          local_command_run: { command: "usage", args: "" },
        }),
        JSON.stringify({ type: "result", is_error: false, total_cost_usd: 0 }),
      ].join("\n"),
      exitCode: 0,
      timedOut: false,
      spawnError: null,
    };
  };
  const result = await runClaudeCapacityProbe(NOW_MS, { runner });
  assert.equal(result.ok, true);
  assert.equal(result.failureKind, null);
  assert.deepEqual(result.windowsUpdated, ["claude_unified_five_hour", "claude_unified_seven_day"]);
  const rows = listCapacitySnapshots("claude_code");
  assert.equal(rows.find((r) => r.providerBucket === "five_hour")!.remainingPercent, 83);
  assert.equal(rows.find((r) => r.providerBucket === "five_hour")!.observedAt, new Date(NOW_MS + 5_000).toISOString());
});

test("probe failure preserves last-good rows and enters bounded backoff", async () => {
  process.env[CLAUDE_CAPACITY_REFRESH_ENV] = "paid-after-1h";
  fs.writeFileSync(cacheFile, fullCacheFixture(NOW_MS - 61 * 60_000));
  assert.equal(ingestClaudeLocalCache(NOW_MS), 2);
  let calls = 0;
  const failing: ProbeRunner = async () => {
    calls++;
    return { stdout: "not-json\n", exitCode: 1, timedOut: false, spawnError: null };
  };
  const first = await maybeProbeClaudeCapacity(NOW_MS, { runner: failing });
  assert.equal(first.probed, true);
  assert.equal(first.ok, false);
  // Unparsable stdout ("not-json") means no local-command marker is found —
  // that check runs before the nonzero-exit fallback.
  assert.equal(first.failureKind, "not_local_command");
  // Last-good rows are untouched by the failed probe (0.17 used → 83 left).
  const rows = listCapacitySnapshots("claude_code");
  assert.equal(rows.find((r) => r.providerBucket === "five_hour")!.remainingPercent, 83);
  // Never retry per UI poll: the next read backs off.
  const second = await maybeProbeClaudeCapacity(NOW_MS + 60_000, { runner: failing });
  assert.deepEqual(second, { probed: false, reason: "backoff" });
  assert.equal(calls, 1);
  // Exponential backoff: one failure doubles the 14-minute cooldown (28m).
  const during = await maybeProbeClaudeCapacity(NOW_MS + 15 * 60_000, { runner: failing });
  assert.deepEqual(during, { probed: false, reason: "backoff" });
  const after = await maybeProbeClaudeCapacity(NOW_MS + 29 * 60_000, { runner: failing });
  assert.equal(after.probed, true);
  assert.equal(calls, 2);
});

test("spawn failure is a bounded backoff, not a throw", async () => {
  process.env[CLAUDE_CAPACITY_REFRESH_ENV] = "paid-after-1h";
  const outcome = await maybeProbeClaudeCapacity(NOW_MS, {
    runner: async () => ({ stdout: "", exitCode: null, timedOut: false, spawnError: "ENOENT" }),
  });
  assert.equal(outcome.probed, true);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failureKind, "spawn");
});

test("full refresh ingests free cache first and skips the probe when fresh", async () => {
  process.env[CLAUDE_CAPACITY_REFRESH_ENV] = "paid-after-1h";
  fs.writeFileSync(cacheFile, fullCacheFixture(NOW_MS - 10 * 60_000));
  const outcome = await refreshClaudeCapacityIfStale(NOW_MS, { runner: throwingRunner });
  assert.deepEqual(outcome, { probed: false, reason: "fresh" });
  assert.equal(listCapacitySnapshots("claude_code").length, 2);
});

test("cache file override resolves from env, defaulting to ~/.claude.json", () => {
  assert.equal(claudeCacheFilePath(), cacheFile);
  delete process.env[CLAUDE_CACHE_FILE_ENV];
  assert.equal(
    claudeCacheFilePath(),
    path.join(process.env.HOME ?? os.homedir(), ".claude.json")
  );
});

test("a full ~/.claude.json-shaped file yields 5H/1W from the subtree only", () => {
  // Mirrors the observed real config at 2.1.283: percent-scale named
  // fields, kind/group/percent limits[], ISO resets, and sensitive
  // top-level + extra-usage siblings that must never persist.
  const fetchedAtMs = NOW_MS - 5 * 60_000;
  const observedIso = new Date(fetchedAtMs).toISOString();
  fs.writeFileSync(
    cacheFile,
    JSON.stringify({
      userID: "user-secret-must-never-persist",
      email: "someone@example.com",
      projects: { "/tmp/x": { history: ["sensitive"] } },
      cachedUsageUtilization: {
        fetchedAtMs,
        accountUuid: "acct-must-never-persist",
        utilization: {
          five_hour: {
            utilization: 99,
            resets_at: new Date(FIVE_HOUR_RESET_SEC * 1000).toISOString(),
          },
          seven_day: {
            utilization: 88,
            resets_at: new Date(SEVEN_DAY_RESET_SEC * 1000).toISOString(),
          },
          seven_day_sonnet: {
            utilization: 5,
            resets_at: new Date(SEVEN_DAY_RESET_SEC * 1000).toISOString(),
          },
          extra_usage: { is_enabled: true, used_credits: 4878, utilization: 69.68 },
          limits: [
            {
              kind: "session",
              group: "session",
              percent: 9,
              severity: "normal",
              resets_at: new Date(FIVE_HOUR_RESET_SEC * 1000).toISOString(),
              scope: null,
              is_active: false,
            },
            {
              kind: "weekly_all",
              group: "weekly",
              percent: 23,
              severity: "normal",
              resets_at: new Date(SEVEN_DAY_RESET_SEC * 1000).toISOString(),
              scope: null,
              is_active: true,
            },
          ],
        },
      },
    })
  );
  // The subtree extractor drops the envelope before parsing.
  const extracted = extractClaudeCacheSubtree(
    JSON.parse(fs.readFileSync(cacheFile, "utf8"))
  ) as Record<string, unknown>;
  assert.equal(typeof (extracted as { fetchedAtMs?: unknown }).fetchedAtMs, "number");
  assert.ok(!JSON.stringify(extracted).includes("user-secret-must-never-persist"));

  const result = readClaudeLocalCache(NOW_MS);
  assert.ok(result);
  assert.equal(result!.windows.length, 2);
  // limits[] (kind/group/percent) wins over the named fields per role.
  const fiveHour = result!.windows.find((w) => w.criticalRole === "five_hour")!;
  const weekly = result!.windows.find((w) => w.criticalRole === "weekly")!;
  assert.equal(fiveHour.usedPercent, 9);
  assert.equal(fiveHour.usedUnit, "percent");
  assert.equal(fiveHour.observedAt, observedIso);
  assert.equal(weekly.usedPercent, 23);
  assert.equal(weekly.observedAt, observedIso);
  for (const w of result!.windows) {
    const text = JSON.stringify(w);
    assert.ok(!text.includes("acct-must-never-persist"));
    assert.ok(!text.includes("user-secret-must-never-persist"));
    assert.ok(!text.includes("someone@example.com"));
    assert.ok(!text.includes("4878"));
  }
  assert.equal(ingestClaudeLocalCache(NOW_MS), 2);
  const snap = getRuntimeCapacitySnapshot(NOW_MS);
  const claude = snap.runtimes.find((r) => r.runtime === "claude_code")!;
  assert.equal(claude.windows.find((w) => w.displayLabel === "5H")!.remainingPercent, 91);
  assert.equal(claude.windows.find((w) => w.displayLabel === "1W")!.remainingPercent, 77);
});

// ---------------------------------------------------------------------------
// NOT-366: the re-validated `/usage` contract and unavailable-reason rows
// ---------------------------------------------------------------------------

/**
 * Sanitized shape of a real `claude -p "/usage"` stream-json run at 2.1.292
 * (Dealer's exact probe argv, re-validated 2026-10-07): `system/init`, then
 * the synthetic assistant event carrying `local_command_run` and
 * `usage_report.rate_limits.limits[]`, then a `result` event with
 * `local_command: "usage"`, `num_turns: 0`, `total_cost_usd: 0` — and no
 * `usage_report` of its own (which is why `--output-format json`, printing
 * only the result, never shows it). `apiKeySource` other than `none` yields
 * the cost-summary-only variant: no `usage_report` at all.
 */
function liveUsageStream(
  observedMs: number,
  opts: { apiKeySource?: string; withReport?: boolean } = {}
): string {
  const withReport = opts.withReport ?? true;
  const events: Array<Record<string, unknown>> = [
    { type: "system", subtype: "init", apiKeySource: opts.apiKeySource ?? "none", claude_code_version: "2.1.292" },
    {
      type: "assistant",
      message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "<omitted>" }] },
      local_command_source: "<omitted>",
      timestamp: new Date(observedMs).toISOString(),
      local_command_run: { command: "usage", args: "" },
      ...(withReport
        ? {
            usage_report: {
              session: { total_cost_usd: 0, total_api_duration_ms: 0 },
              rate_limits: {
                limits: [
                  {
                    kind: "session",
                    group: "session",
                    percent: 6,
                    resets_at: new Date(observedMs + 4 * 3600_000).toISOString().replace("Z", "535018+00:00"),
                    scope: null,
                    severity: "normal",
                    is_active: true,
                  },
                  {
                    kind: "weekly_all",
                    group: "weekly",
                    percent: 5,
                    resets_at: new Date(observedMs + 5 * 86_400_000).toISOString().replace("Z", "535047+00:00"),
                    scope: null,
                    severity: "normal",
                    is_active: false,
                  },
                ],
                extra_usage: { is_enabled: false },
              },
            },
          }
        : {}),
    },
    { type: "result", subtype: "success", is_error: false, num_turns: 0, total_cost_usd: 0, local_command: "usage" },
  ];
  return events.map((e) => JSON.stringify(e)).join("\n");
}

function streamRunner(stdout: (atMs: number) => string, atMs: () => number): ProbeRunner {
  return async () => ({ stdout: stdout(atMs()), exitCode: 0, timedOut: false, spawnError: null });
}

test("re-validated 2.1.292 /usage stream yields both five_hour and weekly", async () => {
  const { extractClaudeUsageReportLimits } = await import("./claude-local-cache.js");
  const readings = extractClaudeUsageReportLimits(parseNdjson(liveUsageStream(NOW_MS)), NOW_MS);
  assert.ok(readings);
  assert.deepEqual(readings!.map((w) => w.criticalRole).sort(), ["five_hour", "weekly"]);
  // The full probe accepts it: marker present, exactly $0, both roles.
  const result = await runClaudeCapacityProbe(NOW_MS, {
    runner: streamRunner((ms) => liveUsageStream(ms), () => NOW_MS),
    bin: "/fake/claude",
  });
  assert.equal(result.ok, true);
  assert.equal(result.authSource, "none");
  const snap = getRuntimeCapacitySnapshot(NOW_MS + 1000);
  const claude = snap.runtimes.find((r) => r.runtime === "claude_code")!;
  assert.equal(claude.windows.find((w) => w.criticalRole === "five_hour")!.remainingPercent, 94);
  assert.equal(claude.windows.find((w) => w.criticalRole === "weekly")!.remainingPercent, 95);
});

test("no_windows failure persists an unavailable row; streak rises to 3 then a success clears it", async () => {
  const failing = streamRunner((ms) => liveUsageStream(ms, { withReport: false }), () => clock);
  let clock = NOW_MS;
  const firstIso = new Date(NOW_MS).toISOString();
  // Backoff after n failures: 14m · 2^n → attempts at +0, +29m, +86m, +199m.
  const attemptAt = [NOW_MS, NOW_MS + 29 * 60_000, NOW_MS + 86 * 60_000];
  for (const [i, at] of attemptAt.entries()) {
    clock = at;
    const outcome = await maybeProbeClaudeCapacity(at, { runner: failing, bin: "/fake/claude" });
    assert.equal(outcome.probed, true);
    assert.equal(outcome.failureKind, "no_windows");
    const rows = listCapacitySnapshots("claude_code");
    assert.equal(rows.length, 2, "one stored row per critical window");
    for (const row of rows) {
      assert.ok(row.unavailableReason, "unavailable_reason is populated");
      assert.equal(row.source, "unavailable");
      assert.ok(row.unavailableDetail);
      assert.equal(row.unavailableDetail!.consecutiveFailures, i + 1);
      assert.equal(row.unavailableDetail!.firstFailureAt, firstIso);
      assert.equal(row.unavailableDetail!.lastFailureAt, new Date(at).toISOString());
      assert.match(row.unavailableDetail!.message, /no 5H\/1W plan limits/);
    }
  }
  // Read model: N/A with the operator text, never the internal identifier.
  const failedSnap = getRuntimeCapacitySnapshot(clock);
  const failedClaude = failedSnap.runtimes.find((r) => r.runtime === "claude_code")!;
  assert.ok(failedClaude.windows.every((w) => w.remainingPercent === null && w.unavailableDetail));
  assert.ok(!JSON.stringify(failedSnap).includes("no_windows"));

  clock = NOW_MS + 199 * 60_000;
  const ok = await maybeProbeClaudeCapacity(clock, {
    runner: streamRunner((ms) => liveUsageStream(ms), () => clock),
    bin: "/fake/claude",
  });
  assert.equal(ok.ok, true);
  for (const row of listCapacitySnapshots("claude_code")) {
    assert.equal(row.unavailableReason, null);
    assert.equal(row.unavailableDetail, null);
    assert.equal(row.source, "observed_event");
  }
  // The next failure starts a new streak at 1.
  clock = NOW_MS + 260 * 60_000;
  await maybeProbeClaudeCapacity(clock, { runner: failing, bin: "/fake/claude" });
  for (const row of listCapacitySnapshots("claude_code")) {
    assert.equal(row.unavailableDetail!.consecutiveFailures, 1);
    assert.equal(row.unavailableDetail!.firstFailureAt, new Date(clock).toISOString());
  }
});

test("an API-key auth source is named in the stored reason", async () => {
  const outcome = await maybeProbeClaudeCapacity(NOW_MS, {
    runner: streamRunner((ms) => liveUsageStream(ms, { withReport: false, apiKeySource: "ANTHROPIC_API_KEY" }), () => NOW_MS),
    bin: "/fake/claude",
  });
  assert.equal(outcome.failureKind, "no_windows");
  const row = listCapacitySnapshots("claude_code")[0]!;
  assert.match(row.unavailableDetail!.message, /authenticated via ANTHROPIC_API_KEY/);
});

test("a failure leaves a current reading alone and keeps a stale one's value for arbitration", async () => {
  // 5H current (10m old), 1W stale (20m old — past the 15m freshness).
  seedWindowAges(10 * 60_000, 20 * 60_000);
  assert.equal(recordClaudeAcquisitionFailure({ failureKind: "timeout", authSource: null }, NOW_MS), 1);
  const rows = listCapacitySnapshots("claude_code");
  const five = rows.find((r) => r.criticalRole === "five_hour")!;
  const weekly = rows.find((r) => r.criticalRole === "weekly")!;
  assert.equal(five.unavailableReason, null);
  assert.equal(five.source, "observed_event");
  assert.equal(weekly.unavailableReason, "missing");
  assert.equal(weekly.unavailableDetail!.message, "the Claude /usage refresh timed out");
  assert.equal(weekly.observedAt, new Date(NOW_MS - 20 * 60_000).toISOString());
  // Re-ingesting the same stale sample (every poll does) must not wipe the reason.
  seedWindowAges(null, 20 * 60_000, NOW_MS, 0);
  assert.equal(
    listCapacitySnapshots("claude_code").find((r) => r.criticalRole === "weekly")!.unavailableReason,
    "missing"
  );
});

test("a fresh observed_event reading wins over a stored unavailable row and leaves no reason", () => {
  // Failure recorded at NOW with no prior reading at all.
  assert.equal(recordClaudeAcquisitionFailure({ failureKind: "no_windows", authSource: null }, NOW_MS), 2);
  // A live session's reading observed 2 minutes before the failure stamp.
  seedWindowAges(2 * 60_000, 2 * 60_000);
  const snap = getRuntimeCapacitySnapshot(NOW_MS + 60_000);
  const claude = snap.runtimes.find((r) => r.runtime === "claude_code")!;
  for (const w of claude.windows) {
    assert.ok(w.remainingPercent !== null, "the rendered window shows the value");
    assert.equal(w.unavailableReason, null);
    assert.equal(w.unavailableDetail ?? null, null);
    assert.equal(w.source, "observed_event");
  }
  assert.equal(claude.unavailableReason, null);
});
