// packages/server/src/capacity/claude-events.test.ts
//
// NOT-248: naturally observed Claude unified windows become capacity
// snapshots (source `observed_event`) while NOT-111 hard-cap deferral keeps
// its exact behavior on `runtime_availability`.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-claude-cap-"));
process.env.USAGE_CAP_FALLBACK_COOLDOWN_MS = "1800000";

const capacityDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(capacityDir, "..", "runners", "fixtures");
const allowedFixture = fs.readFileSync(
  path.join(fixtureDir, "claude-rate-limit-allowed-unified-windows.ndjson"),
  "utf8"
);
const rejectedWindowsFixture = fs.readFileSync(
  path.join(fixtureDir, "claude-rate-limit-rejected-unified-windows.ndjson"),
  "utf8"
);
const legacyRejectedFixture = fs.readFileSync(
  path.join(fixtureDir, "claude-rate-limit-rejected.ndjson"),
  "utf8"
);

const { migrate } = await import("../db/index.js");
const { parseNdjson } = await import("../runners/stream-json.js");
const {
  detectUsageCapFromNdjson,
  recordUsageCapFromEvents,
} = await import("../runners/usage-cap.js");
const {
  runtimeAvailability,
  clearAllRuntimeAvailability,
} = await import("../repository/runtime-availability.js");
const {
  listCapacitySnapshots,
  clearAllCapacitySnapshots,
} = await import("../repository/runtime-capacity.js");
const { getRuntimeCapacitySnapshot } = await import("./service.js");
const {
  claudeEventObservedAt,
  claudeUnifiedWindowsToReadings,
  extractClaudeCapacityFromEvents,
  inferClaudeDurationMinutes,
  normalizeClaudeResetsAt,
  parseClaudeEventTimestamp,
  recordClaudeCapacityFromEvents,
  recordClaudeCapacityFromLog,
} = await import("./claude-events.js");

const NOW_MS = Date.parse("2026-01-01T00:00:00.000Z");
const FIVE_HOUR_RESET = new Date(1784283600 * 1000).toISOString();
const SEVEN_DAY_RESET = new Date(1800000000 * 1000).toISOString();

before(() => migrate());
beforeEach(() => {
  clearAllCapacitySnapshots();
  clearAllRuntimeAvailability();
});

test("allowed five_hour utilization 0.17 reads 83% remaining with provider reset", () => {
  const result = extractClaudeCapacityFromEvents(parseNdjson(allowedFixture), NOW_MS);
  assert.ok(result);
  assert.equal(result!.runtime, "claude_code");
  const fiveHour = result!.windows.find((w) => w.providerBucket === "five_hour")!;
  assert.ok(fiveHour);
  assert.equal(fiveHour.usedFraction, 0.17);
  assert.equal(fiveHour.resetAt, FIVE_HOUR_RESET);
  assert.equal(fiveHour.source, "observed_event");

  const count = recordClaudeCapacityFromEvents(parseNdjson(allowedFixture), "claude_code", NOW_MS);
  assert.equal(count, 3);
  const snap = getRuntimeCapacitySnapshot(NOW_MS);
  const claude = snap.runtimes.find((r) => r.runtime === "claude_code")!;
  const stored = claude.windows.find((w) => w.providerBucket === "five_hour")!;
  // The exact inputs the Agents strip renders as the `5H 83%` chip.
  assert.equal(stored.displayLabel, "5H");
  assert.equal(stored.remainingPercent, 83);
  assert.equal(stored.resetAt, FIVE_HOUR_RESET);
  assert.equal(stored.unavailableReason, null);
  assert.equal(stored.source, "observed_event");
  assert.equal(claude.unavailableReason, null);
});

test("allowed events persist capacity without opening a NOT-111 cap", () => {
  assert.equal(detectUsageCapFromNdjson(allowedFixture, "claude_code", NOW_MS), null);
  assert.equal(
    recordClaudeCapacityFromEvents(parseNdjson(allowedFixture), "claude_code", NOW_MS),
    3
  );
  assert.equal(runtimeAvailability("claude_code", NOW_MS).available, true);
});

