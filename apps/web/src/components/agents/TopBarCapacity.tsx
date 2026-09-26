// Compact agent-capacity summary for the Agent Dealer top bar (NOT-262,
// NOT-264 dual-window presentation, NOT-266 explicit selection).
// Uses the existing capacity source (`GET /api/runtime-capacity` via
// fetchRuntimeCapacity) and the shared freshness contract (`isWindowKnown`):
// only windows that are current render a numeric remaining percent. Loading,
// fetch-unavailable, and stale/unknown states each render distinct text and
// never present a number as current.
//
// NOT-264: runtimes that report the familiar 5H/1W pair render both readings
// independently — a compact two-line block with 5H above 1W — instead of one
// collapsed minimum. The pair is selected by the server-tagged
// `criticalRole` (never re-derived from a label, duration, or window-key
// heuristic — see selectCriticalPair), so model-specific extras never fold
// into the critical rows. Exhausting either critical window means the
// runtime cannot be used, so either known critical row at 0% gives the
// whole block an exhausted treatment while both labeled values stay
// visible.
//
// NOT-266: presentation selection is explicit, never inferred from provider
// labels. The top bar renders only the tagged account-wide critical pair
// (`criticalRole=five_hour|weekly`) for Claude/Codex/Muse plus Cursor's one
// `billing_cycle` window (labeled `1M`). Failure sentinels (e.g. Codex's
// `codex_account_rate_limits`, Muse's `muse_account_usage`) and
// model-specific/overage/diagnostic extras stay in the API for diagnostics
// but never render here: with no tagged pair the runtime reads `5H N/A` /
// `1W N/A` under the public labels, never under an internal name.
//
// NOT-271: each runtime block leads with a 16x16 provider logo (the shared
// AgentRuntimeIcon mapping, selected by the raw runtime key) instead of a
// visible provider-name span. The name survives as `aria-label` plus the
// full-detail `title`; the logo image itself is decorative (`alt=""`).
import type {
  CapacityUnavailableReason,
  CapacityWindowSnapshot,
  Runtime,
  RuntimeCapacityEntry,
  RuntimeCapacityResponse,
} from "@agent-dealer/shared";
import { isWindowKnown } from "@agent-dealer/shared";
import { runtimeLabel } from "../../lib/display";
import { AgentRuntimeIcon } from "./AgentIcon";

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
 * first can turn a nonzero remainder (e.g. 0.4%) into a false "0%".
 * `isCritical` marks a 5H/1W row — the per-row zero highlight is scoped to
 * it so a non-critical extra bucket at 0% never looks like it exhausted the
 * runtime when the block-level treatment (deliberately) says it didn't. */
export type TopBarWindowValue =
  | { key: string; label: string; kind: "known"; remaining: number; rawRemaining: number; detail: string; isCritical: boolean }
  | { key: string; label: string; kind: "unknown"; reason: CapacityUnavailableReason; detail: string; isCritical: boolean };

/**
 * NOT-266 explicit presentation selection: the compact UI never infers
 * importance from a provider label, window key, or duration.
 * - Claude/Codex/Muse (`PAIR_RUNTIMES`) render exactly the tagged
 *   account-wide pair (`criticalRole=five_hour|weekly`), 5H then 1W, with a
 *   missing half synthesized as a public `5H N/A` / `1W N/A` row.
 * - Cursor renders exactly its one `billing_cycle` window, labeled `1M`.
 * - Everything else (failure sentinels, model-specific/overage/diagnostic
 *   extras) stays in the API for diagnostics and never renders here.
 */
const PAIR_RUNTIMES: ReadonlySet<string> = new Set([
  "claude_code",
  "codex_local",
  "muse_code",
]);

const CURSOR_BILLING_WINDOW_KEY = "billing_cycle";
const CURSOR_BILLING_LABEL = "1M";

