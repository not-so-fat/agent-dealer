// Compact agent-capacity summary for the Agent Dealer top bar (NOT-262,
// NOT-264 dual-window presentation).
// Uses the existing capacity source (`GET /api/runtime-capacity` via
// fetchRuntimeCapacity) and the shared freshness contract (`isWindowKnown`):
// only windows that are current render a numeric remaining percent. Loading,
// fetch-unavailable, and stale/unknown states each render distinct text and
// never present a number as current.
//
// NOT-264: runtimes that report the familiar 5H/1W pair render both readings
// independently — a compact two-line block with 5H above 1W — instead of one
// collapsed minimum. Exhausting either window means the runtime cannot be
// used, so either known window at 0% gives the whole block an exhausted
// treatment while both labeled values stay visible.
import type {
  CapacityUnavailableReason,
  CapacityWindowSnapshot,
  Runtime,
  RuntimeCapacityEntry,
  RuntimeCapacityResponse,
} from "@agent-dealer/shared";
import { isWindowKnown } from "@agent-dealer/shared";
import { runtimeLabel } from "../../lib/display";

export type TopBarCapacityState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; data: RuntimeCapacityResponse };

const REASON_TEXT: Record<CapacityUnavailableReason, string> = {
  unsupported: "not reported by provider",
  missing: "no data yet",
  expired: "expired",
  unparsable: "provider data unparsable",
  stale: "stale",
};

/** Canonical labels for the familiar critical pair, in display order. */
const FIVE_HOUR_LABEL = "5H";
const WEEKLY_LABEL = "1W";

/** One labeled row inside a runtime block: a current percent or an N/A. */
export type TopBarWindowValue =
  | { label: string; kind: "known"; remaining: number; detail: string }
  | { label: string; kind: "unknown"; reason: CapacityUnavailableReason; detail: string };

export type PerRuntimeSummary = {
  runtime: string;
  /** Labeled rows in display order: 5H, 1W, then any other windows. */
  windows: TopBarWindowValue[];
  /** True when any known row is at 0% remaining: the runtime cannot be used. */
  exhausted: boolean;
  detail: string;
};

/** A 5H window by its rendered label or its defensible duration (300 min). */
function isFiveHourWindow(w: CapacityWindowSnapshot): boolean {
  return w.displayLabel === FIVE_HOUR_LABEL || w.durationMinutes === 300;
}

/** A 1W window by its rendered label or its defensible duration (10,080 min). */
function isWeeklyWindow(w: CapacityWindowSnapshot): boolean {
  return w.displayLabel === WEEKLY_LABEL || w.durationMinutes === 10080;
}

/** The reason an unknown window renders N/A: its explicit flag, else the
 * freshness/expiry check that disqualifies it, else the entry fallback. This
 * mirrors `isWindowKnown` so a stale number with no flag still reads N/A. */
function effectiveWindowReason(
  w: CapacityWindowSnapshot,
  nowMs: number,
  entryReason: CapacityUnavailableReason | null
): CapacityUnavailableReason {
  if (w.unavailableReason !== null) return w.unavailableReason;
  if (w.remainingPercent === null || w.source === "unavailable") {
    return entryReason ?? "missing";
  }
  if (w.resetAt !== null) {
    const resetMs = Date.parse(w.resetAt);
    if (!Number.isFinite(resetMs) || resetMs <= nowMs) return "expired";
  }
  if (w.freshUntil !== null) {
    const freshMs = Date.parse(w.freshUntil);
    if (!Number.isFinite(freshMs) || freshMs <= nowMs) return "stale";
  }
  if (w.expiresAt !== null) {
    const expMs = Date.parse(w.expiresAt);
    if (!Number.isFinite(expMs) || expMs <= nowMs) return "expired";
  }
  if (w.observedAt) {
    const obsMs = Date.parse(w.observedAt);
    if (!Number.isFinite(obsMs) || obsMs > nowMs + 60_000) return "stale";
  }
  return entryReason ?? "missing";
}

