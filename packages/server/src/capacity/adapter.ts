// packages/server/src/capacity/adapter.ts
//
// NOT-245: capacity adapter interface and deterministic fixtures.
//
// A capacity adapter translates one provider's capacity surface into raw
// window readings; the service layer (service.ts) normalizes them into the
// shared snapshot contract and persists them. Provider-specific live reads
// (auth, subprocess protocol) land in sibling tickets — this ticket ships the
// interface, the normalization, and deterministic fixtures that stand in for
// those providers in tests and the UI's complete-state coverage.
//
// Freshness rules (also documented in docs/RUNTIME_CAPACITY.md):
// - `observedAt` is the moment the provider reading was taken.
// - `staleAfterMs` (default 15 min): past `observedAt + staleAfterMs` the
//   window reads `stale` — shown as N/A, never as a number.
// - `expiresAfterMs` (default 60 min): past `observedAt + expiresAfterMs` the
//   window reads `expired`.
// - A `resetAt` in the past always reads `expired`, even inside the TTLs: a
//   past reset is never presented as current capacity.

import type {
  CapacityCriticalRole,
  CapacitySource,
  CapacityUnavailableReason,
  Runtime,
} from "@agent-dealer/shared";
import {
  deriveWindowLabel,
  remainingPercentFromFraction,
  remainingPercentFromUsedPercent,
} from "@agent-dealer/shared";

export const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;
export const DEFAULT_EXPIRES_AFTER_MS = 60 * 60 * 1000;

/** One raw window reading from a provider, before normalization. */
export interface AdapterWindowReading {
  /** Stable per-runtime key, e.g. `weekly_all_models`. */
  windowKey: string;
  /** Provider bucket identifier, e.g. `all_models`. */
  providerBucket: string;
  /** Window length in minutes when the provider reports one. */
  durationMinutes?: number | null;
  /** The provider's own display label (kept when no duration label applies). */
  providerLabel: string;
  /** Raw used value/unit exactly as reported. */
  usedValue?: number | null;
  usedUnit?: string | null;
  /** Used amount on a 0–100 scale (preferred when the provider gives it). */
  usedPercent?: number | null;
  /** Used amount on a 0–1 scale (normalized to percent before calculation). */
  usedFraction?: number | null;
  /** Provider-reported reset time (ISO-8601). */
  resetAt?: string | null;
  /** When the reading was taken (defaults to normalize time). */
  observedAt?: string;
  staleAfterMs?: number | null;
  expiresAfterMs?: number | null;
  source: Exclude<CapacitySource, "unavailable">;
  /** Server-side evidence pointer only — never credentials or raw payloads. */
  evidenceRef?: string | null;
  /** Set by the adapter when this reading IS the account-wide 5H/1W window
   * (never re-derived downstream from the key/label/duration). Omitted or
   * null for every non-critical window. */
  criticalRole?: CapacityCriticalRole | null;
}

/** A raw provider failure that normalizes to an unavailable window. */
export interface AdapterUnavailableReading {
  windowKey: string;
  providerBucket: string;
  providerLabel: string;
  durationMinutes?: number | null;
  reason: CapacityUnavailableReason;
  observedAt?: string;
}

/** What one provider read returns: known windows plus unavailable ones. */
export interface AdapterReadResult {
  runtime: Runtime;
  windows: AdapterWindowReading[];
  unavailable: AdapterUnavailableReading[];
}

/** Provider adapter: one implementation per runtime account source. */
export interface CapacityAdapter {
  runtime: Runtime;
  source: Exclude<CapacitySource, "unavailable">;
  read(nowMs?: number): AdapterReadResult | Promise<AdapterReadResult>;
}

export interface NormalizedWindowInput {
  runtime: Runtime;
  windowKey: string;
  providerBucket: string;
  durationMinutes: number | null;
  displayLabel: string;
  usedValue: number | null;
  usedUnit: string | null;
  remainingPercent: number | null;
  resetAt: string | null;
  observedAt: string;
  freshUntil: string | null;
  expiresAt: string | null;
  source: CapacitySource;
  unavailableReason: CapacityUnavailableReason | null;
  evidenceRef: string | null;
  criticalRole: CapacityCriticalRole | null;
}

