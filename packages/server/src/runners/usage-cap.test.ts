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
  recordUsageCapFromLog,
  detectUsageCapFromNdjson,
  detectUsageCapFromRawLog,
  detectUsageCapFromLog,
  extractUsageCapFromEvents,
  extractUsageCapReset,
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

test("allowed rate_limit_event with overage rejected (org disabled overage) is not a cap", () => {
  const raw = [
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1784283600,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled_until","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.17,"resetsAt":1784283600}}}}',
    '{"type":"result","is_error":false,"result":"done"}',
  ].join("\n");
  assert.equal(detectUsageCapFromNdjson(raw, "claude_code"), null);
  assert.equal(recordUsageCapFromEvents(parseNdjson(raw), "claude_code"), null);
  assert.equal(runtimeAvailability("claude_code").available, true);
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

// ---------------------------------------------------------------------------
// NOT-439: every hard-cap path preserves the provider's future reset instead
// of the 30-minute fallback. Incident fixture: `2026-10-12T18:59:01Z` must
// persist exactly as `2026-10-12T18:59:01.000Z` on every path.
// ---------------------------------------------------------------------------

const NOT439_NOW = Date.parse("2026-10-12T18:16:20.154Z");
const NOT439_RESET = "2026-10-12T18:59:01.000Z";

test("NOT-439: Claude/Cursor result error text with a provider reset persists the exact boundary", () => {
  const raw =
    '{"type":"result","is_error":true,"result":"Rate limit exceeded for this account. Your usage window resets at 2026-10-12T18:59:01Z."}';
  const cap = recordUsageCapFromEvents(parseNdjson(raw), "claude_code", NOT439_NOW);
  assert.ok(cap);
  assert.equal(cap!.unavailableUntil, NOT439_RESET);

  const avail = runtimeAvailability("claude_code", NOT439_NOW);
  assert.equal(avail.available, false);
  if (!avail.available) assert.equal(avail.until, NOT439_RESET);
});

test("NOT-439: Codex turn.failed and error.message with a provider reset persist the exact boundary", () => {
  const failed = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"turn.failed","error":{"message":"Rate limit exceeded. Your usage window resets at 2026-10-12T18:59:01Z."}}',
  ].join("\n");
  const fromFailed = detectUsageCapFromRawLog(failed, "codex_local", NOT439_NOW);
  assert.ok(fromFailed);
  assert.equal(fromFailed!.unavailableUntil, NOT439_RESET);

  const errEvent = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"error","message":"Usage limit reached. Your usage window resets at 2026-10-12T18:59:01Z."}',
  ].join("\n");
  const fromError = detectUsageCapFromRawLog(errEvent, "codex_local", NOT439_NOW);
  assert.ok(fromError);
  assert.equal(fromError!.unavailableUntil, NOT439_RESET);
});

test("NOT-439: guarded Cursor stderr fallback with a provider reset persists the exact boundary", () => {
  const raw =
    '{"type":"result","is_error":true,"result":"failed"}\n--- stderr ---\nError: usage limit reached for this account; resets at 2026-10-12T18:59:01Z\n';
  const detected = detectUsageCapFromRawLog(raw, "cursor_local", NOT439_NOW);
  assert.ok(detected);
  assert.equal(detected!.unavailableUntil, NOT439_RESET);

  const logPath = path.join(process.env.AGENT_DEALER_HOME!, "cursor-cap-reset.ndjson");
  fs.writeFileSync(logPath, raw);
  const cap = recordUsageCapFromLog(logPath, "cursor_local", NOT439_NOW);
  assert.ok(cap);
  assert.equal(cap!.unavailableUntil, NOT439_RESET);
  const avail = runtimeAvailability("cursor_local", NOT439_NOW);
  assert.equal(avail.available, false);
  if (!avail.available) assert.equal(avail.until, NOT439_RESET);
});

test("NOT-439: Muse usage-cap failure with the incident reset persists the exact boundary", () => {
  const cap = recordMuseUsageCap(
    {
      kind: "usage_cap",
      message: "Subscription quota exhausted. Your usage window resets at 2026-10-12T18:59:01Z",
    },
    NOT439_NOW
  );
  assert.ok(cap);
  assert.equal(cap!.unavailableUntil, NOT439_RESET);

  const avail = runtimeAvailability("muse_code", NOT439_NOW);
  assert.equal(avail.available, false);
  if (!avail.available) assert.equal(avail.until, NOT439_RESET);
});

test("NOT-439: structured numeric resets accept seconds and milliseconds", () => {
  const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const expected = new Date(1784283600 * 1000).toISOString();
  assert.equal(extractUsageCapReset({ resets: [1784283600] }, nowMs), expected);
  assert.equal(extractUsageCapReset({ resets: [1784283600 * 1000] }, nowMs), expected);
  // Structured wins over text when both are present.
  assert.equal(
    extractUsageCapReset({ resets: [1784283600], text: "resets at 2026-10-12T18:59:01Z" }, nowMs),
    expected
  );
});

test("NOT-439: past, malformed, or unrelated timestamps fall back and never create a cap", () => {
  const nowMs = Date.parse("2026-10-12T18:16:20.154Z");
  const fallback = new Date(nowMs + 1_800_000).toISOString();

  // Past structured reset and past text timestamp → fallback.
  assert.equal(extractUsageCapReset({ resets: [Date.parse("2020-01-01T00:00:00.000Z") / 1000] }, nowMs), null);
  assert.equal(extractUsageCapReset({ text: "Rate limit exceeded, reset at 2020-01-01T00:00:00Z" }, nowMs), null);

  // Malformed / non-ISO timestamps are ignored.
  assert.equal(extractUsageCapReset({ text: "Rate limit exceeded, reset at 2026-13-99T99:99:99Z" }, nowMs), null);
  assert.equal(extractUsageCapReset({ text: "Rate limit exceeded, reset soon (tomorrow at noon)" }, nowMs), null);
  assert.equal(extractUsageCapReset({ resets: ["2026-10-12T18:59:01Z", NaN, Infinity] }, nowMs), null);

  // A bare future timestamp with no cap signal is not a cap by itself.
  const timestampOnly =
    '{"type":"result","is_error":true,"result":"Completed at 2026-10-12T18:59:01Z without errors."}';
  assert.equal(detectUsageCapFromNdjson(timestampOnly, "claude_code", nowMs), null);
  assert.equal(runtimeAvailability("claude_code", nowMs).available, true);

  // An unrelated future stamp inside accepted cap text is not a reset.
  const unrelatedStamp =
    '{"type":"result","is_error":true,"result":"[2026-10-12T19:30:00Z] Rate limit exceeded for this account."}';
  const unrelatedCap = detectUsageCapFromNdjson(unrelatedStamp, "claude_code", nowMs);
  assert.ok(unrelatedCap);
  assert.equal(unrelatedCap!.unavailableUntil, fallback);

  // A cap signal whose reset is in the past still detects, but uses the fallback.
  const pastReset =
    '{"type":"result","is_error":true,"result":"Rate limit exceeded. Your usage window resets at 2020-01-01T00:00:00Z."}';
  const cap = detectUsageCapFromNdjson(pastReset, "claude_code", nowMs);
  assert.ok(cap);
  assert.equal(cap!.unavailableUntil, fallback);
});

// NOT-181: Muse's cap comes from the parsed failure kind; NOT-439: a provider reset in the
// message is preserved, otherwise the fallback cooldown applies.
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
