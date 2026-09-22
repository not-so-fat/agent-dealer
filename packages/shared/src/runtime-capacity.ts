// packages/shared/src/runtime-capacity.ts
//
// NOT-245: provider-neutral runtime capacity contract. Capacity belongs to an
// authenticated runtime account, not an Agent profile: every configured runtime
// gets one entry, no matter how many Agent profiles share it.
//
// A provider reports whatever reset windows it actually has — this contract
// never forces providers into fixed 5H/1W/1M columns. Familiar labels are
// derived from duration only when defensible (see deriveWindowLabel); anything
// else keeps the provider's own display label.

import { z } from "zod";
import { Runtime } from "./runtime.js";

/** Where a capacity number came from. `unavailable` means no reading exists. */
export const CapacitySource = z.enum([
  "supported_protocol",
  "observed_event",
  "experimental_api",
  "unavailable",
]);
export type CapacitySource = z.infer<typeof CapacitySource>;

/**
 * Machine-readable reason a window (or a whole runtime entry) renders `N/A`.
 * - `unsupported`: the runtime/provider has no capacity surface at all.
 * - `missing`: supported, but no snapshot has been recorded yet.
 * - `expired`: a snapshot existed but its expiry passed (or its reset time is
 *   in the past — a past reset is never presented as current capacity).
 * - `stale`: past the freshness horizon but not yet expired; shown as N/A
 *   rather than a number the operator cannot trust.
 * - `unparsable`: a provider payload arrived but could not be normalized.
 */
export const CapacityUnavailableReason = z.enum([
  "unsupported",
  "missing",
  "expired",
  "unparsable",
  "stale",
]);
export type CapacityUnavailableReason = z.infer<typeof CapacityUnavailableReason>;

export const CapacityWindowSnapshot = z.object({
  /** Stable per-runtime key for this window (e.g. `weekly_all_models`). */
  windowKey: z.string().min(1),
  /** Provider bucket identifier (e.g. `all_models`, `sonnet_only`). */
  providerBucket: z.string().min(1),
  /** Window length in minutes when the provider reports one; null otherwise. */
  durationMinutes: z.number().int().positive().nullable(),
  /** Label rendered in the UI — derived from duration or the provider label. */
  displayLabel: z.string().min(1),
  /** Raw provider used value/unit as reported (never normalized away). */
  usedValue: z.number().nullable(),
  usedUnit: z.string().nullable(),
  /** Normalized remaining percent 0–100 when derivable; null renders N/A. */
  remainingPercent: z.number().min(0).max(100).nullable(),
  /** Provider-reported reset time; null when the provider gives none. */
  resetAt: z.string().nullable(),
  /** When this snapshot was observed (ISO-8601). */
  observedAt: z.string(),
  /** Freshness horizon: after this the window reads stale (ISO-8601, nullable). */
  freshUntil: z.string().nullable(),
  /** Hard expiry: after this the window reads expired (ISO-8601, nullable). */
  expiresAt: z.string().nullable(),
  source: CapacitySource,
  unavailableReason: CapacityUnavailableReason.nullable(),
});
export type CapacityWindowSnapshot = z.infer<typeof CapacityWindowSnapshot>;

export const RuntimeCapacityEntry = z.object({
  runtime: Runtime,
  /** All windows the provider reports for this runtime account. */
  windows: z.array(CapacityWindowSnapshot),
  /** Whole-entry fallback reason when no window carries a current value. */
  unavailableReason: CapacityUnavailableReason.nullable(),
});
export type RuntimeCapacityEntry = z.infer<typeof RuntimeCapacityEntry>;

export const RuntimeCapacityResponse = z.object({
  runtimes: z.array(RuntimeCapacityEntry),
  generatedAt: z.string(),
});
export type RuntimeCapacityResponse = z.infer<typeof RuntimeCapacityResponse>;

/** Remaining percent from a 0–100 used percent: `clamp(100 - used, 0, 100)`. */
export function remainingPercentFromUsedPercent(usedPercent: number): number {
  if (!Number.isFinite(usedPercent)) return 0;
  return Math.min(100, Math.max(0, 100 - usedPercent));
}

/**
 * Remaining percent from a provider fraction (0–1 scale). Fractions are
 * normalized to percent *before* the clamp calculation, so 0.35 used →
 * 65 remaining, and an out-of-range 1.4 used clamps to 0, not -40.
 */