/** Normalize one raw provider window into the persistable snapshot shape. */
export function normalizeAdapterWindow(
  runtime: Runtime,
  reading: AdapterWindowReading,
  nowMs = Date.now()
): NormalizedWindowInput {
  const observedAt = reading.observedAt ?? new Date(nowMs).toISOString();
  let remainingPercent: number | null = null;
  let unavailableReason: CapacityUnavailableReason | null = null;
  if (typeof reading.usedPercent === "number" && Number.isFinite(reading.usedPercent)) {
    remainingPercent = remainingPercentFromUsedPercent(reading.usedPercent);
  } else if (typeof reading.usedFraction === "number" && Number.isFinite(reading.usedFraction)) {
    remainingPercent = remainingPercentFromFraction(reading.usedFraction);
  } else {
    unavailableReason = "unparsable";
  }
  return {
    runtime,
    windowKey: reading.windowKey,
    providerBucket: reading.providerBucket,
    durationMinutes: reading.durationMinutes ?? null,
    displayLabel: deriveWindowLabel(reading.durationMinutes, reading.providerLabel),
    usedValue: reading.usedValue ?? null,
    usedUnit: reading.usedUnit ?? null,
    remainingPercent,
    resetAt: reading.resetAt ?? null,
    observedAt,
    freshUntil: new Date(
      Date.parse(observedAt) + (reading.staleAfterMs ?? DEFAULT_STALE_AFTER_MS)
    ).toISOString(),
    expiresAt: new Date(
      Date.parse(observedAt) + (reading.expiresAfterMs ?? DEFAULT_EXPIRES_AFTER_MS)
    ).toISOString(),
    source: reading.source,
    unavailableReason,
    evidenceRef: reading.evidenceRef ?? null,
    criticalRole: reading.criticalRole ?? null,
  };
}

/** Normalize one provider failure into the persistable snapshot shape. */
export function normalizeUnavailableWindow(
  runtime: Runtime,
  reading: AdapterUnavailableReading,
  nowMs = Date.now()
): NormalizedWindowInput {
  return {
    runtime,
    windowKey: reading.windowKey,
    providerBucket: reading.providerBucket,
    durationMinutes: reading.durationMinutes ?? null,
    displayLabel: deriveWindowLabel(reading.durationMinutes, reading.providerLabel),
    usedValue: null,
    usedUnit: null,
    remainingPercent: null,
    resetAt: null,
    observedAt: reading.observedAt ?? new Date(nowMs).toISOString(),
    freshUntil: null,
    expiresAt: null,
    source: "unavailable",
    unavailableReason: reading.reason,
    evidenceRef: null,
    criticalRole: null,
  };
}

// ---------------------------------------------------------------------------
// Deterministic fixtures. These stand in for provider live reads until the
// sibling tickets land; the Agents-page strip and service tests pin every UI
// state (known, multi-window, stale, unsupported) against them.
// ---------------------------------------------------------------------------

function iso(nowMs: number, deltaMs: number): string {
  return new Date(nowMs + deltaMs).toISOString();
}

/** Two independently resetting windows with known remaining percents. */
export function fixtureMultiWindowAdapter(nowMs = Date.now()): CapacityAdapter {
  return {
    runtime: "claude_code",
    source: "supported_protocol",
    read: () => ({
      runtime: "claude_code",
      windows: [
        {
          windowKey: "five_hour",
          providerBucket: "all_models",
          durationMinutes: 300,
          providerLabel: "five_hour",
          usedValue: 50,
          usedUnit: "percent",
          usedPercent: 50,
          resetAt: iso(nowMs, 2 * 3600_000),
          observedAt: iso(nowMs, -60_000),
          source: "supported_protocol",
        },
        {
          windowKey: "weekly",
          providerBucket: "all_models",
          durationMinutes: 10080,
          providerLabel: "weekly",
          usedValue: 0.35,
          usedUnit: "fraction",
          usedFraction: 0.35,
          resetAt: iso(nowMs, 3 * 24 * 3600_000),
          observedAt: iso(nowMs, -60_000),
          source: "supported_protocol",
        },
      ],
      unavailable: [],
    }),
  };
}

/** A runtime whose provider has no capacity surface at all. */
export function fixtureUnsupportedAdapter(nowMs = Date.now()): CapacityAdapter {
  return {
    runtime: "cursor_local",
    source: "supported_protocol",
    read: () => ({
      runtime: "cursor_local",
      windows: [],
      unavailable: [
        {
          windowKey: "capacity",
          providerBucket: "default",
          providerLabel: "capacity",
          reason: "unsupported",
          observedAt: iso(nowMs, 0),
        },
      ],
    }),
  };
}

/** A window observed long ago: past expiry, renders N/A (`expired`). */
export function fixtureStaleAdapter(nowMs = Date.now()): CapacityAdapter {
  return {
    runtime: "codex_local",
    source: "observed_event",
    read: () => ({
      runtime: "codex_local",
      windows: [
        {
          windowKey: "weekly",
          providerBucket: "all_models",
          durationMinutes: 10080,
          providerLabel: "weekly",
          usedValue: 10,
          usedUnit: "percent",
          usedPercent: 10,
          resetAt: iso(nowMs, 24 * 3600_000),
          observedAt: iso(nowMs, -2 * DEFAULT_EXPIRES_AFTER_MS),
          source: "observed_event",
        },
      ],
      unavailable: [],
    }),
  };
}
