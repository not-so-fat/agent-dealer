// Compact per-runtime-account capacity strip for the top of the Agents page
// (NOT-245). One entry per configured runtime account — never per Agent
// profile — beside/under connection health. Connection health stays
// independent: a green CLI dot never implies known capacity, and capacity
// N/A never implies the CLI is down.
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

function windowTitle(w: CapacityWindowSnapshot): string {
  if (w.unavailableReason !== null) {
    return `${w.displayLabel}: N/A (${REASON_TEXT[w.unavailableReason]})`;
  }
  const reset = w.resetAt ? `, resets ${new Date(w.resetAt).toLocaleString()}` : "";
  return `${w.displayLabel}: ${Math.round(w.remainingPercent ?? 0)}% remaining${reset}`;
}

function WindowChip({ window }: { window: CapacityWindowSnapshot }) {
  const known = window.unavailableReason === null && window.remainingPercent !== null;
  return (
    <span
      data-testid={`capacity-window-${window.windowKey}`}
      data-reason={window.unavailableReason ?? undefined}
      title={windowTitle(window)}
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 whitespace-nowrap ${
        known ? "border-white/15 bg-white/5 text-white/70" : "border-white/10 bg-transparent text-white/35"
      }`}
    >
      <span className="text-white/40">{window.displayLabel}</span>
      {known ? (
        (() => {
          // Severity must key off the raw provider value: rounding first
          // would let e.g. 9.6% (critical) read as 10% (not critical) and
          // 29.6% (warning) read as 30% (normal).
          const rawRemaining = window.remainingPercent ?? 0;
          const severity = capacitySeverity(rawRemaining);
          return (
            <span data-severity={severity} className={SEVERITY_CLASSNAME[severity]}>
              {Math.round(rawRemaining)}%
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
      {data.runtimes.map((entry: RuntimeCapacityResponse["runtimes"][number]) => (
        <span
          key={entry.runtime}
          data-testid={`capacity-entry-${entry.runtime}`}
          className="inline-flex min-w-0 flex-wrap items-center gap-1.5"
        >
          <span className="shrink-0 font-medium text-white/55">{runtimeLabel(entry.runtime as Runtime)}</span>
          {entry.windows.length === 0 ? (
            <span
              data-testid={`capacity-entry-${entry.runtime}-na`}
              data-reason={entry.unavailableReason ?? "missing"}
              title={`N/A (${REASON_TEXT[entry.unavailableReason ?? "missing"]})`}
              className="text-white/35"
            >
              N/A
            </span>
          ) : (
            entry.windows.map((w) => <WindowChip key={w.windowKey} window={w} />)
          )}
        </span>
      ))}
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
