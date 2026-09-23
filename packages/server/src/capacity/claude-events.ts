// packages/server/src/capacity/claude-events.ts
//
// NOT-248: Claude capacity adapter over naturally emitted structured
// rate-limit events from Dealer-managed Claude sessions.
//
// Observational only. This module parses `rate_limit_event.rate_limit_info.
// unifiedWindows` out of session NDJSON that Claude Code already emitted
// during real work and persists the windows as normalized capacity snapshots
// (source `observed_event`). It never launches `claude -p`, `/usage`, or any
// other synthetic model call, never touches Anthropic's undocumented OAuth
// usage endpoint, and never reads plan names, token totals, or session cost.
//
// Separation from NOT-111 hard caps: this module never reads or writes
// `runtime_availability`. A rejected rate-limit event still flows through
// `runners/usage-cap.ts` for defer/admission; a session whose events carry
// unified windows additionally flows through here for capacity — the two
// states coexist on independent rows.
//
// Observed-at semantics (repair round 2 — a session-end stamp is a lie for a
// long session, so each event keeps its own time):
// - When the event carries its own timestamp it is used (clamped to `nowMs` —
//   an event cannot be newer than the session end that is ingesting it).
// - Otherwise the caller passes the session's spawn start
//   (`fallbackObservedAtMs`); the event happened no earlier than spawn, so
//   this understates freshness rather than overstating it.
// - Only when neither exists does ingestion time (`nowMs`) apply.
// - A reading never overwrites a stored row whose `observed_at` is newer, so
//   a later-finishing long session cannot clobber a concurrent session's
//   fresher reading.
//
// Provider shape (tolerant — only the dotted path above is contractual):
// - `unifiedWindows` may be an array of window objects or a map of
//   bucket-name → window object. Array entries name their bucket via
//   `window`, `bucket`, `name`, `id`, `key`, `limitType`, `rateLimitType`,
//   or `type` (first present string wins).
// - Utilization is a 0–1 fraction (`utilization`, `used`, `usedFraction`,
//   `used_fraction`); an explicit 0–100 scale (`usedPercent`,
//   `used_percent`, `utilizationPercent`, `utilization_percent`) takes
//   precedence when both are present. A bare finite number as a map value
//   reads as a utilization fraction. Entries without a usable scale are
//   skipped — never fabricated.
// - Reset time accepts epoch seconds, epoch milliseconds, or ISO-8601
//   (`resetsAt`, `resets_at`, `resetAt`, `reset_at`); missing/unparsable
//   resets persist as null.
// - Duration accepts explicit minute fields when present; otherwise it is
//   inferred from well-known bucket names only (`five_hour` → 300,
//   `seven_day*`/`weekly` → 10080). Anything else keeps duration null and
//   the provider label verbatim — never guessed.
// - Every distinct provider bucket keeps its identity: `providerBucket` is
//   the raw bucket string and `windowKey` is namespaced from it, so
//   five-hour, seven-day, and model/overage-specific seven-day buckets
//   persist as independent rows.

import fs from "node:fs";
import type { Runtime } from "@agent-dealer/shared";
import { parseNdjson } from "../runners/stream-json.js";
import {
  listCapacitySnapshots,
  recordCapacitySnapshots,
} from "../repository/runtime-capacity.js";
import {
  normalizeAdapterWindow,
  type AdapterReadResult,
  type AdapterWindowReading,
} from "./adapter.js";

export const CLAUDE_RUNTIME: Runtime = "claude_code";

/** Evidence refs are static pointers — never credentials or raw payloads. */
export const CLAUDE_UNIFIED_WINDOWS_EVIDENCE_REF = "claude-session:unified-windows";

type StreamEvent = Record<string, unknown>;

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pickNumber(candidates: unknown[]): number | null {
  for (const c of candidates) {
    const n = asFiniteNumber(c);
    if (n !== null) return n;
  }
  return null;
}

function pickString(candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}

/** resetsAt arrives as epoch seconds, epoch ms, or ISO-8601 — normalize to ISO. */
export function normalizeClaudeResetsAt(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return normalizeClaudeResetsAt(Number(trimmed));
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}

/**
 * Parse an event timestamp (ISO-8601, epoch seconds, or epoch milliseconds)
 * to epoch ms. Returns null when the value carries no usable time — the
 * caller then falls back conservatively to the session spawn start.
 */
