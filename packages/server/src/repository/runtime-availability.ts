// packages/server/src/repository/runtime-availability.ts
//
// NOT-111: durable per-runtime (account-level) usage-cap state. Runners write when they
// observe a hard cap; coordinator and queue admission read via runtimeAvailability().

import type { Runtime, RuntimeAvailability } from "@agent-dealer/shared";
import { getDb } from "../db/index.js";

interface RuntimeAvailabilityRow {
  runtime: string;
  unavailable_until: string;
  reason: string;
  evidence_json: string | null;
  observed_at: string;
}

export interface RecordRuntimeAvailabilityInput {
  runtime: Runtime;
  unavailableUntil: string;
  reason: string;
  evidence?: unknown;
}

/** Upsert the latest cap observation for a runtime (one row per runtime). */
export function recordRuntimeAvailability(input: RecordRuntimeAvailabilityInput): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      INSERT INTO runtime_availability (runtime, unavailable_until, reason, evidence_json, observed_at)
      VALUES (@runtime, @unavailable_until, @reason, @evidence_json, @observed_at)
      ON CONFLICT(runtime) DO UPDATE SET
        unavailable_until = excluded.unavailable_until,
        reason = excluded.reason,
        evidence_json = excluded.evidence_json,
        observed_at = excluded.observed_at
    `
    )
    .run({
      runtime: input.runtime,
      unavailable_until: input.unavailableUntil,
      reason: input.reason,
      evidence_json: input.evidence !== undefined ? JSON.stringify(input.evidence) : null,
      observed_at: now,
    });
}

/** Clear a runtime row once its unavailable_until has passed (lazy cleanup on read). */
function clearExpired(runtime: Runtime, nowMs = Date.now()): void {
  getDb()
    .prepare("DELETE FROM runtime_availability WHERE runtime = ? AND unavailable_until <= ?")
    .run(runtime, new Date(nowMs).toISOString());
}

/**
 * Single read function for coordinator deferral and NOT-103 queue admission.
 * Returns `{ available: true }` when no active cap is recorded.
 */
export function runtimeAvailability(runtime: Runtime, nowMs = Date.now()): RuntimeAvailability {
  clearExpired(runtime, nowMs);
  const row = getDb()
    .prepare("SELECT * FROM runtime_availability WHERE runtime = ?")
    .get(runtime) as RuntimeAvailabilityRow | undefined;
  if (!row) return { available: true };
  const untilMs = Date.parse(row.unavailable_until);
  if (!Number.isFinite(untilMs) || untilMs <= nowMs) {
    getDb().prepare("DELETE FROM runtime_availability WHERE runtime = ?").run(runtime);
    return { available: true };
  }
  return { available: false, until: row.unavailable_until, reason: row.reason };
}

/** Test helper — wipe all cap rows. */
export function clearAllRuntimeAvailability(): void {
  getDb().exec("DELETE FROM runtime_availability");
}
