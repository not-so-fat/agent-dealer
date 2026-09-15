import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-cap-home-"));
process.env.USAGE_CAP_FALLBACK_COOLDOWN_MS = "1800000";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const claudeFixture = fs.readFileSync(
  path.join(fixtureDir, "fixtures/claude-rate-limit-rejected.ndjson"),
  "utf8"
);

const { migrate } = await import("../db/index.js");
const {
  recordUsageCapFromEvents,
  detectUsageCapFromNdjson,
  extractUsageCapFromEvents,
} = await import("./usage-cap.js");
const { parseNdjson } = await import("./stream-json.js");
const {
  runtimeAvailability,
  clearAllRuntimeAvailability,
} = await import("../repository/runtime-availability.js");

before(() => migrate());
beforeEach(() => clearAllRuntimeAvailability());

test("Claude rate_limit_event rejected writes runtime_availability with resetsAt", () => {
  const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const events = parseNdjson(claudeFixture);
  const cap = recordUsageCapFromEvents(events, "claude_code", nowMs);
  assert.ok(cap);
  assert.equal(cap!.unavailableUntil, new Date(1784283600 * 1000).toISOString());

  const avail = runtimeAvailability("claude_code", nowMs);
  assert.equal(avail.available, false);
  if (!avail.available) {
    assert.equal(avail.until, cap!.unavailableUntil);
  }
});

test("allowed_warning rate_limit_event is ignored (hard cap only)", () => {
  const raw = [
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1784283600,"rateLimitType":"five_hour"}}',
  ].join("\n");
  const cap = detectUsageCapFromNdjson(raw, "claude_code");
  assert.equal(cap, null);
});

test("missing reset time uses fallback cooldown", () => {
  const nowMs = Date.parse("2026-06-01T12:00:00.000Z");
  const raw =
    '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour","overageStatus":"rejected"}}';
  const cap = detectUsageCapFromNdjson(raw, "claude_code", nowMs);
  assert.ok(cap);
  assert.equal(cap!.unavailableUntil, new Date(nowMs + 1_800_000).toISOString());
});

test("result error without prior event uses fallback cooldown", () => {
  const nowMs = Date.parse("2026-06-01T12:00:00.000Z");
  const events = parseNdjson(
    '{"type":"result","is_error":true,"result":"Rate limit exceeded for this account."}'
  );
  const cap = extractUsageCapFromEvents(events, "claude_code", nowMs);
  assert.ok(cap);
  assert.equal(cap!.unavailableUntil, new Date(nowMs + 1_800_000).toISOString());
});