export function parseClaudeEventTimestamp(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return parseClaudeEventTimestamp(Number(trimmed));
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

const EVENT_TIMESTAMP_KEYS = [
  "timestamp",
  "eventTimestamp",
  "event_timestamp",
  "emittedAt",
  "emitted_at",
  "observedAt",
  "observed_at",
  "ts",
  "time",
] as const;

/**
 * Per-event observed time: the event's own timestamp when present and valid
 * (clamped to `nowMs`), otherwise the session spawn start passed by the
 * caller, otherwise ingestion time. Stream-json lines carry no documented
 * timestamp field, so several spellings are accepted — an unknown shape
 * simply falls through to the conservative spawn-start fallback.
 */
export function claudeEventObservedAt(
  event: StreamEvent,
  nowMs: number,
  fallbackObservedAtMs: number
): string {
  const fallback = new Date(Math.min(fallbackObservedAtMs, nowMs)).toISOString();
  for (const key of EVENT_TIMESTAMP_KEYS) {
    if (event[key] === undefined || event[key] === null) continue;
    const parsed = parseClaudeEventTimestamp(event[key]);
    if (parsed === null) continue;
    return new Date(Math.min(parsed, nowMs)).toISOString();
  }
  return fallback;
}

function sanitizeKeySegment(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || "window";
}

/**
 * Duration inference from well-known provider bucket names only. Model and
 * overage variants (e.g. `seven_day_sonnet`) share the seven-day length but
 * keep their own bucket identity — only the duration is shared, never the
 * row.
 */
export function inferClaudeDurationMinutes(bucket: string): number | null {
  const b = bucket.toLowerCase();
  if (/five[\s_-]*hour/.test(b)) return 300;
  if (/seven[\s_-]*day/.test(b) || b === "weekly") return 10080;
  return null;
}

function windowReadingFromEntry(
  bucket: string,
  entry: unknown,
  observedAt: string
): AdapterWindowReading | null {
  const cleanBucket = bucket.trim();
  if (!cleanBucket) return null;
  let usedFraction: number | null = null;
  let usedPercent: number | null = null;
  let resetRaw: unknown = null;
  let durationRaw: number | null = null;
  if (typeof entry === "number") {
    // Bare map value (`"five_hour": 0.17`) reads as a utilization fraction.
    usedFraction = asFiniteNumber(entry);
  } else if (entry && typeof entry === "object") {
    const w = entry as Record<string, unknown>;
    usedPercent = pickNumber([
      w.usedPercent,
      w.used_percent,
      w.utilizationPercent,
      w.utilization_percent,
    ]);
    usedFraction = pickNumber([w.utilization, w.used, w.usedFraction, w.used_fraction]);
    resetRaw = w.resetsAt ?? w.resets_at ?? w.resetAt ?? w.reset_at ?? null;
    durationRaw = pickNumber([
      w.durationMinutes,
      w.duration_minutes,
      w.windowDurationMins,
      w.window_duration_mins,
      w.windowDurationMinutes,
    ]);
  } else {
    return null;
  }
  if (usedPercent === null && usedFraction === null) return null;
  const durationMinutes =
    durationRaw !== null ? Math.round(durationRaw) : inferClaudeDurationMinutes(cleanBucket);
  return {
    windowKey: `claude_unified_${sanitizeKeySegment(cleanBucket)}`,
    providerBucket: cleanBucket,
    durationMinutes,
    providerLabel: cleanBucket,
    usedValue: usedPercent ?? usedFraction,
    usedUnit: usedPercent !== null ? "percent" : "fraction",
    ...(usedPercent !== null ? { usedPercent } : { usedFraction: usedFraction as number }),
    resetAt: normalizeClaudeResetsAt(resetRaw),
    observedAt,
    source: "observed_event",
    evidenceRef: CLAUDE_UNIFIED_WINDOWS_EVIDENCE_REF,
  };
}

export interface ClaudeUnifiedWindowsReadings {
  windows: AdapterWindowReading[];
}

/**
 * Normalize one `rate_limit_info` object's `unifiedWindows` into adapter
 * readings. Returns null when nothing usable is present (missing field,
 * wrong shape, or no entry with a usable scale) — the caller records
 * nothing rather than fabricating a value.
 */
export function claudeUnifiedWindowsToReadings(
  rateLimitInfo: unknown,
  observedAt = new Date().toISOString()
): ClaudeUnifiedWindowsReadings | null {
  if (!rateLimitInfo || typeof rateLimitInfo !== "object") return null;
  const raw = (rateLimitInfo as Record<string, unknown>).unifiedWindows;
  if (!raw || typeof raw !== "object") return null;
  // Last entry wins per window key; identities never collapse across
  // distinct buckets.
  const byKey = new Map<string, AdapterWindowReading>();
  const push = (bucket: unknown, entry: unknown) => {
    if (typeof bucket !== "string" || !bucket.trim()) return;
    const reading = windowReadingFromEntry(bucket, entry, observedAt);
    if (reading) byKey.set(reading.windowKey, reading);
  };
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const w = item as Record<string, unknown>;
      push(
        pickString([
          w.window,
          w.bucket,
          w.name,
          w.id,
          w.key,
          w.limitType,
          w.limit_type,
          w.rateLimitType,
          w.rate_limit_type,
          w.type,
        ]),
        item
      );
    }
  } else {
    for (const [bucket, entry] of Object.entries(raw as Record<string, unknown>)) {
      push(bucket, entry);
    }
  }
  return byKey.size > 0 ? { windows: [...byKey.values()] } : null;
}

