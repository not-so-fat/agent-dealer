// Monthly/billing-cycle capacity for Cursor Individual accounts (NOT-250).
// Rendered as its own labeled section beside the per-runtime quota strip —
// never merged into it: these are monthly billing-cycle values (reported
// usage, remaining percent, cycle reset), not 5H/1W quota windows, and money
// is never shown as a token percentage.
//
// EXPERIMENTAL: the values come from undocumented dashboard endpoints via
// the local Cursor login (no supported contract, no support guarantee — the
// adapter degrades to N/A on any drift). The card always carries the
// Experimental badge and names the local setting that disables the adapter
// (`AGENT_DEALER_CURSOR_INDIVIDUAL_CAPACITY` — unset it to disable).
import { useEffect, useState } from "react";
import type { CapacityUnavailableReason, CursorIndividualBilling } from "@agent-dealer/shared";
import { fetchCursorIndividualBilling } from "../../api";

const REASON_TEXT: Record<CapacityUnavailableReason, string> = {
  unsupported: "not reported by provider",
  missing: "no data yet",
  expired: "expired",
  unparsable: "provider data unparsable",
  stale: "stale",
};

/** Local setting that controls the experimental adapter (unset = disabled). */
export const CURSOR_INDIVIDUAL_SETTING = "AGENT_DEALER_CURSOR_INDIVIDUAL_CAPACITY";

function cycleText(billing: CursorIndividualBilling): string | null {
  if (billing.cycleLabel) return billing.cycleLabel;
  if (!billing.cycleStart && !billing.cycleEnd) return null;
  const fmt = (iso: string) => new Date(iso).toLocaleDateString();
  if (billing.cycleStart && billing.cycleEnd) return `${fmt(billing.cycleStart)} → ${fmt(billing.cycleEnd)}`;
  return fmt((billing.cycleStart ?? billing.cycleEnd) as string);
}

function resetText(billing: CursorIndividualBilling): string | null {
  if (!billing.cycleEnd) return null;
  return `resets ${new Date(billing.cycleEnd).toLocaleString()}`;
}

export function CursorIndividualBillingCardView({ data }: { data: CursorIndividualBilling }) {
  const known = data.unavailableReason === null && data.source !== "unavailable";
  const cycle = cycleText(data);
  const reset = resetText(data);
  return (
    <div
      data-testid="cursor-individual-billing"
      data-reason={data.unavailableReason ?? undefined}
      data-enabled={data.enabled ? "true" : "false"}
      data-configured={data.configured ? "true" : "false"}
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs"
    >
      <span className="uppercase tracking-wider text-white/30">Cursor individual billing</span>
      <span
        data-testid="cursor-individual-experimental"
        className="rounded border border-amber-400/30 px-1.5 py-0.5 text-amber-300/80"
        title="Experimental: undocumented Cursor dashboard API via the local login — no supported contract, no support guarantee. Unset AGENT_DEALER_CURSOR_INDIVIDUAL_CAPACITY to disable."
      >
        Experimental
      </span>
      {known ? (
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-white/70">
          {data.remainingPercent !== null && Number.isFinite(data.remainingPercent) && (
            <span
              data-testid="cursor-individual-remaining"
              title={reset ?? "Billing-cycle remaining usage as reported"}
            >
              {Math.round(data.remainingPercent)}% remaining
            </span>
          )}
          {data.usageValue !== null && Number.isFinite(data.usageValue) && (
            <span data-testid="cursor-individual-usage" className="text-white/40">
              used {data.usageUnit ? `${data.usageValue} ${data.usageUnit}` : `${data.usageValue}`}
            </span>
          )}
          {cycle && (
            <span data-testid="cursor-individual-cycle" className="text-white/40">
              cycle {cycle}
            </span>
          )}
        </span>
      ) : (
        <span
          data-testid="cursor-individual-billing-na"
          className="text-white/35"
          title={`N/A (${REASON_TEXT[data.unavailableReason ?? "missing"]})`}
        >
          N/A ({REASON_TEXT[data.unavailableReason ?? "missing"]})
          {!data.enabled && (
            <span className="ml-1 text-white/25">
              — experimental opt-in off; set {CURSOR_INDIVIDUAL_SETTING}=experimental to enable
            </span>
          )}
          {data.enabled && !data.configured && (
            <span className="ml-1 text-white/25">— no usable local Cursor login found</span>
          )}
        </span>
      )}
      <span
        className="text-white/25"
        title={`Undocumented dashboard source; unset ${CURSOR_INDIVIDUAL_SETTING} to disable this card.`}
      >
        disable: unset {CURSOR_INDIVIDUAL_SETTING}
      </span>
    </div>
  );
}

/** Self-loading card: fetches individual billing once per mount/refresh tick. */
export default function CursorIndividualBillingCard({ refreshTick }: { refreshTick?: number }) {
  const [data, setData] = useState<CursorIndividualBilling | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchCursorIndividualBilling()
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
  return <CursorIndividualBillingCardView data={data} />;
}
