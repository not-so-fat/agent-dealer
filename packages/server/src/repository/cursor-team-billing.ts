// packages/server/src/repository/cursor-team-billing.ts
//
// NOT-249: durable normalized Cursor-team billing snapshot. Single-row table
// (`id = 1`): the Admin API reports one team billing state, not per-window
// readings. Independent of `runtime_availability` (NOT-111 connection health)
// and of `runtime_capacity_snapshots` (per-runtime quota windows) — nothing
// here reads or writes either table.
//
// Diagnostic evidence stays server-side: `evidence_ref` is a static pointer
// (endpoint path), never the Admin API key and never a raw provider payload.

import type {
  CapacitySource,
  CapacityUnavailableReason,
} from "@agent-dealer/shared";
import { getDb } from "../db/index.js";
import type { CursorTeamStoredSnapshot } from "../capacity/cursor-team.js";

interface CursorTeamBillingRow {
  id: number;
  cycle_start: string | null;
  cycle_end: string | null;
  spend_value: number | null;
  spend_unit: string | null;
  hard_limit_value: number | null;
  hard_limit_unit: string | null;
  usage_period_start: string | null;
  usage_period_end: string | null;
  usage_spend_value: number | null;
  usage_spend_unit: string | null;
  source: string;
  unavailable_reason: string | null;
  observed_at: string;
  fresh_until: string | null;
  expires_at: string | null;
  evidence_ref: string | null;
}

export type WriteCursorTeamBillingInput = CursorTeamStoredSnapshot;

function rowToSnapshot(row: CursorTeamBillingRow): CursorTeamStoredSnapshot {
  return {
    cycleStart: row.cycle_start,
    cycleEnd: row.cycle_end,
    spendValue: row.spend_value,
    spendUnit: row.spend_unit,
    hardLimitValue: row.hard_limit_value,
    hardLimitUnit: row.hard_limit_unit,
    usagePeriodStart: row.usage_period_start,
    usagePeriodEnd: row.usage_period_end,
    usageSpendValue: row.usage_spend_value,
    usageSpendUnit: row.usage_spend_unit,
    source: row.source as CapacitySource,
    unavailableReason: row.unavailable_reason as CapacityUnavailableReason | null,
    observedAt: row.observed_at,
    freshUntil: row.fresh_until,
    expiresAt: row.expires_at,
    evidenceRef: row.evidence_ref,
  };
}

/** Upsert the latest normalized team billing observation (single row). */
export function writeCursorTeamBillingRow(input: WriteCursorTeamBillingInput): void {
  getDb()
    .prepare(
      `
    INSERT INTO cursor_team_billing_snapshots (
      id, cycle_start, cycle_end, spend_value, spend_unit,
      hard_limit_value, hard_limit_unit, usage_period_start, usage_period_end,
      usage_spend_value, usage_spend_unit, source, unavailable_reason,
      observed_at, fresh_until, expires_at, evidence_ref
    )
    VALUES (
      1, @cycle_start, @cycle_end, @spend_value, @spend_unit,
      @hard_limit_value, @hard_limit_unit, @usage_period_start, @usage_period_end,
      @usage_spend_value, @usage_spend_unit, @source, @unavailable_reason,
      @observed_at, @fresh_until, @expires_at, @evidence_ref
    )
    ON CONFLICT(id) DO UPDATE SET
      cycle_start = excluded.cycle_start,
      cycle_end = excluded.cycle_end,
      spend_value = excluded.spend_value,
      spend_unit = excluded.spend_unit,
      hard_limit_value = excluded.hard_limit_value,
      hard_limit_unit = excluded.hard_limit_unit,
      usage_period_start = excluded.usage_period_start,
      usage_period_end = excluded.usage_period_end,
      usage_spend_value = excluded.usage_spend_value,
      usage_spend_unit = excluded.usage_spend_unit,
      source = excluded.source,
      unavailable_reason = excluded.unavailable_reason,
      observed_at = excluded.observed_at,
      fresh_until = excluded.fresh_until,
      expires_at = excluded.expires_at,
      evidence_ref = excluded.evidence_ref
  `
    )
    .run({
      cycle_start: input.cycleStart,
      cycle_end: input.cycleEnd,
      spend_value: input.spendValue,
      spend_unit: input.spendUnit,
      hard_limit_value: input.hardLimitValue,
      hard_limit_unit: input.hardLimitUnit,
      usage_period_start: input.usagePeriodStart,
      usage_period_end: input.usagePeriodEnd,
      usage_spend_value: input.usageSpendValue,
      usage_spend_unit: input.usageSpendUnit,
      source: input.source,
      unavailable_reason: input.unavailableReason,
      observed_at: input.observedAt,
      fresh_until: input.freshUntil,
      expires_at: input.expiresAt,
      evidence_ref: input.evidenceRef,
    });
}

/** The latest normalized team billing observation, if any. */
export function readCursorTeamBillingRow(): CursorTeamStoredSnapshot | null {
  const row = getDb()
    .prepare("SELECT * FROM cursor_team_billing_snapshots WHERE id = 1")
    .get() as CursorTeamBillingRow | undefined;
  return row ? rowToSnapshot(row) : null;
}

/** Test helper — clear the team billing snapshot (leaves all other tables alone). */
export function clearCursorTeamBilling(): void {
  getDb().exec("DELETE FROM cursor_team_billing_snapshots");
}