function windowDetail(
  w: CapacityWindowSnapshot,
  nowMs: number,
  entryReason: CapacityUnavailableReason | null
): string {
  if (isWindowKnown(w, nowMs)) {
    const remaining = Math.round(w.remainingPercent ?? 0);
    const reset = w.resetAt ? `, resets ${new Date(w.resetAt).toLocaleString()}` : "";
    return `${w.displayLabel}: ${remaining}% available (${100 - remaining}% used${reset})`;
  }
  return `${w.displayLabel}: N/A (${REASON_TEXT[effectiveWindowReason(w, nowMs, entryReason)]})`;
}

/** Collapse all same-label critical candidates to one row (most constrained
 * current reading wins); an all-unknown group renders its labeled N/A. The
 * row keeps the provider's own label so non-critical windows are never
 * relabeled as 5H/1W. */
function summarizeCriticalGroup(
  candidates: CapacityWindowSnapshot[],
  entry: RuntimeCapacityEntry,
  nowMs: number
): TopBarWindowValue | null {
  if (candidates.length === 0) return null;
  const label = candidates[0].displayLabel;
  const known = candidates.filter((w) => isWindowKnown(w, nowMs));
  if (known.length > 0) {
    return {
      label,
      kind: "known",
      remaining: Math.min(...known.map((w) => Math.round(w.remainingPercent ?? 0))),
      detail: known.map((w) => windowDetail(w, nowMs, entry.unavailableReason)).join("; "),
    };
  }
  const reason: CapacityUnavailableReason = effectiveWindowReason(
    candidates.find((w) => w.unavailableReason !== null) ?? candidates[0],
    nowMs,
    entry.unavailableReason
  );
  return {
    label,
    kind: "unknown",
    reason,
    detail: candidates.map((w) => windowDetail(w, nowMs, entry.unavailableReason)).join("; "),
  };
}

/** A non-critical window renders truthfully under its own provider label. */
function summarizeOtherWindow(
  w: CapacityWindowSnapshot,
  entry: RuntimeCapacityEntry,
  nowMs: number
): TopBarWindowValue {
  if (isWindowKnown(w, nowMs)) {
    return {
      label: w.displayLabel,
      kind: "known",
      remaining: Math.round(w.remainingPercent ?? 0),
      detail: windowDetail(w, nowMs, entry.unavailableReason),
    };
  }
  const reason: CapacityUnavailableReason = effectiveWindowReason(
    w,
    nowMs,
    entry.unavailableReason
  );
  return {
    label: w.displayLabel,
    kind: "unknown",
    reason,
    detail: windowDetail(w, nowMs, entry.unavailableReason),
  };
}

/** Synthesized N/A row for the missing half of the 5H/1W pair: the known
 * value beside it must never read as the complete runtime status. */
function missingPairWindow(
  label: string,
  entry: RuntimeCapacityEntry
): TopBarWindowValue {
  const reason: CapacityUnavailableReason = entry.unavailableReason ?? "missing";
  return { label, kind: "unknown", reason, detail: `${label}: N/A (${REASON_TEXT[reason]})` };
}

/** One entry per runtime account: the 5H/1W pair (deterministically ordered,
 * missing halves synthesized as N/A) followed by any other provider windows
 * under their own labels — or a single empty row when the runtime reported
 * nothing current. Exported for tests. */
export function summarizeCapacity(
  data: RuntimeCapacityResponse,
  nowMs = Date.now()
): PerRuntimeSummary[] {
  return data.runtimes.map((entry) => {
    const runtime = runtimeLabel(entry.runtime as Runtime);
    const fiveHour = entry.windows.filter(isFiveHourWindow);
    const weekly = entry.windows.filter(isWeeklyWindow);
    const others = entry.windows.filter((w) => !isFiveHourWindow(w) && !isWeeklyWindow(w));
    let windows: TopBarWindowValue[];
    if (fiveHour.length > 0 || weekly.length > 0) {
      windows = [
        summarizeCriticalGroup(fiveHour, entry, nowMs) ?? missingPairWindow(FIVE_HOUR_LABEL, entry),
        summarizeCriticalGroup(weekly, entry, nowMs) ?? missingPairWindow(WEEKLY_LABEL, entry),
        ...others.map((w) => summarizeOtherWindow(w, entry, nowMs)),
      ];
    } else if (entry.windows.length > 0) {
      windows = entry.windows.map((w) => summarizeOtherWindow(w, entry, nowMs));
    } else {
      windows = [];
    }
    const exhausted = windows.some((w) => w.kind === "known" && w.remaining === 0);
    const detail =
      entry.windows.length > 0
        ? entry.windows.map((w) => windowDetail(w, nowMs, entry.unavailableReason)).join("; ")
        : `N/A (${REASON_TEXT[entry.unavailableReason ?? "missing"]})`;
    return { runtime, windows, exhausted, detail };
  });
}

