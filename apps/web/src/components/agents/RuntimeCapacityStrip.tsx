// Compact per-runtime-account capacity strip for the top of the Agents page
// (NOT-245). One entry per configured runtime account — never per Agent
// profile — beside/under connection health. Connection health stays
// independent: a green CLI dot never implies known capacity, and capacity
// N/A never implies the CLI is down.
//
// NOT-266 explicit presentation selection (shared with TopBarCapacity):
// only the tagged account-wide critical pair (`criticalRole=five_hour|
// weekly`) for Claude/Codex/Muse — 5H then 1W, missing halves synthesized
// as public N/A chips — plus Cursor's one `billing_cycle` window labeled
// `1M`. Failure sentinels and model-specific/overage/diagnostic extras stay
// in the API for diagnostics but never render here.
import { useEffect, useState } from "react";
import type {
  CapacityUnavailableReason,
  CapacityWindowSnapshot,
  Runtime,
  RuntimeCapacityResponse,
} from "@agent-dealer/shared";
import { fetchRuntimeCapacity } from "../../api";
import { runtimeLabel } from "../../lib/display";

const REASON_TEXT: Record<CapacityUnavailableReason, string> = {
  unsupported: "not reported by provider",
  missing: "no data yet",
  expired: "expired",
  unparsable: "provider data unparsable",
  stale: "stale",
};

/** Remaining-capacity severity thresholds for the Agents-page strip: under
 * 10% is critical (red, bold), under 30% is a warning (yellow). */
type CapacitySeverity = "critical" | "warning" | "normal";

function capacitySeverity(remainingPercent: number): CapacitySeverity {
  if (remainingPercent < 10) return "critical";
  if (remainingPercent < 30) return "warning";
  return "normal";
}

const SEVERITY_CLASSNAME: Record<CapacitySeverity, string> = {
  critical: "font-bold text-red-400",
  warning: "text-yellow-400",
  normal: "font-medium",
};

/**
 * One presentational chip row: a known remaining percent or an N/A under
 * its public compact label. Raw window keys, provider buckets, and
 * sentinel labels never reach the label or the tooltip title.
 */
export type StripRow =
  | { key: string; label: string; kind: "known"; remaining: number; rawRemaining: number; title: string }
  | { key: string; label: string; kind: "unknown"; reason: CapacityUnavailableReason; title: string };

const PAIR_RUNTIMES: ReadonlySet<string> = new Set([
  "claude_code",
  "codex_local",
  "muse_code",
]);

const CURSOR_BILLING_WINDOW_KEY = "billing_cycle";
const CURSOR_BILLING_LABEL = "1M";
const FIVE_HOUR_LABEL = "5H";
const WEEKLY_LABEL = "1W";

function pairRow(
  w: CapacityWindowSnapshot | null,
  label: string,
  entryReason: CapacityUnavailableReason | null,
  missingKey: string
): StripRow {
  if (w !== null) {
    return windowRow(w, label, null);
  }
  const reason = entryReason ?? "missing";
  return {
    key: missingKey,
    label,
    kind: "unknown",
    reason,
    title: `${label}: N/A (${REASON_TEXT[reason]})`,
  };
}

function windowRow(
  w: CapacityWindowSnapshot,
  label: string,
  extraContext: string | null
): StripRow {
  // Truthful freshness reads what the server classified: a classified
  // unavailable window (or a null remaining) renders N/A, never a number.
  if (w.unavailableReason === null && w.remainingPercent !== null) {
    const rawRemaining = w.remainingPercent;
    const reset = w.resetAt ? `, resets ${new Date(w.resetAt).toLocaleString()}` : "";
    const context = extraContext ? `, ${extraContext}` : "";
    return {
      key: w.windowKey,
      label,
      kind: "known",
      remaining: Math.round(rawRemaining),
      rawRemaining,
      title: `${label}: ${Math.round(rawRemaining)}% remaining${context}${reset}`,
    };
  }
  const reason = w.unavailableReason ?? "missing";
  return {
    key: w.windowKey,
    label,
    kind: "unknown",
    reason,
    title: `${label}: N/A (${REASON_TEXT[reason]})`,
  };
}