/**
 * Scan Claude session events for `rate_limit_event`s carrying usable
 * `unifiedWindows`. Status is irrelevant — allowed events carry the
 * utilization signal; rejected ones additionally drive NOT-111 elsewhere.
 * Each window keeps the freshest reading seen for its key (ties break toward
 * the later event), and every reading is stamped with its own event time —
 * never a single session-end stamp. Returns null when no event yields a
 * reading.
 */
export function extractClaudeCapacityFromEvents(
  events: StreamEvent[],
  nowMs = Date.now(),
  fallbackObservedAtMs = nowMs
): AdapterReadResult | null {
  const byKey = new Map<string, AdapterWindowReading>();
  for (const e of events) {
    if (e.type !== "rate_limit_event") continue;
    const info = e.rate_limit_info;
    if (!info || typeof info !== "object") continue;
    const observedAt = claudeEventObservedAt(e, nowMs, fallbackObservedAtMs);
    const parsed = claudeUnifiedWindowsToReadings(info, observedAt);
    if (!parsed) continue;
    for (const w of parsed.windows) {
      const prev = byKey.get(w.windowKey);
      // observedAt is always set by windowReadingFromEntry; `?? ""` only
      // satisfies the optional field type (NaN never wins a comparison).
      if (!prev || Date.parse(w.observedAt ?? "") >= Date.parse(prev.observedAt ?? "")) {
        byKey.set(w.windowKey, w);
      }
    }
  }
  if (byKey.size === 0) return null;
  return { runtime: CLAUDE_RUNTIME, windows: [...byKey.values()], unavailable: [] };
}

/**
 * Persist naturally observed unified windows as normalized capacity
 * snapshots (per-window upserts — siblings not in this observation are left
 * untouched, and a stored row newer than the incoming reading is never
 * overwritten). Returns the number of windows persisted, or null when the
 * runtime is not Claude or no usable windows were observed. Never touches
 * `runtime_availability`.
 */
export function recordClaudeCapacityFromEvents(
  events: StreamEvent[],
  runtime: Runtime,
  nowMs = Date.now(),
  fallbackObservedAtMs = nowMs
): number | null {
  if (runtime !== CLAUDE_RUNTIME) return null;
  const result = extractClaudeCapacityFromEvents(events, nowMs, fallbackObservedAtMs);
  if (!result) return null;
  const normalized = result.windows.map((w) => normalizeAdapterWindow(runtime, w, nowMs));
  const persistable = normalized.filter(
    (n) => n.unavailableReason === null && n.remainingPercent !== null
  );
  if (persistable.length === 0) return null;
  const storedObservedAt = new Map(
    listCapacitySnapshots(runtime).map((row) => [row.windowKey, row.observedAt])
  );
  const fresh = persistable.filter((w) => {
    const prev = storedObservedAt.get(w.windowKey);
    if (!prev) return true;
    const prevMs = Date.parse(prev);
    const nextMs = Date.parse(w.observedAt);
    if (!Number.isFinite(prevMs)) return true;
    if (!Number.isFinite(nextMs)) return false;
    return nextMs >= prevMs;
  });
  if (fresh.length === 0) return 0;
  recordCapacitySnapshots(
    runtime,
    fresh.map((w) => ({
      windowKey: w.windowKey,
      providerBucket: w.providerBucket,
      durationMinutes: w.durationMinutes,
      displayLabel: w.displayLabel,
      usedValue: w.usedValue,
      usedUnit: w.usedUnit,
      remainingPercent: w.remainingPercent,
      resetAt: w.resetAt,
      observedAt: w.observedAt,
      freshUntil: w.freshUntil,
      expiresAt: w.expiresAt,
      source: w.source,
      unavailableReason: w.unavailableReason,
      evidenceRef: w.evidenceRef,
    }))
  );
  return fresh.length;
}

/**
 * File variant for session-end ingestion from a Dealer-managed Claude log.
 * `fallbackObservedAtMs` is the session's spawn start. Returns the persisted
 * window count, or null when the file is missing, the runtime is not Claude,
 * or no usable windows were observed.
 */
export function recordClaudeCapacityFromLog(
  logPath: string,
  runtime: Runtime,
  nowMs = Date.now(),
  fallbackObservedAtMs = nowMs
): number | null {
  if (runtime !== CLAUDE_RUNTIME) return null;
  if (!fs.existsSync(logPath)) return null;
  return recordClaudeCapacityFromEvents(
    parseNdjson(fs.readFileSync(logPath, "utf8")),
    runtime,
    nowMs,
    fallbackObservedAtMs
  );
}