test("five-hour and seven-day windows persist independently", () => {
  recordClaudeCapacityFromEvents(parseNdjson(allowedFixture), "claude_code", NOW_MS);
  const rows = listCapacitySnapshots("claude_code");
  const fiveHour = rows.find((w) => w.providerBucket === "five_hour")!;
  const sevenDay = rows.find((w) => w.providerBucket === "seven_day")!;
  assert.ok(fiveHour && sevenDay);
  assert.equal(fiveHour.remainingPercent, 83);
  assert.equal(sevenDay.remainingPercent, 58);
  assert.notEqual(fiveHour.resetAt, sevenDay.resetAt);
  assert.equal(fiveHour.criticalRole, "five_hour");
  assert.equal(sevenDay.criticalRole, "weekly");

  // A later partial observation (five_hour only) upserts its row and leaves
  // the seven-day sibling untouched.
  const partial = [
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":[{"window":"five_hour","utilization":0.5,"resetsAt":1784283600}]}}',
  ].join("\n");
  assert.equal(recordClaudeCapacityFromEvents(parseNdjson(partial), "claude_code", NOW_MS), 1);
  const after = listCapacitySnapshots("claude_code");
  assert.equal(after.find((w) => w.providerBucket === "five_hour")!.remainingPercent, 50);
  assert.equal(after.find((w) => w.providerBucket === "seven_day")!.remainingPercent, 58);
});

test("model-specific and overage windows remain distinguishable", () => {
  recordClaudeCapacityFromEvents(parseNdjson(allowedFixture), "claude_code", NOW_MS);
  recordClaudeCapacityFromEvents(parseNdjson(rejectedWindowsFixture), "claude_code", NOW_MS);
  const rows = listCapacitySnapshots("claude_code");
  const sonnet = rows.find((w) => w.providerBucket === "seven_day_sonnet")!;
  const overage = rows.find((w) => w.providerBucket === "seven_day_overage")!;
  const plain = rows.find((w) => w.providerBucket === "seven_day")!;
  assert.ok(sonnet && overage && plain);
  const keys = new Set(rows.map((w) => w.windowKey));
  assert.equal(keys.size, rows.length);
  assert.notEqual(sonnet.windowKey, plain.windowKey);
  assert.notEqual(overage.windowKey, plain.windowKey);
  // Shared seven-day length, independent identities and values.
  assert.equal(sonnet.durationMinutes, 10080);
  assert.equal(overage.durationMinutes, 10080);
  assert.equal(sonnet.remainingPercent, 39);
  assert.equal(overage.remainingPercent, 50);
  // Same 10,080-minute duration as the real account-wide weekly window, but
  // neither model-specific/overage extra is ever the critical window.
  assert.equal(sonnet.criticalRole, null);
  assert.equal(overage.criticalRole, null);
  assert.equal(plain.criticalRole, "weekly");
});

test("legacy rejected fixture still caps (NOT-111) and fabricates no capacity", () => {
  const events = parseNdjson(legacyRejectedFixture);
  const cap = recordUsageCapFromEvents(events, "claude_code", NOW_MS);
  assert.ok(cap);
  assert.equal(cap!.unavailableUntil, FIVE_HOUR_RESET);
  const avail = runtimeAvailability("claude_code", NOW_MS);
  assert.equal(avail.available, false);

  // No unifiedWindows on the legacy event: no capacity row is fabricated.
  assert.equal(recordClaudeCapacityFromEvents(events, "claude_code", NOW_MS), null);
  assert.equal(listCapacitySnapshots("claude_code").length, 0);
});

test("rejected event with unified windows both caps and persists snapshots", () => {
  const events = parseNdjson(rejectedWindowsFixture);
  const cap = recordUsageCapFromEvents(events, "claude_code", NOW_MS);
  assert.ok(cap);
  assert.equal(runtimeAvailability("claude_code", NOW_MS).available, false);

  assert.equal(recordClaudeCapacityFromEvents(events, "claude_code", NOW_MS), 2);
  // The hard-cap row is untouched by capacity ingestion.
  assert.equal(runtimeAvailability("claude_code", NOW_MS).available, false);
  const rows = listCapacitySnapshots("claude_code");
  assert.equal(rows.length, 2);
  assert.equal(rows.find((w) => w.providerBucket === "five_hour")!.remainingPercent, 1);
});

test("latest rate_limit_event wins within one session", () => {
  const raw = [
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":[{"window":"five_hour","utilization":0.9,"resetsAt":1784283600}]}}',
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":[{"window":"five_hour","utilization":0.1,"resetsAt":1784283600}]}}',
  ].join("\n");
  recordClaudeCapacityFromEvents(parseNdjson(raw), "claude_code", NOW_MS);
  assert.equal(listCapacitySnapshots("claude_code")[0]!.remainingPercent, 90);
});