export function remainingPercentFromFraction(usedFraction: number): number {
  if (!Number.isFinite(usedFraction)) return 0;
  return remainingPercentFromUsedPercent(usedFraction * 100);
}

/**
 * Derive a familiar label from a window duration when defensible:
 * 300 min → `5H`, 168 h / 10,080 min → `1W`, ~30 d → `1M`. Anything else —
 * or a missing duration — keeps the provider label rather than being guessed.
 */
export function deriveWindowLabel(
  durationMinutes: number | null | undefined,
  providerLabel: string
): string {
  if (typeof durationMinutes === "number" && Number.isFinite(durationMinutes) && durationMinutes > 0) {
    if (durationMinutes === 300) return "5H";
    if (durationMinutes === 10080) return "1W";
    if (durationMinutes >= 40320 && durationMinutes <= 44640) return "1M";
    if (durationMinutes % 60 === 0) {
      const hours = durationMinutes / 60;
      if (hours < 24) return `${hours}H`;
      if (hours % 24 === 0) {
        const days = hours / 24;
        if (days < 30) return `${days}D`;
      }
    }
  }
  return providerLabel;
}

/**
 * NOT-249: team-level billing usage from Cursor's official Admin API
 * (https://docs.cursor.com/en/account/teams/admin-api). This is billing data
 * for the whole team — NOT per-runtime quota — so it lives outside
 * RuntimeCapacityEntry: cycle/spend/limit values keep the real units and
 * source the API reported, and are never rendered as token percentages or
 * 5H/1W windows. N/A reasons reuse CapacityUnavailableReason.
 */
export const CursorTeamBilling = z.object({
  /** True only when an Admin API key is configured server-side. */
  configured: z.boolean(),
  /** Subscription-cycle start/end exactly as reported (ISO-8601, nullable). */
  cycleStart: z.string().nullable(),
  cycleEnd: z.string().nullable(),
  /** Team spend in its reported unit (never converted, never a percent). */
  spendValue: z.number().nullable(),
  spendUnit: z.string().nullable(),
  /** Spend hard limit in its reported unit (never a token percentage). */
  hardLimitValue: z.number().nullable(),
  hardLimitUnit: z.string().nullable(),
  /** Trailing usage window actually queried (ISO-8601, nullable). */
  usagePeriodStart: z.string().nullable(),
  usagePeriodEnd: z.string().nullable(),
  /** Summed usage-period spend, only when every row reports one currency. */
  usageSpendValue: z.number().nullable(),
  usageSpendUnit: z.string().nullable(),
  source: CapacitySource,
  unavailableReason: CapacityUnavailableReason.nullable(),
  /** When the backing Admin API read was observed (ISO-8601, nullable). */
  observedAt: z.string().nullable(),
  generatedAt: z.string(),
});
export type CursorTeamBilling = z.infer<typeof CursorTeamBilling>;

/** True when the billing snapshot carries current, renderable values. */
export function isTeamBillingKnown(b: CursorTeamBilling, nowMs = Date.now()): boolean {
  if (!b.configured) return false;
  if (b.source === "unavailable" || b.unavailableReason !== null) return false;
  if (
    b.spendValue === null &&
    b.hardLimitValue === null &&
    b.usageSpendValue === null
  ) {
    return false;
  }
  if (b.observedAt) {
    const obsMs = Date.parse(b.observedAt);
    if (!Number.isFinite(obsMs) || obsMs > nowMs + 60_000) return false;
  }
  return true;
}

/** True when the window carries a current, renderable remaining value. */
export function isWindowKnown(w: CapacityWindowSnapshot, nowMs = Date.now()): boolean {
  if (w.remainingPercent === null) return false;
  if (w.source === "unavailable" || w.unavailableReason !== null) return false;
  if (w.resetAt !== null) {
    const resetMs = Date.parse(w.resetAt);
    if (!Number.isFinite(resetMs) || resetMs <= nowMs) return false;
  }
  if (w.freshUntil !== null) {
    const freshMs = Date.parse(w.freshUntil);
    if (!Number.isFinite(freshMs) || freshMs <= nowMs) return false;
  }
  if (w.expiresAt !== null) {
    const expMs = Date.parse(w.expiresAt);
    if (!Number.isFinite(expMs) || expMs <= nowMs) return false;
  }
  if (w.observedAt) {
    const obsMs = Date.parse(w.observedAt);
    if (!Number.isFinite(obsMs) || obsMs > nowMs + 60_000) return false;
  }
  return true;
}
