// packages/shared/src/runtime-capacity.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveWindowLabel,
  isWindowKnown,
  remainingPercentFromFraction,
  remainingPercentFromUsedPercent,
  type CapacityWindowSnapshot,
} from "./runtime-capacity.js";

function window(over: Partial<CapacityWindowSnapshot> = {}): CapacityWindowSnapshot {
  return {
    windowKey: "w",
    providerBucket: "all_models",
    durationMinutes: 10080,
    displayLabel: "1W",
    usedValue: 35,
    usedUnit: "percent",
    remainingPercent: 65,
    resetAt: new Date(Date.now() + 3600_000).toISOString(),
    observedAt: new Date(Date.now() - 60_000).toISOString(),
    freshUntil: new Date(Date.now() + 600_000).toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    source: "supported_protocol",
    unavailableReason: null,
    ...over,
  };
}

test("remaining percent is clamp(100 - used, 0, 100)", () => {
  assert.equal(remainingPercentFromUsedPercent(35), 65);
  assert.equal(remainingPercentFromUsedPercent(0), 100);
  assert.equal(remainingPercentFromUsedPercent(100), 0);
  assert.equal(remainingPercentFromUsedPercent(140), 0);
  assert.equal(remainingPercentFromUsedPercent(-20), 100);
});

test("fractions normalize to percent before the clamp", () => {
  assert.equal(remainingPercentFromFraction(0.35), 65);
  assert.equal(remainingPercentFromFraction(0), 100);
  assert.equal(remainingPercentFromFraction(1.4), 0);
  assert.equal(remainingPercentFromFraction(-0.5), 100);
});

test("familiar durations derive labels; unknown keeps the provider label", () => {
  assert.equal(deriveWindowLabel(300, "five_hour"), "5H");
  assert.equal(deriveWindowLabel(10080, "weekly"), "1W");
  assert.equal(deriveWindowLabel(43200, "monthly"), "1M");
  assert.equal(deriveWindowLabel(60, "hourly"), "1H");
  assert.equal(deriveWindowLabel(123, "qux_quota"), "qux_quota");
  assert.equal(deriveWindowLabel(null, "sesame_street"), "sesame_street");
  assert.equal(deriveWindowLabel(undefined, "plain"), "plain");
});

test("a past reset time is never current capacity", () => {
  assert.equal(isWindowKnown(window()), true);
  assert.equal(
    isWindowKnown(window({ resetAt: new Date(Date.now() - 1000).toISOString() })),
    false
  );
  assert.equal(isWindowKnown(window({ resetAt: "not-a-date" })), false);
});

test("expired snapshots and unavailable sources are not known", () => {
  assert.equal(
    isWindowKnown(window({ expiresAt: new Date(Date.now() - 1000).toISOString() })),
    false
  );
  assert.equal(
    isWindowKnown(window({ source: "unavailable", remainingPercent: null, unavailableReason: "missing" })),
    false
  );
  assert.equal(isWindowKnown(window({ remainingPercent: null, unavailableReason: "unparsable" })), false);
});
