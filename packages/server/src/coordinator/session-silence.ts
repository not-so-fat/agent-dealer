// packages/server/src/coordinator/session-silence.ts
//
// NOT-170: pure derivation of observational silence intervals nested inside exact or
// inferred `agent_process` boundaries (EXECUTION_ANALYSIS.md §2/§5).
//
// Rules:
// - A silence gap is a half-open [start, end) range with no new structured activity
//   whose length meets the observation threshold (default 30s).
// - Categories are exactly: model_provider_wait (only when runtime evidence names
//   provider wait/retry), tool_or_subprocess_in_flight (an unmatched tool start pairs
//   by call id), host_suspended (overlapping durable host-sleep evidence, splitting
//   the gap without double-counting), no_structured_output (process start until the
//   first structured event), unknown otherwise. Ordinary thinking is never idle —
//   there is no idle category at all.
// - Intervals are nested inside agent-process time, non-overlapping, and carry
//   quality/reason metadata. Activity timing comes from sampler read time, so derived
//   intervals are always quality `inferred` (reason `sampler_observed_time`), even
//   when the process bounds are `exact`.
// - Observational only: nothing here may be imported by admission, leases, recovery,
//   routing, retry, termination, or scheduling code.

import type { SessionActivityKind } from "./session-activity.js";

export type SilenceCategory =
  | "model_provider_wait"
  | "tool_or_subprocess_in_flight"
  | "host_suspended"
  | "no_structured_output"
  | "unknown";

export type SilenceQuality = "exact" | "inferred" | "unavailable";

export interface SilenceInterval {
  startMs: number;
  endMs: number;
  durationMs: number;
  category: SilenceCategory;
  quality: SilenceQuality;
  reasons: string[];
}

export interface SilenceActivityPoint {
  observedMs: number;
  kind: SessionActivityKind;
  callId?: string | null;
  /** Tool/subprocess display name for id-less pairing; null when unnamed. */
  name?: string | null;
}

export interface SleepWindow {
  startMs: number;
  endMs: number;
}

export interface DeriveSilenceInput {
  /** agent_process start (inclusive, epoch ms) or null when unavailable. */
  processStartMs: number | null;
  /** agent_process end (exclusive, epoch ms) or null when unavailable. */
  processEndMs: number | null;
  /** Quality of the enclosing agent_process bounds. */
  processQuality?: SilenceQuality;
  /** Reason codes carried by the enclosing bounds (propagated, never dropped). */
  processReasons?: string[];
  activities: SilenceActivityPoint[];
  sleepWindows?: SleepWindow[];
  /** Minimum gap with no new structured activity that counts as silence. */
  thresholdMs?: number;
}

export interface SilenceDerivation {
  intervals: SilenceInterval[];
  quality: SilenceQuality;
  reasons: string[];
}

export const DEFAULT_SILENCE_THRESHOLD_MS = 30_000;

