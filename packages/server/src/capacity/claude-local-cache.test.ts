// packages/server/src/capacity/claude-local-cache.test.ts
//
// NOT-268: Claude capacity local-first ladder — local cache 5H/1W plus a
// one-hour paid fallback. No test here performs a live provider request:
// every probe spawn goes through an injected fake runner.
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProbeRunner } from "./claude-local-cache.js";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-claude-cache-"));

const { migrate } = await import("../db/index.js");
const { createAgent } = await import("../repository/agents.js");
const {
  listCapacitySnapshots,
  clearAllCapacitySnapshots,
} = await import("../repository/runtime-capacity.js");
const { parseNdjson } = await import("../runners/stream-json.js");
const { getRuntimeCapacitySnapshot } = await import("./service.js");
const { recordClaudeCapacityFromEvents } = await import("./claude-events.js");
const {
  CLAUDE_CACHE_FILE_ENV,
  CLAUDE_CAPACITY_REFRESH_ENV,
  buildClaudeProbeArgv,
  claudeCacheFilePath,
  extractClaudeCacheSubtree,
  ingestClaudeLocalCache,
  isClaudePaidFallbackEnabled,
  maybeProbeClaudeCapacity,
  newestValidClaudeObservationMs,
  parseClaudeCachedUtilization,
  probeDiagnosticLogPath,
  readClaudeLocalCache,
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

function probeStreamFixture(observedIso: string, costUsd = 0.0003): string {
  return [
    JSON.stringify({
      type: "rate_limit_event",
      timestamp: observedIso,
      rate_limit_info: {
        status: "allowed",
        unifiedWindows: [
          { window: "five_hour", utilization: 0.2, resetsAt: FIVE_HOUR_RESET_SEC },
          { window: "seven_day", utilization: 0.4, resetsAt: SEVEN_DAY_RESET_SEC },
        ],
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

test("disabled fallback never spawns: every non-opt-in value is a strict no-op", async () => {
  for (const value of [undefined, "", "off", "auto", "paid-after-1h "] as const) {
    if (value === undefined) delete process.env[CLAUDE_CAPACITY_REFRESH_ENV];
    else process.env[CLAUDE_CAPACITY_REFRESH_ENV] = value;
    assert.equal(isClaudePaidFallbackEnabled(), false);
    const outcome = await maybeProbeClaudeCapacity(NOW_MS, { runner: throwingRunner });
    assert.deepEqual(outcome, { probed: false, reason: "disabled" });
  }
  process.env[CLAUDE_CAPACITY_REFRESH_ENV] = "paid-after-1h";
  assert.equal(isClaudePaidFallbackEnabled(), true);
});

test("fresh sample suppresses the probe; stale data triggers exactly one", async () => {
  process.env[CLAUDE_CAPACITY_REFRESH_ENV] = "paid-after-1h";
  fs.writeFileSync(cacheFile, fullCacheFixture(NOW_MS - 10 * 60_000));
  assert.equal(ingestClaudeLocalCache(NOW_MS), 2);
  assert.ok((newestValidClaudeObservationMs(NOW_MS) ?? 0) > NOW_MS - 60 * 60_000);
  const fresh = await maybeProbeClaudeCapacity(NOW_MS, { runner: throwingRunner });
  assert.deepEqual(fresh, { probed: false, reason: "fresh" });

  // All samples ≥60 minutes old: five concurrent readers share one probe.
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

test("probe argv pins the fixed prompt, cheapest model, no tools/MCP, one turn, ≤$0.01", async () => {
  process.env[CLAUDE_CAPACITY_REFRESH_ENV] = "paid-after-1h";
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
    "Reply with exactly: ok",
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
  // Semantic pins behind the exact match: cheapest model, hard one-turn
  // bound, tools fully off, MCP restricted to none passed, stream JSON,
  // hard budget cap.
  assert.equal(seenArgv[seenArgv.indexOf("--model") + 1], "haiku");
  assert.equal(seenArgv[seenArgv.indexOf("--max-turns") + 1], "1");
  assert.equal(seenArgv[seenArgv.indexOf("--tools") + 1], "");
  assert.ok(!seenArgv.includes("--mcp-config"));
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
    stdout: `${probeStreamFixture(new Date(NOW_MS).toISOString(), 0.0007)}\n${JSON.stringify({ type: "assistant", text: marker })}`,
    exitCode: 0,
    timedOut: false,
    spawnError: null,
  });
  const result = await runClaudeCapacityProbe(NOW_MS, { runner });
  assert.equal(result.ok, true);
  assert.equal(result.failureKind, null);
  assert.equal(result.costUsd, 0.0007);
  assert.deepEqual(result.windowsUpdated, ["claude_unified_five_hour", "claude_unified_seven_day"]);
  const rows = listCapacitySnapshots("claude_code");
  assert.equal(rows.find((r) => r.providerBucket === "five_hour")!.remainingPercent, 80);
  assert.equal(rows.find((r) => r.providerBucket === "seven_day")!.remainingPercent, 60);
  assert.equal(rows.find((r) => r.providerBucket === "five_hour")!.observedAt, new Date(NOW_MS).toISOString());
  const logText = fs.readFileSync(probeDiagnosticLogPath(), "utf8");
  assert.ok(logText.includes('"costUsd":0.0007'));
  assert.ok(!logText.includes("Reply with exactly"));
  assert.ok(!logText.includes(marker));
});

test("probe success via the cache side effect when the stream carries no windows", async () => {
  process.env[CLAUDE_CAPACITY_REFRESH_ENV] = "paid-after-1h";
  fs.writeFileSync(cacheFile, fullCacheFixture(NOW_MS - 61 * 60_000));
  // The stream is empty but the probe run itself refreshes Claude's own
  // cache file — the re-read must count as success.
  const runner: ProbeRunner = async () => {
    fs.writeFileSync(cacheFile, fullCacheFixture(NOW_MS));
    return { stdout: "", exitCode: 0, timedOut: false, spawnError: null };
  };
  const result = await runClaudeCapacityProbe(NOW_MS, { runner });
  assert.equal(result.ok, true);
  assert.equal(result.failureKind, null);
  assert.deepEqual(result.windowsUpdated, ["claude_unified_five_hour", "claude_unified_seven_day"]);
  const rows = listCapacitySnapshots("claude_code");
  assert.equal(rows.find((r) => r.providerBucket === "five_hour")!.remainingPercent, 83);
  assert.equal(rows.find((r) => r.providerBucket === "five_hour")!.observedAt, new Date(NOW_MS).toISOString());
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
  assert.equal(first.failureKind, "nonzero_exit");
  // Last-good rows are untouched by the failed probe (0.17 used → 83 left).
  const rows = listCapacitySnapshots("claude_code");
  assert.equal(rows.find((r) => r.providerBucket === "five_hour")!.remainingPercent, 83);
  // Never retry per UI poll: the next read backs off.
  const second = await maybeProbeClaudeCapacity(NOW_MS + 60_000, { runner: failing });
  assert.deepEqual(second, { probed: false, reason: "backoff" });
  assert.equal(calls, 1);
  // Exponential backoff: one failure doubles the 60-minute cooldown.
  const during = await maybeProbeClaudeCapacity(NOW_MS + 61 * 60_000, { runner: failing });
  assert.deepEqual(during, { probed: false, reason: "backoff" });
  const after = await maybeProbeClaudeCapacity(NOW_MS + 121 * 60_000, { runner: failing });
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
