// packages/server/src/repository/cursor-individual-billing.ts
//
// NOT-250: durable normalized Cursor-individual billing snapshot. Single-row
// table (`id = 1`): the experimental dashboard adapter reports one
// billing-cycle state, not per-window readings. Independent of
// `runtime_availability` (NOT-111 connection health) and written alongside
// (never instead of) `runtime_capacity_snapshots` — nothing here reads or
// writes either table.
//
// Credential hygiene: this table carries normalized billing values and a
// static evidence pointer only. The raw local-login token must never be
// written here — the adapter never passes it to this module, and tests scan
// stored rows for fixture secrets.

import type {
  CapacitySource,
  CapacityUnavailableReason,
} from "@agent-dealer/shared";
import { getDb } from "../db/index.js";
import type { CursorIndividualStoredSnapshot } from "../capacity/cursor-individual.js";

interface CursorIndividualBillingRow {
  id: number;
  cycle_label: string | null;
  cycle_start: string | null;
  cycle_end: string | null;
  usage_value: number | null;
  usage_unit: string | null;
  remaining_percent: number | null;
  source: string;
  unavailable_reason: string | null;
  observed_at: string;
  fresh_until: string | null;
  expires_at: string | null;
  evidence_ref: string | null;
}

export type WriteCursorIndividualBillingInput = CursorIndividualStoredSnapshot;

function rowToSnapshot(row: CursorIndividualBillingRow): CursorIndividualStoredSnapshot {
  return {
    cycleLabel: row.cycle_label,
    cycleStart: row.cycle_start,
    cycleEnd: row.cycle_end,
    usageValue: row.usage_value,
    usageUnit: row.usage_unit,
    remainingPercent: row.remaining_percent,
    source: row.source as CapacitySource,
    unavailableReason: row.unavailable_reason as CapacityUnavailableReason | null,
    observedAt: row.observed_at,
    freshUntil: row.fresh_until,
    expiresAt: row.expires_at,
    evidenceRef: row.evidence_ref,
  };
}

/** Upsert the latest normalized individual billing observation (single row). */
export function writeCursorIndividualBillingRow(input: WriteCursorIndividualBillingInput): void {
  getDb()
    .prepare(
      `
    INSERT INTO cursor_individual_billing_snapshots (
      id, cycle_label, cycle_start, cycle_end, usage_value, usage_unit,
      remaining_percent, source, unavailable_reason,
      observed_at, fresh_until, expires_at, evidence_ref
    )
    VALUES (
      1, @cycle_label, @cycle_start, @cycle_end, @usage_value, @usage_unit,
      @remaining_percent, @source, @unavailable_reason,
      @observed_at, @fresh_until, @expires_at, @evidence_ref
    )
    ON CONFLICT(id) DO UPDATE SET
      cycle_label = excluded.cycle_label,
      cycle_end = excluded.cycle_end,
      cycle_start = excluded.cycle_start,
      usage_value = excluded.usage_value,
      usage_unit = excluded.usage_unit,
      remaining_percent = excluded.remaining_percent,
      source = excluded.source,
      unavailable_reason = excluded.unavailable_reason,
      observed_at = excluded.observed_at,
      fresh_until = excluded.fresh_until,
      expires_at = excluded.expires_at,
      evidence_ref = excluded.evidence_ref
  `
    )
    .run({
      cycle_label: input.cycleLabel,
      cycle_start: input.cycleStart,
      cycle_end: input.cycleEnd,
      usage_value: input.usageValue,
      usage_unit: input.usageUnit,
      remaining_percent: input.remainingPercent,
      source: input.source,
      unavailable_reason: input.unavailableReason,
      observed_at: input.observedAt,
      fresh_until: input.freshUntil,
      expires_at: input.expiresAt,
      evidence_ref: input.evidenceRef,
    });
}

/** The latest normalized individual billing observation, if any. */
export function readCursorIndividualBillingRow(): CursorIndividualStoredSnapshot | null {
  const row = getDb()
    .prepare("SELECT * FROM cursor_individual_billing_snapshots WHERE id = 1")
    .get() as CursorIndividualBillingRow | undefined;
  return row ? rowToSnapshot(row) : null;
}

/** Test helper — clear the individual billing snapshot (leaves all other tables alone). */
export function clearCursorIndividualBilling(): void {
  getDb().exec("DELETE FROM cursor_individual_billing_snapshots");
}