test("old observations go stale then expired under shared rules, never live", () => {
  recordClaudeCapacityFromEvents(parseNdjson(allowedFixture), "claude_code", NOW_MS);
  for (const row of listCapacitySnapshots("claude_code")) {
    assert.equal(row.source, "observed_event");
  }
  // 30 min later: past the 15-min freshness horizon, inside 60-min expiry.
  const stale = getRuntimeCapacitySnapshot(NOW_MS + 30 * 60_000);
  const staleClaude = stale.runtimes.find((r) => r.runtime === "claude_code")!;
  assert.ok(staleClaude.windows.length > 0);
  for (const w of staleClaude.windows) {
    assert.equal(w.remainingPercent, null);
    assert.equal(w.unavailableReason, "stale");
  }
  assert.equal(staleClaude.unavailableReason, "stale");
  // 2 h later: past expiry.
  const expired = getRuntimeCapacitySnapshot(NOW_MS + 2 * 3600_000);
  const expiredClaude = expired.runtimes.find((r) => r.runtime === "claude_code")!;
  for (const w of expiredClaude.windows) {
    assert.equal(w.remainingPercent, null);
    assert.equal(w.unavailableReason, "expired");
  }
  assert.equal(expiredClaude.unavailableReason, "expired");
});

test("missing or malformed unified windows record nothing", () => {
  const cases = [
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}',
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":[]}}',
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{}}}',
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":"five_hour"}}',
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":[{"window":"five_hour"}]}}',
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":[{"window":"five_hour","utilization":"high"}]}}',
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":[{"window":"five_hour","utilization":null}]}}',
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":[42,null,"x"]}}',
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":[{"utilization":0.2}]}}',
    '{"type":"result","is_error":false,"result":"done"}',
  ];
  for (const raw of cases) {
    assert.equal(
      recordClaudeCapacityFromEvents(parseNdjson(raw), "claude_code", NOW_MS),
      null,
      raw
    );
  }
  assert.equal(listCapacitySnapshots("claude_code").length, 0);
  assert.equal(extractClaudeCapacityFromEvents(parseNdjson(cases.join("\n")), NOW_MS), null);
});

test("parser tolerates map form, bare numbers, percent scale, and reset variants", () => {
  const observedAt = new Date(NOW_MS).toISOString();
  const readings = claudeUnifiedWindowsToReadings(
    {
      unifiedWindows: {
        five_hour: { utilization: 0.2, resetsAt: 1784283600 },
        seven_day: 0.3,
        all_models: { utilization: 0.1, resetsAt: 1784283600 },
        custom_bucket: {
          usedPercent: 25,
          resets_at: "2030-01-01T00:00:00.000Z",
          durationMinutes: 720,
        },
      },
    },
    observedAt
  );
  assert.ok(readings);
  assert.equal(readings!.windows.length, 4);
  const unknown = readings!.windows.find((w) => w.providerBucket === "all_models")!;
  assert.equal(unknown.durationMinutes, null);
  assert.equal(unknown.providerLabel, "all_models");
  const seven = readings!.windows.find((w) => w.providerBucket === "seven_day")!;
  assert.equal(seven.usedFraction, 0.3);
  assert.equal(seven.resetAt, null);
  const custom = readings!.windows.find((w) => w.providerBucket === "custom_bucket")!;
  assert.equal(custom.usedPercent, 25);
  assert.equal(custom.resetAt, "2030-01-01T00:00:00.000Z");
  // Explicit duration honored; unknown bucket keeps its label verbatim.
  assert.equal(custom.durationMinutes, 720);
  assert.equal(custom.providerLabel, "custom_bucket");
});

test("reset normalization accepts ms epochs and ISO strings", () => {
  assert.equal(normalizeClaudeResetsAt(1784283600000), FIVE_HOUR_RESET);
  assert.equal(normalizeClaudeResetsAt("1784283600"), FIVE_HOUR_RESET);
  assert.equal(normalizeClaudeResetsAt(FIVE_HOUR_RESET), FIVE_HOUR_RESET);
  assert.equal(normalizeClaudeResetsAt("  "), null);
  assert.equal(normalizeClaudeResetsAt("not-a-date"), null);
  assert.equal(normalizeClaudeResetsAt(-5), null);
  assert.equal(normalizeClaudeResetsAt(undefined), null);
});

test("duration inference covers known buckets only", () => {
  assert.equal(inferClaudeDurationMinutes("five_hour"), 300);
  assert.equal(inferClaudeDurationMinutes("FIVE-HOUR"), 300);
  assert.equal(inferClaudeDurationMinutes("seven_day"), 10080);
  assert.equal(inferClaudeDurationMinutes("seven_day_sonnet"), 10080);
  assert.equal(inferClaudeDurationMinutes("seven_day_overage"), 10080);
  assert.equal(inferClaudeDurationMinutes("weekly"), 10080);
  assert.equal(inferClaudeDurationMinutes("all_models"), null);
  assert.equal(inferClaudeDurationMinutes("monthly"), null);
});

