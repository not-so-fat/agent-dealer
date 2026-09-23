// packages/shared/src/runtime-capacity.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveWindowLabel,
  isTeamBillingKnown,
  isWindowKnown,
  remainingPercentFromFraction,
  remainingPercentFromUsedPercent,
  type CapacityWindowSnapshot,
  type CursorTeamBilling,
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
    criticalRole: null,
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

function teamBilling(over: Partial<CursorTeamBilling> = {}): CursorTeamBilling {
  const now = new Date().toISOString();
  return {
    configured: true,
    cycleStart: "2026-09-01T00:00:00.000Z",
    cycleEnd: null,
    spendValue: 1250,
    spendUnit: "cents",
    hardLimitValue: null,
    hardLimitUnit: null,
    memberCount: 2,
    memberLimitOverrideCount: 1,
    usagePeriodStart: null,
    usagePeriodEnd: null,
    usageSpendValue: null,
    usageSpendUnit: null,
    source: "supported_protocol",
    unavailableReason: null,
    observedAt: now,
    generatedAt: now,
    ...over,
  };
}

test("team billing is known only with values, source, and configuration", () => {
  assert.equal(isTeamBillingKnown(teamBilling()), true);
  assert.equal(isTeamBillingKnown(teamBilling({ configured: false })), false);
  assert.equal(
    isTeamBillingKnown(
      teamBilling({ source: "unavailable", unavailableReason: "missing" })
    ),
    false
  );
  assert.equal(
    isTeamBillingKnown(
      teamBilling({
        spendValue: null,
        hardLimitValue: null,
        usageSpendValue: null,
        unavailableReason: "missing",
      })
    ),
    false
  );
  // Usage-period spend alone still counts as known billing evidence.
  assert.equal(
    isTeamBillingKnown(
      teamBilling({
        spendValue: null,
        spendUnit: null,
        hardLimitValue: null,
        hardLimitUnit: null,
        usageSpendValue: 3.5,
        usageSpendUnit: "USD",
      })
    ),
    true
  );
  // Reported team size alone still counts as known billing evidence.
  assert.equal(
    isTeamBillingKnown(
      teamBilling({
        spendValue: null,
        spendUnit: null,
        memberLimitOverrideCount: null,
      })
    ),
    true
  );
});

test("a past reset time is never current capacity", () => {
  assert.equal(isWindowKnown(window()), true);
  assert.equal(
    isWindowKnown(window({ resetAt: new Date(Date.now() - 1000).toISOString() })),
    false
  );
  assert.equal(isWindowKnown(window({ resetAt: "not-a-date" })), false);
});

test("a window past its freshness horizon is not known (stale)", () => {
  const now = Date.now();
  assert.equal(
    isWindowKnown(
      window({
        observedAt: new Date(now - 30 * 60_000).toISOString(),
        freshUntil: new Date(now - 15 * 60_000).toISOString(),
        expiresAt: new Date(now + 30 * 60_000).toISOString(),
      }),
      now
    ),
    false
  );
  assert.equal(isWindowKnown(window({ freshUntil: "not-a-date" })), false);
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
