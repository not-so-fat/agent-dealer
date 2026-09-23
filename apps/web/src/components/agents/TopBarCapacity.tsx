// Compact agent-capacity summary for the Agent Dealer top bar (NOT-262).
// Uses the existing capacity source (`GET /api/runtime-capacity` via
// fetchRuntimeCapacity) and the shared freshness contract (`isWindowKnown`):
// only windows that are current render a numeric remaining percent. Loading,
// fetch-unavailable, and stale/unknown states each render distinct text and
// never present a number as current.
import type {
  CapacityUnavailableReason,
  CapacityWindowSnapshot,
  Runtime,
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

export type PerRuntimeSummary =
  | { runtime: string; kind: "known"; remaining: number; detail: string }
  | { runtime: string; kind: "unknown"; reason: CapacityUnavailableReason; detail: string };

function windowDetail(w: CapacityWindowSnapshot): string {
  if (w.unavailableReason !== null || w.remainingPercent === null) {
    return `${w.displayLabel}: N/A (${REASON_TEXT[w.unavailableReason ?? "missing"]})`;
  }
  const remaining = Math.round(w.remainingPercent);
  const reset = w.resetAt ? `, resets ${new Date(w.resetAt).toLocaleString()}` : "";
  return `${w.displayLabel}: ${remaining}% available (${100 - remaining}% used${reset})`;
}

/** One compact entry per runtime account: the most-constrained known window,
 * or N/A when no window is current. Exported for tests. */
export function summarizeCapacity(
  data: RuntimeCapacityResponse,
  nowMs = Date.now()
): PerRuntimeSummary[] {
  return data.runtimes.map((entry) => {
    const runtime = runtimeLabel(entry.runtime as Runtime);
    const known = entry.windows.filter((w) => isWindowKnown(w, nowMs));
    if (known.length > 0) {
      const remaining = Math.min(
        ...known.map((w) => Math.round(w.remainingPercent ?? 0))
      );
      return {
        runtime,
        kind: "known",
        remaining,
        detail: known.map(windowDetail).join("; "),
      } as PerRuntimeSummary;
    }
    const reason: CapacityUnavailableReason =
      entry.unavailableReason ??
      entry.windows.find((w) => w.unavailableReason !== null)?.unavailableReason ??
      "missing";
    const detail =
      entry.windows.length > 0
        ? entry.windows.map(windowDetail).join("; ")
        : `N/A (${REASON_TEXT[reason]})`;
    return { runtime, kind: "unknown", reason, detail } as PerRuntimeSummary;
  });
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
  const allUnknown = summaries.length === 0 || summaries.every((s) => s.kind === "unknown");
  return (
    <span
      data-testid="topbar-capacity"
      data-status={allUnknown ? "unknown" : "ready"}
      title={
        summaries.length === 0
          ? "Agent capacity: no runtime accounts reported"
          : summaries.map((s) => `${s.runtime}: ${s.detail}`).join(" · ")
      }
      className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1 text-xs"
    >
      <span className="uppercase tracking-wider text-white/30">Capacity</span>
      {summaries.length === 0 ? (
        <span className="whitespace-nowrap text-white/35">N/A</span>
      ) : (
        summaries.map((s) => (
          <span
            key={s.runtime}
            data-testid={`topbar-capacity-${s.runtime}`}
            data-known={s.kind === "known" ? "true" : "false"}
            title={s.kind === "known" ? `${s.runtime}: ${s.detail}` : `${s.runtime}: ${s.detail}`}
            className="inline-flex items-center gap-1 whitespace-nowrap"
          >
            <span className="text-white/40">{s.runtime}</span>
            {s.kind === "known" ? (
              <span className="font-medium tabular-nums text-white/75">{s.remaining}%</span>
            ) : (
              <span className="text-white/35">N/A</span>
            )}
          </span>
        ))
      )}
    </span>
  );
}
