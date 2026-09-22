// packages/server/src/capacity/service.ts
//
// NOT-245: runtime capacity read model. Builds one entry per *configured
// runtime account* — distinct `runtime` values across Agent profiles, so two
// profiles sharing one account produce one entry — each carrying whatever
// windows the provider actually reported.
//
// Connection health, hard-cap availability, and remaining capacity stay
// separate states: this service never reads `runtime_availability` and its
// output never implies health. Only normalized snapshots leave this module —
// evidence refs and raw provider payloads stay server-side.

import type {
  CapacityUnavailableReason,
  CapacityWindowSnapshot,
  Runtime,
  RuntimeCapacityEntry,
  RuntimeCapacityResponse,
} from "@agent-dealer/shared";
import { isWindowKnown, Runtime as RuntimeSchema } from "@agent-dealer/shared";
import { getDb } from "../db/index.js";
import {
  listAllCapacitySnapshots,
  recordCapacitySnapshots,
} from "../repository/runtime-capacity.js";
import {
  normalizeAdapterWindow,
  normalizeUnavailableWindow,
  type AdapterReadResult,
  type CapacityAdapter,
} from "./adapter.js";

/** Distinct runtimes across Agent profiles — the configured runtime accounts. */
export function configuredCapacityRuntimes(): Runtime[] {
  const rows = getDb()
    .prepare("SELECT DISTINCT runtime FROM agents ORDER BY runtime")
    .all() as Array<{ runtime: string }>;
  const out: Runtime[] = [];
  for (const row of rows) {
    const parsed = RuntimeSchema.safeParse(row.runtime);
    if (parsed.success && !out.includes(parsed.data)) out.push(parsed.data);
  }
  return out;
}

/** Ingest one adapter read into normalized snapshots (fixtures or live). */
export async function ingestAdapterResult(result: AdapterReadResult): Promise<void> {
  const nowMs = Date.now();
  recordCapacitySnapshots(
    result.runtime,
    [
      ...result.windows.map((w) => normalizeAdapterWindow(result.runtime, w, nowMs)),
      ...result.unavailable.map((w) => normalizeUnavailableWindow(result.runtime, w, nowMs)),
    ].map((w) => ({
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
}

/** Classify a stored window at read time (freshness/expiry/reset, not just flags). */
function classifyWindow(
  w: CapacityWindowSnapshot,
  nowMs: number
): { snapshot: CapacityWindowSnapshot; known: boolean } {
  if (isWindowKnown(w, nowMs)) return { snapshot: w, known: true };
  let reason: CapacityUnavailableReason = w.unavailableReason ?? "missing";
  if (w.remainingPercent !== null && w.source !== "unavailable" && w.unavailableReason === null) {
    // A value existed but time invalidated it — name the time cause.
    if (w.resetAt !== null) {
      const resetMs = Date.parse(w.resetAt);
      if (!Number.isFinite(resetMs) || resetMs <= nowMs) reason = "expired";
      else if (w.expiresAt !== null && Date.parse(w.expiresAt) <= nowMs) reason = "expired";
      else if (w.freshUntil !== null && Date.parse(w.freshUntil) <= nowMs) reason = "stale";
    } else if (w.expiresAt !== null && Date.parse(w.expiresAt) <= nowMs) {
      reason = "expired";
    } else if (w.freshUntil !== null && Date.parse(w.freshUntil) <= nowMs) {
      reason = "stale";
    }
  }
  return {
    snapshot: {
      ...w,
      remainingPercent: null,
      unavailableReason: reason,
      source: "unavailable",
    },
    known: false,
  };
}

/**
 * Read model for `GET /api/runtime-capacity`: every configured runtime, its
 * windows with freshness applied, and an explicit unavailable reason whenever
 * no window carries a current value. Runtimes with no snapshot at all read
 * `missing`; `unsupported` is only ever reported by a provider read.
 */
export function getRuntimeCapacitySnapshot(nowMs = Date.now()): RuntimeCapacityResponse {
  const configured = configuredCapacityRuntimes();
  const stored = listAllCapacitySnapshots();
  const byRuntime = new Map<Runtime, CapacityWindowSnapshot[]>();
  for (const row of stored) {
    const { runtime, ...snapshot } = row;
    const list = byRuntime.get(runtime) ?? [];
    list.push(snapshot);
    byRuntime.set(runtime, list);
  }
  const runtimes = new Set<Runtime>([...configured, ...byRuntime.keys()]);
  const entries: RuntimeCapacityEntry[] = [...runtimes]
    .sort()
    .map((runtime): RuntimeCapacityEntry => {
      const windows = (byRuntime.get(runtime) ?? []).map((w) => classifyWindow(w, nowMs).snapshot);
      const knownCount = windows.filter((w) => w.unavailableReason === null).length;
      let unavailableReason: CapacityUnavailableReason | null = null;
      if (knownCount === 0) {
        const first = windows.find((w) => w.unavailableReason)?.unavailableReason;
        unavailableReason = first ?? "missing";
      }
      return { runtime, windows, unavailableReason };
    });
  return { runtimes: entries, generatedAt: new Date(nowMs).toISOString() };
}

/** Run a set of adapters (fixtures today, live providers in siblings) and read back. */
export async function refreshCapacityFromAdapters(
  adapters: CapacityAdapter[],
  nowMs = Date.now()
): Promise<RuntimeCapacityResponse> {
  for (const adapter of adapters) {
    const result = await adapter.read(nowMs);
    await ingestAdapterResult(result);
  }
  return getRuntimeCapacitySnapshot(nowMs);
}