function blockTitle(s: PerRuntimeSummary): string {
  if (s.exhausted) {
    return `${s.runtime} exhausted — a capacity window is at 0%: ${s.detail}`;
  }
  return `${s.runtime}: ${s.detail}`;
}

export function TopBarCapacityView({
  state,
  nowMs,
}: {
  state: TopBarCapacityState;
  nowMs?: number;
}) {
  if (state.status === "loading") {
    return (
      <span
        data-testid="topbar-capacity"
        data-status="loading"
        title="Agent capacity is loading"
        className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1 whitespace-nowrap text-xs text-white/40"
      >
        <span className="uppercase tracking-wider text-white/30">Capacity</span>
        <span aria-live="polite">loading…</span>
      </span>
    );
  }
  if (state.status === "unavailable") {
    return (
      <span
        data-testid="topbar-capacity"
        data-status="unavailable"
        title="Agent capacity is unavailable — the capacity read failed"
        className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1 whitespace-nowrap text-xs text-white/40"
      >
        <span className="uppercase tracking-wider text-white/30">Capacity</span>
        <span>unavailable</span>
      </span>
    );
  }
  const summaries = summarizeCapacity(state.data, nowMs);
  const allUnknown =
    summaries.length === 0 || summaries.every((s) => !s.windows.some((w) => w.kind === "known"));
  return (
    <span
      data-testid="topbar-capacity"
      data-status={allUnknown ? "unknown" : "ready"}
      title={
        summaries.length === 0
          ? "Agent capacity: no runtime accounts reported"
          : summaries.map(blockTitle).join(" · ")
      }
      className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-3 gap-y-1 text-xs"
    >
      <span className="uppercase tracking-wider text-white/30">Capacity</span>
      {summaries.length === 0 ? (
        <span className="whitespace-nowrap text-white/35">N/A</span>
      ) : (
        summaries.map((s) => {
          const known = s.windows.some((w) => w.kind === "known");
          return (
            <span
              key={s.runtime}
              data-testid={`topbar-capacity-${s.runtime}`}
              data-known={known ? "true" : "false"}
              data-exhausted={s.exhausted ? "true" : "false"}
              title={blockTitle(s)}
              className={
                s.exhausted
                  ? "inline-flex items-center gap-1.5 whitespace-nowrap rounded border border-red-400/40 bg-red-500/10 px-1.5 py-0.5"
                  : "inline-flex items-center gap-1.5 whitespace-nowrap"
              }
            >
              <span className={s.exhausted ? "text-red-200/80" : "text-white/40"}>{s.runtime}</span>
              {s.windows.length === 0 ? (
                <span className="text-white/35">N/A</span>
              ) : (
                <span className="inline-flex flex-col leading-tight">
                  {s.windows.map((w) => (
                    <span
                      key={w.label}
                      data-window={w.label}
                      data-window-known={w.kind === "known" ? "true" : "false"}
                      className="inline-flex items-center gap-1 whitespace-nowrap tabular-nums"
                    >
                      <span className="text-white/40">{w.label}</span>
                      {w.kind === "known" ? (
                        <span
                          className={
                            w.remaining === 0
                              ? "font-medium text-red-300"
                              : "font-medium text-white/75"
                          }
                        >
                          {w.remaining}%
                        </span>
                      ) : (
                        <span className="text-white/35">N/A</span>
                      )}
                    </span>
                  ))}
                </span>
              )}
            </span>
          );
        })
      )}
    </span>
  );
}
