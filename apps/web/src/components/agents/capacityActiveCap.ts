// NOT-440: shared active-cap overlay for the compact capacity surfaces
// (RuntimeCapacityStrip, TopBarCapacity). The server reports the runtime's
// active hard cap beside the raw snapshots; a cap mapped to a compact window
// renders that row as 0%, and an unmapped cap renders the runtime as capped.
import type { RuntimeCapacityActiveCap, RuntimeCapacityEntry } from "@agent-dealer/shared";

/** The entry's active cap while it still holds at `nowMs` (the boundary itself is uncapped). */
export function activeCapAt(entry: RuntimeCapacityEntry, nowMs: number): RuntimeCapacityActiveCap | null {
  const cap = entry.activeCap ?? null;
  if (cap === null) return null;
  const untilMs = Date.parse(cap.unavailableUntil);
  return Number.isFinite(untilMs) && untilMs > nowMs ? cap : null;
}

export function cappedUntilText(cap: RuntimeCapacityActiveCap): string {
  return `capped until ${new Date(cap.unavailableUntil).toLocaleString()}`;
}
