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
// collapsed minimum. The pair is selected by provider bucket identity (never
// by label/duration), so model-specific extras never fold into the critical
// rows. Exhausting either critical window means the runtime cannot be used,
// so either known critical row at 0% gives the whole block an exhausted
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

/** One labeled row inside a runtime block: a current percent or an N/A.
 * `remaining` is rounded for display; `rawRemaining` is the unrounded
 * provider value and is what exhaustion must be decided from — rounding
 * first can turn a nonzero remainder (e.g. 0.4%) into a false "0%". */
export type TopBarWindowValue =
  | { key: string; label: string; kind: "known"; remaining: number; rawRemaining: number; detail: string }
  | { key: string; label: string; kind: "unknown"; reason: CapacityUnavailableReason; detail: string };

export type PerRuntimeSummary = {
  runtime: string;
  /** Labeled rows in display order: 5H, 1W, then any other windows. */
  windows: TopBarWindowValue[];
  /** True when either known critical (5H/1W) row is at 0% remaining. */
  exhausted: boolean;
  detail: string;
};

/** A Codex detailed per-limit window key: `codex_limit_<limitId>_<sub>`. The
 * limitId is arbitrary provider data (`main`, `codex`, a team name, ...) —
 * never a fixed name to match against. */
const CODEX_DETAILED_KEY = /^codex_limit_(.+)_(primary|secondary)$/;

/** The one Codex detailed limit pair, when exactly one limitId reports both
 * halves. Two or more complete pairs (e.g. `main` + `extra`) are genuinely
 * ambiguous — which one is account-wide is not decidable from the key alone
 * — so this returns null rather than guessing a name like `main`. */
function soleCodexDetailedPair(
  windows: CapacityWindowSnapshot[]
): { primary: CapacityWindowSnapshot; secondary: CapacityWindowSnapshot } | null {
  const byLimitId = new Map<
    string,
    { primary?: CapacityWindowSnapshot; secondary?: CapacityWindowSnapshot }
  >();
  for (const w of windows) {
    const m = CODEX_DETAILED_KEY.exec(w.windowKey);
    if (!m) continue;
    const [, limitId, sub] = m;
    const entry = byLimitId.get(limitId) ?? {};
    entry[sub as "primary" | "secondary"] = w;
    byLimitId.set(limitId, entry);
  }
  const complete: Array<{ primary: CapacityWindowSnapshot; secondary: CapacityWindowSnapshot }> = [];
  for (const entry of byLimitId.values()) {
    if (entry.primary && entry.secondary) complete.push({ primary: entry.primary, secondary: entry.secondary });
  }
  return complete.length === 1 ? complete[0] : null;
}

/**
 * The critical 5H/1W pair, selected by provider bucket identity — never by
 * rendered label or duration. The server labels every 300/10,080-minute
 * bucket 5H/1W via deriveWindowLabel, including model-specific extras
 * (Claude `seven_day_sonnet`/`seven_day_opus`, Codex `codex_limit_<x>_*`),
 * so label/duration matching folds non-critical buckets into the critical
 * rows, min-collapses them, and can falsely mark the runtime exhausted.
 *
 * Per provider family, tried in order:
 * - Codex: the `rateLimits` aggregate (`codex_rate_limit_primary/secondary`)
 *   — always the account-wide summary when present. Only when it is fully
 *   absent (the server's NOT-263 dedup already collapsed it into whichever
 *   detailed bucket matched) does the sole unambiguous detailed pair stand
 *   in; two or more complete detailed pairs are ambiguous and yield no
 *   critical row rather than guessing a limit id.
 * - Claude / legacy adapters: `five_hour` / `seven_day` (or `weekly`)
 *   buckets, by window key or provider bucket.
 */