test("event timestamps parse from ISO, epoch seconds, and epoch ms", () => {
  assert.equal(parseClaudeEventTimestamp("2026-01-01T00:00:00.000Z"), NOW_MS);
  assert.equal(parseClaudeEventTimestamp(1767225600), NOW_MS);
  assert.equal(parseClaudeEventTimestamp(1767225600000), NOW_MS);
  assert.equal(parseClaudeEventTimestamp("1767225600"), NOW_MS);
  assert.equal(parseClaudeEventTimestamp("garbage"), null);
  assert.equal(parseClaudeEventTimestamp("  "), null);
  assert.equal(parseClaudeEventTimestamp(-5), null);
  assert.equal(parseClaudeEventTimestamp(null), null);
  assert.equal(parseClaudeEventTimestamp(undefined), null);
  assert.equal(parseClaudeEventTimestamp({}), null);
});

test("event observedAt prefers the event timestamp, clamped to session end", () => {
  const eventTime = new Date(NOW_MS - 3 * 3600_000).toISOString();
  assert.equal(
    claudeEventObservedAt(
      { type: "rate_limit_event", timestamp: eventTime },
      NOW_MS,
      NOW_MS - 4 * 3600_000
    ),
    eventTime
  );
  // A timestamp newer than session end is impossible — clamp to ingestion.
  assert.equal(
    claudeEventObservedAt(
      { type: "rate_limit_event", timestamp: new Date(NOW_MS + 3600_000).toISOString() },
      NOW_MS,
      NOW_MS - 3600_000
    ),
    new Date(NOW_MS).toISOString()
  );
  // Garbage timestamps fall through to the spawn-start fallback, never now.
  assert.equal(
    claudeEventObservedAt(
      { type: "rate_limit_event", timestamp: "not-a-time" },
      NOW_MS,
      NOW_MS - 3600_000
    ),
    new Date(NOW_MS - 3600_000).toISOString()
  );
  assert.equal(
    claudeEventObservedAt({ type: "rate_limit_event" }, NOW_MS, NOW_MS - 3600_000),
    new Date(NOW_MS - 3600_000).toISOString()
  );
});

test("a long session stamps the early event time, not session end", () => {
  // The rate_limit_event arrived 3 h into a 5 h session; ingesting at session
  // end must not present the 3-hour-old reading as freshly observed.
  const spawnStart = NOW_MS - 5 * 3600_000;
  const eventAt = NOW_MS - 2 * 3600_000;
  const raw = [
    `{"type":"rate_limit_event","timestamp":"${new Date(eventAt).toISOString()}","rate_limit_info":{"status":"allowed","unifiedWindows":[{"window":"five_hour","utilization":0.17,"resetsAt":1784283600}]}}`,
    '{"type":"result","is_error":false,"result":"Done.","duration_ms":900}',
  ].join("\n");
  const result = extractClaudeCapacityFromEvents(parseNdjson(raw), NOW_MS, spawnStart);
  assert.ok(result);
  assert.equal(result!.windows[0]!.observedAt, new Date(eventAt).toISOString());

  assert.equal(recordClaudeCapacityFromEvents(parseNdjson(raw), "claude_code", NOW_MS, spawnStart), 1);
  const stored = listCapacitySnapshots("claude_code")[0]!;
  assert.equal(stored.observedAt, new Date(eventAt).toISOString());
  // At session end the reading is 2 h old: expired under shared rules, never
  // rendered as a live remaining %.
  const snap = getRuntimeCapacitySnapshot(NOW_MS);
  const claude = snap.runtimes.find((r) => r.runtime === "claude_code")!;
  assert.equal(claude.windows[0]!.remainingPercent, null);
  assert.equal(claude.windows[0]!.unavailableReason, "expired");
});

test("events without timestamps fall back to spawn start, not session end", () => {
  const spawnStart = NOW_MS - 2 * 3600_000;
  const result = extractClaudeCapacityFromEvents(parseNdjson(allowedFixture), NOW_MS, spawnStart);
  assert.ok(result);
  for (const w of result!.windows) {
    assert.equal(w.observedAt, new Date(spawnStart).toISOString());
  }
  assert.equal(
    recordClaudeCapacityFromEvents(parseNdjson(allowedFixture), "claude_code", NOW_MS, spawnStart),
    3
  );
  const rows = listCapacitySnapshots("claude_code");
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(row.observedAt, new Date(spawnStart).toISOString());
  }
});