export function silenceThresholdMs(): number {
  const raw = Number(process.env.SILENCE_OBSERVATION_THRESHOLD_MS ?? DEFAULT_SILENCE_THRESHOLD_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SILENCE_THRESHOLD_MS;
}

function validWindow(w: SleepWindow): boolean {
  return (
    Number.isFinite(w.startMs) && Number.isFinite(w.endMs) && w.endMs > w.startMs
  );
}

interface Gap {
  startMs: number;
  endMs: number;
  category: Exclude<SilenceCategory, "host_suspended">;
}

/**
 * Split a base-category gap around overlapping sleep windows. Overlapping parts
 * become host_suspended; the remainder keeps the base category. Adjacent parts with
 * the same category are merged so the output stays non-overlapping and minimal.
 */
function applySleepOverride(gap: Gap, windows: SleepWindow[]): SilenceInterval[] {
  const overlaps = windows
    .filter(validWindow)
    .map((w) => ({ startMs: Math.max(gap.startMs, w.startMs), endMs: Math.min(gap.endMs, w.endMs) }))
    .filter((w) => w.endMs > w.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  if (overlaps.length === 0) return [toInterval(gap.startMs, gap.endMs, gap.category)];
  // Merge overlapping sleep windows first so a gap is never double-counted.
  const merged: Array<{ startMs: number; endMs: number }> = [];
  for (const o of overlaps) {
    const last = merged[merged.length - 1];
    if (last && o.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, o.endMs);
    } else {
      merged.push({ ...o });
    }
  }
  const out: SilenceInterval[] = [];
  let cursor = gap.startMs;
  for (const m of merged) {
    if (m.startMs > cursor) out.push(toInterval(cursor, m.startMs, gap.category));
    out.push(toInterval(m.startMs, m.endMs, "host_suspended"));
    cursor = m.endMs;
  }
  if (cursor < gap.endMs) out.push(toInterval(cursor, gap.endMs, gap.category));
  return out;
}

function toInterval(startMs: number, endMs: number, category: SilenceCategory): SilenceInterval {
  return { startMs, endMs, durationMs: endMs - startMs, category, quality: "inferred", reasons: [] };
}

export function deriveSilenceIntervals(input: DeriveSilenceInput): SilenceDerivation {
  const {
    processStartMs,
    processEndMs,
    processQuality = "exact",
    processReasons = [],
    sleepWindows = [],
  } = input;
  const threshold = input.thresholdMs ?? DEFAULT_SILENCE_THRESHOLD_MS;

  if (
    processStartMs === null ||
    processEndMs === null ||
    !Number.isFinite(processStartMs) ||
    !Number.isFinite(processEndMs) ||
    processEndMs < processStartMs
  ) {
    const reasons = [...processReasons];
    if (processEndMs !== null && processStartMs !== null && processEndMs < processStartMs) {
      reasons.push("negative_duration");
    } else if (reasons.length === 0) {
      reasons.push("no_defensible_boundary");
    }
    return { intervals: [], quality: "unavailable", reasons };
  }

  const inWindow = input.activities
    .filter((a) => Number.isFinite(a.observedMs) && a.observedMs >= processStartMs && a.observedMs < processEndMs)
    .sort((a, b) => a.observedMs - b.observedMs);

  // Pair starts with completions by call id. Id-less events pair FIFO per name (and
  // across names as a last resort); a completion with nothing open closes nothing.
  // Codex item.updated never reaches this layer (the normalizer drops it), so it
  // cannot inflate the in-flight set.
  const gaps: Gap[] = [];
  let lastKind: SessionActivityKind | null = null;
  let seenAny = false;
  // State of the in-flight set at each change point; evaluated lazily per gap.
  const changePoints: number[] = [processStartMs];
  for (const a of inWindow) changePoints.push(a.observedMs);
  changePoints.push(processEndMs);

  // Replay events to record the open-set state at the start of each segment.
  const openCountAtSegment: boolean[] = [];
  {
    const ids = new Map<string, { name: string | null }>();
    let anon = 0;
    const anonNames: Array<string | null> = [];
    openCountAtSegment.push(false);
    for (const a of inWindow) {
      if (a.kind === "tool_started") {
        if (a.callId) {
          if (!ids.has(a.callId)) ids.set(a.callId, { name: a.name ?? null });
        } else {
          anon++;
          anonNames.push(a.name ?? null);
        }
      } else if (a.kind === "tool_completed") {
        if (a.callId) {
          ids.delete(a.callId);
        } else if (anon > 0) {
          const idx = a.name ? anonNames.lastIndexOf(a.name) : anonNames.length - 1;
          if (idx >= 0) anonNames.splice(idx, 1);
          else anonNames.pop();
          anon--;
        }
      }
      openCountAtSegment.push(ids.size > 0 || anon > 0);
    }
  }

  for (let i = 0; i < changePoints.length - 1; i++) {
    const a = changePoints[i]!;
    const b = changePoints[i + 1]!;
    if (b - a < threshold) {
      // Advance replay state past the event at b (when b is an event time).
      if (i < inWindow.length) {
        seenAny = true;
        lastKind = inWindow[i]!.kind;
      }
      continue;
    }
    let category: Gap["category"];
    if (!seenAny) {
      category = "no_structured_output";
    } else if (openCountAtSegment[i]) {
      category = "tool_or_subprocess_in_flight";
    } else if (lastKind === "provider_wait") {
      category = "model_provider_wait";
    } else {
      category = "unknown";
    }
    gaps.push({ startMs: a, endMs: b, category });
    if (i < inWindow.length) {
      seenAny = true;
      lastKind = inWindow[i]!.kind;
    }
  }
  const reasons = [...new Set([...processReasons, "sampler_observed_time"])];
  const intervals: SilenceInterval[] = [];
  for (const gap of gaps) {
    for (const part of applySleepOverride(gap, sleepWindows)) {
      intervals.push({ ...part, quality: "inferred", reasons: [...reasons] });
    }
  }
  intervals.sort((a, b) => a.startMs - b.startMs);
  return { intervals, quality: "inferred", reasons: [...reasons] };
}

export interface HistoricalLogSilenceInput extends Omit<DeriveSilenceInput, "processStartMs" | "processEndMs"> {
  processStartMs: number | null;
  processEndMs: number | null;
  /**
   * On-read parsing of historical logs is only allowed when the caller has verified
   * the log's timestamps/cursors are trustworthy. Otherwise this returns
   * `unavailable` rather than fabricating timing.
   */
  trustworthyTimestamps: boolean;
}

/**
 * Gate historical-log silence derivation on timestamp trust. Untrusted logs yield
 * `unavailable` (reason `untrusted_log_timestamps`); trusted ones derive as
 * `inferred` with an added `backfill` reason.
 */
export function deriveSilenceFromHistoricalLog(input: HistoricalLogSilenceInput): SilenceDerivation {
  if (!input.trustworthyTimestamps) {
    return { intervals: [], quality: "unavailable", reasons: ["untrusted_log_timestamps"] };
  }
  const derived = deriveSilenceIntervals({ ...input, thresholdMs: input.thresholdMs });
  return {
    intervals: derived.intervals.map((iv) => ({
      ...iv,
      reasons: [...new Set([...iv.reasons, "backfill"])],
    })),
    quality: derived.quality === "unavailable" ? "unavailable" : "inferred",
    reasons: [...new Set([...derived.reasons, "backfill"])],
  };
}
