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
  detectUsageCapFromRawLog,
  detectUsageCapFromLog,
  extractUsageCapFromEvents,
  recordMuseUsageCap,
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

test("NOT-117: successful Cursor NDJSON with source text 'infra-attempt limit reached' does not detect or record availability", () => {
  const fixture = fs.readFileSync(
    path.join(fixtureDir, "fixtures/cursor-success-with-infra-attempt-limit-text.ndjson"),
    "utf8"
  );
  const cap = detectUsageCapFromRawLog(fixture, "cursor_local");
  assert.equal(cap, null);

  const logPath = path.join(process.env.AGENT_DEALER_HOME!, "cursor-false-positive.ndjson");
  fs.writeFileSync(logPath, fixture);
  assert.equal(detectUsageCapFromLog(logPath, "cursor_local"), null);
  assert.equal(runtimeAvailability("cursor_local").available, true);
});

test("NOT-117: Cursor billing_error and usage-limit result errors still detect", () => {
  const billing = fs.readFileSync(path.join(fixtureDir, "fixtures/cursor-billing-error.ndjson"), "utf8");
  const usage = fs.readFileSync(path.join(fixtureDir, "fixtures/cursor-result-usage-limit.ndjson"), "utf8");
  assert.ok(detectUsageCapFromRawLog(billing, "cursor_local"));
  assert.ok(detectUsageCapFromRawLog(usage, "cursor_local"));

  const rejected = [
    '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1784283600,"rateLimitType":"five_hour"}}',
  ].join("\n");
  assert.ok(detectUsageCapFromRawLog(rejected, "cursor_local"));
});

test("NOT-117: Cursor stderr trailer with usage limit still detects; bare 'limit reached' in stderr does not", () => {
  const withUsage =
    '{"type":"result","is_error":true,"result":"failed"}\n--- stderr ---\nError: usage limit reached for this account\n';
  assert.ok(detectUsageCapFromRawLog(withUsage, "cursor_local"));

  const bare =
    '{"type":"result","is_error":true,"result":"failed"}\n--- stderr ---\nError: infra-attempt limit reached\n';
  assert.equal(detectUsageCapFromRawLog(bare, "cursor_local"), null);
});

test("NOT-117: successful session ignores stderr usage-cap-like prose (structured path already empty)", () => {
  const raw =
    '{"type":"result","is_error":false,"result":"done"}\n--- stderr ---\nwarning: usage limit reached\n';
  assert.equal(detectUsageCapFromRawLog(raw, "cursor_local"), null);
});

test("NOT-117: successful Codex turn.completed skips text fallback even when stderr has usage-limit prose", () => {
  const raw = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"Done implementing."}}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}',
    "",
    "--- stderr ---",
    "npm warn: your usage limit reached for deprecated flag foo (unrelated to billing)",
  ].join("\n");
  assert.equal(detectUsageCapFromRawLog(raw, "codex_local"), null);

  const failed = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"turn.failed","error":{"message":"Rate limit exceeded"}}',
    "",
    "--- stderr ---",
    "noise",
  ].join("\n");
  assert.ok(detectUsageCapFromRawLog(failed, "codex_local"));
});

// NOT-181: Muse's cap comes from the parsed failure kind, with the fallback cooldown (no reset time).
test("recordMuseUsageCap records muse_code availability only for a usage_cap failure", () => {
  clearAllRuntimeAvailability();
  const now = Date.parse("2026-09-20T00:00:00.000Z");
  assert.equal(recordMuseUsageCap(null, now), null);
  assert.equal(recordMuseUsageCap({ kind: "auth", message: "login is no longer valid" }, now), null);
  assert.equal(runtimeAvailability("muse_code", now).available, true);

  const cap = recordMuseUsageCap({ kind: "usage_cap", message: "usage limit reached" }, now);
  assert.equal(cap?.unavailableUntil, new Date(now + 1_800_000).toISOString());
  const availability = runtimeAvailability("muse_code", now);
  assert.equal(availability.available, false);
  assert.equal(runtimeAvailability("claude_code", now).available, true);
  clearAllRuntimeAvailability();
});