export type PerRuntimeSummary = {
  /** Human-readable provider label (e.g. "Muse Code") for tooltips and accessible names. */
  runtime: string;
  /** Raw runtime key (e.g. "muse_code") — icon selection matches on this enum,
   * never on the human-readable label above. */
  runtimeKey: Runtime;
  /** Labeled rows in display order: exactly 5H+1W, exactly one 1M, or none. */
  windows: TopBarWindowValue[];
  /** True when any known presented row is at 0% remaining. */
  exhausted: boolean;
  detail: string;
};

/**
 * The critical 5H/1W pair, selected by the server-tagged `criticalRole` —
 * never re-derived here from a window key, label, or duration. Two windows
 * sharing a duration (an account-wide weekly window and a model-specific
 * `seven_day_sonnet` extra, or two same-duration Codex limit buckets) are
 * not distinguishable from the client's side of the wire: only the adapter
 * that produced the reading knows which one is account-wide, so it tags
 * that one reading and every other window is simply not tagged.
 */
function selectCriticalPair(
  windows: CapacityWindowSnapshot[]
): { fiveHour: CapacityWindowSnapshot | null; weekly: CapacityWindowSnapshot | null } {
  return {
    fiveHour: windows.find((w) => w.criticalRole === "five_hour") ?? null,
    weekly: windows.find((w) => w.criticalRole === "weekly") ?? null,
  };
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

/**
 * Tooltip/accessibility detail for one presented row. Always labeled under
 * the row's public compact label (`5H`, `1W`, `1M`) — raw window keys,
 * provider buckets, and sentinel labels never appear here. Keeps the
 * value, used share, reset, and N/A reason so the tooltip stays checkable.
 */
function windowDetail(
  w: CapacityWindowSnapshot,
  nowMs: number,
  entryReason: CapacityUnavailableReason | null,
  publicLabel: string,
  extraContext: string | null = null
): string {
  if (isWindowKnown(w, nowMs)) {
    const remaining = Math.round(w.remainingPercent ?? 0);
    const reset = w.resetAt ? `, resets ${new Date(w.resetAt).toLocaleString()}` : "";
    const context = extraContext ? `, ${extraContext}` : "";
    return `${publicLabel}: ${remaining}% available (${100 - remaining}% used${context}${reset})`;
  }
  return `${publicLabel}: N/A (${REASON_TEXT[effectiveWindowReason(w, nowMs, entryReason)]})`;
}

/** One row from one window: a known percent or an N/A, labeled under the
 * explicit public label (`5H`, `1W`, or Cursor's `1M`) — never under the
 * provider's own label, so sentinel/internal names can never leak into the
 * compact UI. `isCritical` only changes the row's `isCritical` flag (used to
 * scope the per-row zero highlight) — the critical pair is never
 * min-collapsed across buckets, it is exactly one identity-selected window. */
function summarizeWindow(
  w: CapacityWindowSnapshot,
  entry: RuntimeCapacityEntry,
  nowMs: number,
  isCritical: boolean,
  publicLabel: string,
  extraContext: string | null = null
): TopBarWindowValue {
  if (isWindowKnown(w, nowMs)) {
    const rawRemaining = w.remainingPercent ?? 0;
    return {
      key: w.windowKey,
      label: publicLabel,
      kind: "known",
      remaining: Math.round(rawRemaining),
      rawRemaining,
      detail: windowDetail(w, nowMs, entry.unavailableReason, publicLabel, extraContext),
      isCritical,
    };
  }
  const reason: CapacityUnavailableReason = effectiveWindowReason(w, nowMs, entry.unavailableReason);
  return {
    key: w.windowKey,
    label: publicLabel,
    kind: "unknown",
    reason,
    detail: windowDetail(w, nowMs, entry.unavailableReason, publicLabel, extraContext),
    isCritical,
  };
}

/** Synthesized N/A row for the missing half of the 5H/1W pair: the known
 * value beside it must never read as the complete runtime status. */
function missingPairWindow(
  label: string,
  entry: RuntimeCapacityEntry
): TopBarWindowValue {
  const reason: CapacityUnavailableReason = entry.unavailableReason ?? "missing";
  return {
    key: `missing:${label}`,
    label,
    kind: "unknown",
    reason,
    detail: `${label}: N/A (${REASON_TEXT[reason]})`,
    isCritical: true,
  };
}

/** One Cursor billing-cycle row: the single primary Cursor readout, labeled
 * `1M`, with a tooltip naming the billing-cycle source and its reset. */
function summarizeCursorBilling(
  w: CapacityWindowSnapshot,
  entry: RuntimeCapacityEntry,
  nowMs: number
): TopBarWindowValue {
  return summarizeWindow(w, entry, nowMs, true, CURSOR_BILLING_LABEL, "current billing cycle");
}

/** One entry per runtime account under the NOT-266 selection rule — exactly
 * the 5H/1W pair (deterministically ordered, missing halves synthesized as
 * public N/A rows) for Claude/Codex/Muse, exactly one `1M` billing-cycle
 * row for Cursor, or no rows when the runtime reported nothing presentable.
 * Untagged windows (failure sentinels, model-specific/overage/diagnostic
 * extras) are ignored here AND in the tooltip detail: they stay in the API
 * for diagnostics but never render or leak internal names. Exported for
 * tests. */
export function summarizeCapacity(
  data: RuntimeCapacityResponse,
  nowMs = Date.now()
): PerRuntimeSummary[] {
  return data.runtimes.map((entry) => {
    const runtime = runtimeLabel(entry.runtime as Runtime);
    const runtimeKey = entry.runtime as Runtime;
    if (entry.runtime === "cursor_local") {
      const billing = entry.windows.find((w) => w.windowKey === CURSOR_BILLING_WINDOW_KEY) ?? null;
      if (billing === null) {
        return {
          runtime,
          runtimeKey,
          windows: [],
          exhausted: false,
          detail: `N/A (${REASON_TEXT[entry.unavailableReason ?? "missing"]})`,
        };
      }
      const row = summarizeCursorBilling(billing, entry, nowMs);
      // Decided from the raw provider value, never the rounded display
      // value — rounding a small nonzero remainder (e.g. 0.4%) down to 0%
      // must not falsely exhaust it.
      return {
        runtime,
        runtimeKey,
        windows: [row],
        exhausted: row.kind === "known" && row.rawRemaining === 0,
        detail: row.detail,
      };
    }
    if (PAIR_RUNTIMES.has(entry.runtime)) {
      const { fiveHour, weekly } = selectCriticalPair(entry.windows);
      const fiveRow =
        fiveHour !== null
          ? summarizeWindow(fiveHour, entry, nowMs, true, FIVE_HOUR_LABEL)
          : missingPairWindow(FIVE_HOUR_LABEL, entry);
      const weeklyRow =
        weekly !== null
          ? summarizeWindow(weekly, entry, nowMs, true, WEEKLY_LABEL)
          : missingPairWindow(WEEKLY_LABEL, entry);
      const windows = [fiveRow, weeklyRow];
      const exhausted = windows.some((w) => w.kind === "known" && w.rawRemaining === 0);
      const detail = windows.map((w) => w.detail).join("; ");
      return { runtime, runtimeKey, windows, exhausted, detail };
    }
    return {
      runtime,
      runtimeKey,
      windows: [],
      exhausted: false,
      detail: `N/A (${REASON_TEXT[entry.unavailableReason ?? "missing"]})`,
    };
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
              role="group"
              aria-label={`${s.runtime === "No agent" ? "Unknown runtime" : s.runtime} capacity`}
              className={
                s.exhausted
                  ? "inline-flex items-center gap-1.5 whitespace-nowrap rounded border border-red-400/40 bg-red-500/10 px-1.5 py-0.5"
                  : "inline-flex items-center gap-1.5 whitespace-nowrap"
              }
            >
              <AgentRuntimeIcon runtime={s.runtimeKey} className="h-4 w-4 shrink-0" />
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
                            w.isCritical && w.rawRemaining === 0
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
