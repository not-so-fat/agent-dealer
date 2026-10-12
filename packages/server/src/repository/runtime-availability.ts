// packages/server/src/repository/runtime-availability.ts
//
// NOT-111: durable per-runtime (account-level) usage-cap state. Runners write when they
// observe a hard cap; coordinator and queue admission read via runtimeAvailability().
// NOT-440: the capacity read model reads the same row via activeRuntimeCap().

import type { Runtime, RuntimeAvailability } from "@agent-dealer/shared";
import { getDb } from "../db/index.js";

interface RuntimeAvailabilityRow {
  runtime: string;
  unavailable_until: string;
  reason: string;
  evidence_json: string | null;
  observed_at: string;
  provider_reset_at: string | null;
  limit_type: string | null;
}

export interface RecordRuntimeAvailabilityInput {
  runtime: Runtime;
  unavailableUntil: string;
  reason: string;
  evidence?: unknown;
  /** Provider-reported reset; null/absent when `unavailableUntil` is the fallback cooldown. */
  providerResetAt?: string | null;
  /** Structured provider limit type (e.g. Claude `rateLimitType`); never parsed from prose. */
  limitType?: string | null;
}

export interface ActiveRuntimeCap {
  unavailableUntil: string;
  reason: string;
  providerResetAt: string | null;
  limitType: string | null;
}

/** Upsert the latest cap observation for a runtime (one row per runtime). */
export function recordRuntimeAvailability(input: RecordRuntimeAvailabilityInput): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      INSERT INTO runtime_availability
        (runtime, unavailable_until, reason, evidence_json, observed_at, provider_reset_at, limit_type)
      VALUES (@runtime, @unavailable_until, @reason, @evidence_json, @observed_at, @provider_reset_at, @limit_type)
      ON CONFLICT(runtime) DO UPDATE SET
        unavailable_until = excluded.unavailable_until,
        reason = excluded.reason,
        evidence_json = excluded.evidence_json,
        observed_at = excluded.observed_at,
        provider_reset_at = excluded.provider_reset_at,
        limit_type = excluded.limit_type
    `
    )
    .run({
      runtime: input.runtime,
      unavailable_until: input.unavailableUntil,
      reason: input.reason,
      evidence_json: input.evidence !== undefined ? JSON.stringify(input.evidence) : null,
      observed_at: now,
      provider_reset_at: input.providerResetAt ?? null,
      limit_type: input.limitType ?? null,
    });
}

/** Clear a runtime row once its unavailable_until has passed (lazy cleanup on read). */
function clearExpired(runtime: Runtime, nowMs = Date.now()): void {
  getDb()
    .prepare("DELETE FROM runtime_availability WHERE runtime = ? AND unavailable_until <= ?")
    .run(runtime, new Date(nowMs).toISOString());
}

/** The active cap row for a runtime, or null once it has expired (lazily cleared). */
export function activeRuntimeCap(runtime: Runtime, nowMs = Date.now()): ActiveRuntimeCap | null {
  clearExpired(runtime, nowMs);
  const row = getDb()
    .prepare("SELECT * FROM runtime_availability WHERE runtime = ?")
    .get(runtime) as RuntimeAvailabilityRow | undefined;
  if (!row) return null;
  const untilMs = Date.parse(row.unavailable_until);
  if (!Number.isFinite(untilMs) || untilMs <= nowMs) {
    getDb().prepare("DELETE FROM runtime_availability WHERE runtime = ?").run(runtime);
    return null;
  }
  return {
    unavailableUntil: row.unavailable_until,
    reason: row.reason,
    providerResetAt: row.provider_reset_at,
    limitType: row.limit_type,
  };
}

/**
 * Single read function for coordinator deferral and NOT-103 queue admission.
 * Returns `{ available: true }` when no active cap is recorded.
 */
export function runtimeAvailability(runtime: Runtime, nowMs = Date.now()): RuntimeAvailability {
  const cap = activeRuntimeCap(runtime, nowMs);
  if (!cap) return { available: true };
  return { available: false, until: cap.unavailableUntil, reason: cap.reason };
}

/** Test helper — wipe all cap rows. */
export function clearAllRuntimeAvailability(): void {
  getDb().exec("DELETE FROM runtime_availability");
}
