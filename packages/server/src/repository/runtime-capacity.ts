// packages/server/src/repository/runtime-capacity.ts
//
// NOT-245: durable account-level capacity snapshots. One row per
// (runtime, window_key) — a provider may report several independently resetting
// windows for one runtime account, and several Agent profiles may share that
// account. This table is independent of `runtime_availability`: the hard-cap
// rows there keep their exact behavior (see runtime-availability.ts) and
// nothing here reads or writes them.
//
// Diagnostic evidence stays server-side: `evidence_ref` is a pointer
// (log path, probe id), never credentials and never a raw provider payload.

import type {
  CapacityCriticalRole,
  CapacitySource,
  CapacityUnavailableReason,
  CapacityWindowSnapshot,
  Runtime,
} from "@agent-dealer/shared";
import { getDb } from "../db/index.js";

interface CapacitySnapshotRow {
  runtime: string;
  window_key: string;
  provider_bucket: string;
  duration_minutes: number | null;
  display_label: string;
  used_value: number | null;
  used_unit: string | null;
  remaining_percent: number | null;
  reset_at: string | null;
  observed_at: string;
  fresh_until: string | null;
  expires_at: string | null;
  source: string;
  unavailable_reason: string | null;
  evidence_ref: string | null;
  critical_role: string | null;
}

export interface RecordCapacityWindowInput {
  windowKey: string;
  providerBucket: string;
  durationMinutes?: number | null;
  displayLabel: string;
  usedValue?: number | null;
  usedUnit?: string | null;
  remainingPercent?: number | null;
  resetAt?: string | null;
  observedAt: string;
  freshUntil?: string | null;
  expiresAt?: string | null;
  source: CapacitySource;
  unavailableReason?: CapacityUnavailableReason | null;
  /** Server-side pointer only — never credentials or raw payloads. */
  evidenceRef?: string | null;
  criticalRole?: CapacityCriticalRole | null;
}

function rowToSnapshot(row: CapacitySnapshotRow): CapacityWindowSnapshot {
  return {
    windowKey: row.window_key,
    providerBucket: row.provider_bucket,
    durationMinutes: row.duration_minutes,
    displayLabel: row.display_label,
    usedValue: row.used_value,
    usedUnit: row.used_unit,
    remainingPercent: row.remaining_percent,
    resetAt: row.reset_at,
    observedAt: row.observed_at,
    freshUntil: row.fresh_until,
    expiresAt: row.expires_at,
    source: row.source as CapacitySource,
    unavailableReason: row.unavailable_reason as CapacityUnavailableReason | null,
    criticalRole: row.critical_role as CapacityCriticalRole | null,
  };
}

/**
 * Upsert the latest observed windows for one runtime account. Windows not in
 * this write are left untouched — providers report partial windows and a
 * missing window in one observation must not delete a still-valid sibling.
 */
export function recordCapacitySnapshots(runtime: Runtime, windows: RecordCapacityWindowInput[]): void {
  const stmt = getDb().prepare(`
    INSERT INTO runtime_capacity_snapshots (
      runtime, window_key, provider_bucket, duration_minutes, display_label,
      used_value, used_unit, remaining_percent, reset_at, observed_at,
      fresh_until, expires_at, source, unavailable_reason, evidence_ref,
      critical_role
    )
    VALUES (
      @runtime, @window_key, @provider_bucket, @duration_minutes, @display_label,
      @used_value, @used_unit, @remaining_percent, @reset_at, @observed_at,
      @fresh_until, @expires_at, @source, @unavailable_reason, @evidence_ref,
      @critical_role
    )
    ON CONFLICT(runtime, window_key) DO UPDATE SET
      provider_bucket = excluded.provider_bucket,
      duration_minutes = excluded.duration_minutes,
      display_label = excluded.display_label,
      used_value = excluded.used_value,
      used_unit = excluded.used_unit,
      remaining_percent = excluded.remaining_percent,
      reset_at = excluded.reset_at,
      observed_at = excluded.observed_at,
      fresh_until = excluded.fresh_until,
      expires_at = excluded.expires_at,
      source = excluded.source,
      unavailable_reason = excluded.unavailable_reason,
      evidence_ref = excluded.evidence_ref,
      critical_role = excluded.critical_role
  `);
  const run = getDb().transaction((rows: RecordCapacityWindowInput[]) => {
    for (const w of rows) {
      stmt.run({
        runtime,
        window_key: w.windowKey,
        provider_bucket: w.providerBucket,
        duration_minutes: w.durationMinutes ?? null,
        display_label: w.displayLabel,
        used_value: w.usedValue ?? null,
        used_unit: w.usedUnit ?? null,
        remaining_percent: w.remainingPercent ?? null,
        reset_at: w.resetAt ?? null,
        observed_at: w.observedAt,
        fresh_until: w.freshUntil ?? null,
        expires_at: w.expiresAt ?? null,
        source: w.source,
        unavailable_reason: w.unavailableReason ?? null,
        evidence_ref: w.evidenceRef ?? null,
        critical_role: w.criticalRole ?? null,
      });
    }
  });
  run(windows);
}

/**
 * Delete stored windows for one runtime account. Providers report partial
 * windows and a missing window in one observation must not delete a sibling —
 * so deletes are always explicit: callers name the keys that are stale by
 * construction (e.g. a failure sentinel superseded by a successful read).
 */
export function deleteCapacitySnapshots(runtime: Runtime, windowKeys: string[]): void {
  if (windowKeys.length === 0) return;
  const stmt = getDb().prepare(
    "DELETE FROM runtime_capacity_snapshots WHERE runtime = ? AND window_key = ?"
  );
  const run = getDb().transaction((keys: string[]) => {
    for (const key of keys) stmt.run(runtime, key);
  });
  run(windowKeys);
}

/** All stored windows for one runtime account, ordered by window key. */
export function listCapacitySnapshots(runtime: Runtime): CapacityWindowSnapshot[] {
  const rows = getDb()
    .prepare("SELECT * FROM runtime_capacity_snapshots WHERE runtime = ? ORDER BY window_key")
    .all(runtime) as CapacitySnapshotRow[];
  return rows.map(rowToSnapshot);
}

/** Every stored window across runtimes (service layer groups by runtime). */
export function listAllCapacitySnapshots(): Array<{ runtime: Runtime } & CapacityWindowSnapshot> {
  const rows = getDb()
    .prepare("SELECT * FROM runtime_capacity_snapshots ORDER BY runtime, window_key")
    .all() as CapacitySnapshotRow[];
  return rows.map((row) => ({ runtime: row.runtime as Runtime, ...rowToSnapshot(row) }));
}

/** Distinct runtimes that have at least one stored snapshot. */
export function capacityRuntimes(): Runtime[] {
  const rows = getDb()
    .prepare("SELECT DISTINCT runtime FROM runtime_capacity_snapshots ORDER BY runtime")
    .all() as Array<{ runtime: string }>;
  return rows.map((r) => r.runtime as Runtime);
}

/** Test helper — wipe all capacity snapshot rows (leaves runtime_availability alone). */
export function clearAllCapacitySnapshots(): void {
  getDb().exec("DELETE FROM runtime_capacity_snapshots");
}