function selectCriticalPair(
  windows: CapacityWindowSnapshot[]
): { fiveHour: CapacityWindowSnapshot | null; weekly: CapacityWindowSnapshot | null } {
  const aggFiveHour = windows.find((w) => w.windowKey === "codex_rate_limit_primary") ?? null;
  const aggWeekly = windows.find((w) => w.windowKey === "codex_rate_limit_secondary") ?? null;
  if (aggFiveHour || aggWeekly) return { fiveHour: aggFiveHour, weekly: aggWeekly };

  const solePair = soleCodexDetailedPair(windows);
  if (solePair) return { fiveHour: solePair.primary, weekly: solePair.secondary };

  const fiveHour =
    windows.find(
      (w) =>
        w.windowKey === "five_hour" ||
        w.windowKey === "claude_unified_five_hour" ||
        w.providerBucket.toLowerCase() === "five_hour"
    ) ?? null;
  const weekly =
    windows.find(
      (w) =>
        w.windowKey === "weekly" ||
        w.windowKey === "claude_unified_seven_day" ||
        w.windowKey === "claude_unified_weekly" ||
        w.providerBucket.toLowerCase() === "seven_day" ||
        w.providerBucket.toLowerCase() === "weekly"
    ) ?? null;
  return { fiveHour, weekly };
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

/** One half of the critical pair: exactly one identity-selected window, never
 * a min-collapse across buckets. The row keeps the provider's own label so
 * non-critical windows are never relabeled as 5H/1W. */
function summarizeCriticalWindow(
  w: CapacityWindowSnapshot,
  entry: RuntimeCapacityEntry,
  nowMs: number
): TopBarWindowValue {
  if (isWindowKnown(w, nowMs)) {
    const rawRemaining = w.remainingPercent ?? 0;
    return {
      key: w.windowKey,
      label: w.displayLabel,
      kind: "known",
      remaining: Math.round(rawRemaining),
      rawRemaining,
      detail: windowDetail(w, nowMs, entry.unavailableReason),
    };
  }
  const reason: CapacityUnavailableReason = effectiveWindowReason(w, nowMs, entry.unavailableReason);
  return {
    key: w.windowKey,
    label: w.displayLabel,
    kind: "unknown",
    reason,
    detail: windowDetail(w, nowMs, entry.unavailableReason),
  };
}

/** A non-critical window renders truthfully under its own provider label. */
function summarizeOtherWindow(
  w: CapacityWindowSnapshot,
  entry: RuntimeCapacityEntry,
  nowMs: number
): TopBarWindowValue {
  if (isWindowKnown(w, nowMs)) {
    const rawRemaining = w.remainingPercent ?? 0;
    return {
      key: w.windowKey,
      label: w.displayLabel,
      kind: "known",
      remaining: Math.round(rawRemaining),
      rawRemaining,
      detail: windowDetail(w, nowMs, entry.unavailableReason),
    };
  }
  const reason: CapacityUnavailableReason = effectiveWindowReason(
    w,
    nowMs,
    entry.unavailableReason
  );
  return {
    key: w.windowKey,
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
  return { key: `missing:${label}`, label, kind: "unknown", reason, detail: `${label}: N/A (${REASON_TEXT[reason]})` };
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
    const { fiveHour, weekly } = selectCriticalPair(entry.windows);
    const criticalKeys = new Set([fiveHour?.windowKey, weekly?.windowKey].filter(Boolean));
    const others = entry.windows.filter((w) => !criticalKeys.has(w.windowKey));
    let windows: TopBarWindowValue[];
    let criticalRows: TopBarWindowValue[];
    if (fiveHour !== null || weekly !== null) {
      const fiveRow =
        fiveHour !== null ? summarizeCriticalWindow(fiveHour, entry, nowMs) : missingPairWindow(FIVE_HOUR_LABEL, entry);
      const weeklyRow =
        weekly !== null ? summarizeCriticalWindow(weekly, entry, nowMs) : missingPairWindow(WEEKLY_LABEL, entry);
      criticalRows = [fiveRow, weeklyRow];
      windows = [...criticalRows, ...others.map((w) => summarizeOtherWindow(w, entry, nowMs))];
    } else if (entry.windows.length > 0) {
      criticalRows = [];
      windows = entry.windows.map((w) => summarizeOtherWindow(w, entry, nowMs));
    } else {
      criticalRows = [];
      windows = [];
    }
    // Exhaustion is a critical-pair state only: a non-critical extra bucket
    // at 0% never marks the runtime unavailable. Decided from the raw
    // provider value, never the rounded display value — rounding a small
    // nonzero remainder (e.g. 0.4%) down to 0% must not falsely exhaust it.
    const exhausted = criticalRows.some((w) => w.kind === "known" && w.rawRemaining === 0);
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
                      key={w.key}
                      data-window={w.label}
                      data-window-known={w.kind === "known" ? "true" : "false"}
                      className="inline-flex items-center gap-1 whitespace-nowrap tabular-nums"
                    >
                      <span className="text-white/40">{w.label}</span>
                      {w.kind === "known" ? (
                        <span
                          className={
                            w.rawRemaining === 0
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