test("a later-finishing session never overwrites a newer stored reading", () => {
  const eventAt = NOW_MS - 10 * 60_000;
  const raw = (util: number, ts: string) =>
    `{"type":"rate_limit_event","timestamp":"${ts}","rate_limit_info":{"status":"allowed","unifiedWindows":[{"window":"five_hour","utilization":${util},"resetsAt":1784283600}]}}`;
  // A concurrent session already persisted a reading observed at eventAt.
  assert.equal(
    recordClaudeCapacityFromEvents(
      parseNdjson(raw(0.5, new Date(eventAt).toISOString())),
      "claude_code",
      NOW_MS,
      eventAt
    ),
    1
  );
  assert.equal(listCapacitySnapshots("claude_code")[0]!.remainingPercent, 50);
  // A long session that started earlier finishes later with an older event:
  // the stored row keeps the newer reading.
  const olderAt = NOW_MS - 3 * 3600_000;
  assert.equal(
    recordClaudeCapacityFromEvents(
      parseNdjson(raw(0.1, new Date(olderAt).toISOString())),
      "claude_code",
      NOW_MS + 60_000,
      olderAt
    ),
    0
  );
  const kept = listCapacitySnapshots("claude_code")[0]!;
  assert.equal(kept.remainingPercent, 50);
  assert.equal(kept.observedAt, new Date(eventAt).toISOString());
  // A genuinely newer observation still upserts.
  const newerAt = NOW_MS - 5 * 60_000;
  assert.equal(
    recordClaudeCapacityFromEvents(
      parseNdjson(raw(0.2, new Date(newerAt).toISOString())),
      "claude_code",
      NOW_MS + 120_000,
      newerAt
    ),
    1
  );
  assert.equal(listCapacitySnapshots("claude_code")[0]!.remainingPercent, 80);
});

test("per-window freshness: a newer event updates only its own windows", () => {
  const t0 = NOW_MS - 60 * 60_000;
  const t1 = NOW_MS - 10 * 60_000;
  const raw = [
    `{"type":"rate_limit_event","timestamp":"${new Date(t0).toISOString()}","rate_limit_info":{"status":"allowed","unifiedWindows":[{"window":"five_hour","utilization":0.9,"resetsAt":1784283600},{"window":"seven_day","utilization":0.4,"resetsAt":1800000000}]}}`,
    `{"type":"rate_limit_event","timestamp":"${new Date(t1).toISOString()}","rate_limit_info":{"status":"allowed","unifiedWindows":[{"window":"five_hour","utilization":0.1,"resetsAt":1784283600}]}}`,
  ].join("\n");
  assert.equal(recordClaudeCapacityFromEvents(parseNdjson(raw), "claude_code", NOW_MS, t0), 2);
  const rows = listCapacitySnapshots("claude_code");
  assert.equal(rows.find((w) => w.providerBucket === "five_hour")!.remainingPercent, 90);
  assert.equal(rows.find((w) => w.providerBucket === "five_hour")!.observedAt, new Date(t1).toISOString());
  assert.equal(rows.find((w) => w.providerBucket === "seven_day")!.remainingPercent, 60);
  assert.equal(rows.find((w) => w.providerBucket === "seven_day")!.observedAt, new Date(t0).toISOString());
});

test("log-file ingestion: missing file and non-Claude runtimes are no-ops", () => {
  assert.equal(
    recordClaudeCapacityFromLog("/nonexistent/dealer-log.ndjson", "claude_code", NOW_MS),
    null
  );
  assert.equal(
    recordClaudeCapacityFromEvents(parseNdjson(allowedFixture), "codex_local", NOW_MS),
    null
  );
  assert.equal(recordClaudeCapacityFromLog("/nonexistent/x.ndjson", "codex_local", NOW_MS), null);
  assert.equal(listCapacitySnapshots("claude_code").length, 0);
});

test("log-file ingestion persists the allowed fixture end to end", () => {
  const logPath = path.join(process.env.AGENT_DEALER_HOME!, "claude-unified.ndjson");
  fs.writeFileSync(logPath, allowedFixture);
  assert.equal(recordClaudeCapacityFromLog(logPath, "claude_code", NOW_MS), 3);
  const snap = getRuntimeCapacitySnapshot(NOW_MS);
  const claude = snap.runtimes.find((r) => r.runtime === "claude_code")!;
  assert.equal(claude.windows.length, 3);
  assert.ok(claude.windows.every((w) => w.unavailableReason === null));
});