/**
 * NOT-266 selection for one runtime entry. Exported for tests.
 */
export function selectStripRows(
  entry: RuntimeCapacityResponse["runtimes"][number]
): StripRow[] {
  if (entry.runtime === "cursor_local") {
    const billing = entry.windows.find((w) => w.windowKey === CURSOR_BILLING_WINDOW_KEY) ?? null;
    if (billing === null) return [];
    return [windowRow(billing, CURSOR_BILLING_LABEL, "current billing cycle")];
  }
  if (PAIR_RUNTIMES.has(entry.runtime)) {
    const fiveHour = entry.windows.find((w) => w.criticalRole === "five_hour") ?? null;
    const weekly = entry.windows.find((w) => w.criticalRole === "weekly") ?? null;
    return [
      pairRow(fiveHour, FIVE_HOUR_LABEL, entry.unavailableReason, "missing-5H"),
      pairRow(weekly, WEEKLY_LABEL, entry.unavailableReason, "missing-1W"),
    ];
  }
  return [];
}

function StripChip({ row }: { row: StripRow }) {
  const known = row.kind === "known";
  return (
    <span
      data-testid={`capacity-window-${row.key}`}
      data-reason={row.kind === "unknown" ? row.reason : undefined}
      title={row.title}
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 whitespace-nowrap ${
        known ? "border-white/15 bg-white/5 text-white/70" : "border-white/10 bg-transparent text-white/35"
      }`}
    >
      <span className="text-white/40">{row.label}</span>
      {row.kind === "known" ? (
        (() => {
          // Severity must key off the raw provider value: rounding first
          // would let e.g. 9.6% (critical) read as 10% (not critical) and
          // 29.6% (warning) read as 30% (normal).
          const severity = capacitySeverity(row.rawRemaining);
          return (
            <span data-severity={severity} className={SEVERITY_CLASSNAME[severity]}>
              {row.remaining}%
            </span>
          );
        })()
      ) : (
        <span>N/A</span>
      )}
    </span>
  );
}

export function RuntimeCapacityStripView({ data }: { data: RuntimeCapacityResponse }) {
  if (data.runtimes.length === 0) return null;
  return (
    <div
      data-testid="runtime-capacity-strip"
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs"
    >
      <span className="uppercase tracking-wider text-white/30">Runtime capacity</span>
      {data.runtimes.map((entry: RuntimeCapacityResponse["runtimes"][number]) => {
        const rows = selectStripRows(entry);
        return (
        <span
          key={entry.runtime}
          data-testid={`capacity-entry-${entry.runtime}`}
          className="inline-flex min-w-0 flex-wrap items-center gap-1.5"
        >
          <span className="shrink-0 whitespace-nowrap font-medium text-white/55">{runtimeLabel(entry.runtime as Runtime)}</span>
          {rows.length === 0 ? (
            <span
              data-testid={`capacity-entry-${entry.runtime}-na`}
              data-reason={entry.unavailableReason ?? "missing"}
              title={`N/A (${REASON_TEXT[entry.unavailableReason ?? "missing"]})`}
              className="whitespace-nowrap text-white/35"
            >
              N/A
            </span>
          ) : (
            rows.map((row) => <StripChip key={row.key} row={row} />)
          )}
        </span>
        );
      })}
    </div>
  );
}

/** Self-loading strip: fetches capacity once per mount/refresh tick. */
export default function RuntimeCapacityStrip({ refreshTick }: { refreshTick?: number }) {
  const [data, setData] = useState<RuntimeCapacityResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchRuntimeCapacity()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  if (!data) return null;
  return <RuntimeCapacityStripView data={data} />;
}
