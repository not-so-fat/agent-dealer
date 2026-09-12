// packages/server/src/coordinator/metrics.ts
//
// Pure read-side rollups the design doc requires (§10) but explicitly does not want a
// separate table for: human wait time and intervention count, computed from
// `human_actions` rows already returned by the issue-detail route. No DB access here —
// keeps these testable as plain functions over data the caller already fetched.
import type { HumanAction } from "@agent-dealer/shared";

/**
 * Human wait is the union of `[requestedAt, resolvedAt ?? now]` intervals — not a sum —
 * so two overlapping open actions on the same issue don't double-count the overlap
 * (design doc §"usage_events": "avoiding double-counting overlapping actions").
 */
export function computeHumanWaitMs(actions: HumanAction[], now: number = Date.now()): number {
  const intervals = actions
    .map((a) => ({
      start: new Date(a.requestedAt).getTime(),
      end: a.resolvedAt ? new Date(a.resolvedAt).getTime() : now,
    }))
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start)
    .sort((a, b) => a.start - b.start);

  let totalMs = 0;
  let curStart = -Infinity;
  let curEnd = -Infinity;
  for (const { start, end } of intervals) {
    if (start > curEnd) {
      if (curEnd > curStart) totalMs += curEnd - curStart;
      curStart = start;
      curEnd = end;
    } else if (end > curEnd) {
      curEnd = end;
    }
  }
  if (curEnd > curStart) totalMs += curEnd - curStart;
  return totalMs;
}

/** Every human action ever raised for the issue — resolved or still open. */
export function computeInterventionCount(actions: HumanAction[]): number {
  return actions.length;
}
