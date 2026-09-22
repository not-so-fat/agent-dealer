// Team-level Cursor billing from the official Admin API (NOT-249). Rendered
// as its own labeled section beside the per-runtime quota strip — never
// merged into it: these are team billing-cycle values (summed per-member
// spend in cents, team size, per-member limit overrides), not individual
// runtime quota, and are never shown as token percentages or 5H/1W windows.
// The API reports no team hard limit and no cycle end, so those never render
// from adapter data.
import { useEffect, useState } from "react";
import type { CapacityUnavailableReason, CursorTeamBilling } from "@agent-dealer/shared";
import { fetchCursorTeamBilling } from "../../api";

const REASON_TEXT: Record<CapacityUnavailableReason, string> = {
  unsupported: "not reported by provider",
  missing: "no data yet",
  expired: "expired",
  unparsable: "provider data unparsable",
  stale: "stale",
};

function money(value: number | null, unit: string | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return unit ? `${value} ${unit}` : `${value}`;
}

function cycleText(billing: CursorTeamBilling): string | null {
  if (!billing.cycleStart && !billing.cycleEnd) return null;
  const fmt = (iso: string) => new Date(iso).toLocaleDateString();
  if (billing.cycleStart && billing.cycleEnd) return `${fmt(billing.cycleStart)} → ${fmt(billing.cycleEnd)}`;
  return fmt((billing.cycleStart ?? billing.cycleEnd) as string);
}

function membersText(billing: CursorTeamBilling): string | null {
  if (billing.memberCount === null || !Number.isFinite(billing.memberCount)) return null;
  const base = `${billing.memberCount} member${billing.memberCount === 1 ? "" : "s"}`;
  if (
    billing.memberLimitOverrideCount !== null &&
    Number.isFinite(billing.memberLimitOverrideCount) &&
    billing.memberLimitOverrideCount > 0
  ) {
    return `${base} · ${billing.memberLimitOverrideCount} with a per-member limit override`;
  }
  return base;
}

export function CursorTeamBillingCardView({ data }: { data: CursorTeamBilling }) {
  const known = data.unavailableReason === null && data.source !== "unavailable";
  const spend = money(data.spendValue, data.spendUnit);
  const limit = money(data.hardLimitValue, data.hardLimitUnit);
  const usageSpend = money(data.usageSpendValue, data.usageSpendUnit);
  const members = membersText(data);
  const cycle = cycleText(data);
  return (
    <div
      data-testid="cursor-team-billing"
      data-reason={data.unavailableReason ?? undefined}
      data-configured={data.configured ? "true" : "false"}
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs"
    >
      <span className="uppercase tracking-wider text-white/30">Cursor team billing</span>
      <span
        className="rounded border border-white/10 px-1.5 py-0.5 text-white/35"
        title="Official Cursor Admin API — team-level billing, not individual runtime quota"
      >
        Admin API
      </span>
      {known ? (
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-white/70">
          {spend && (
            <span data-testid="cursor-team-spend" title={`Team spend ${spend}${limit ? ` of ${limit} hard limit` : ""}`}>
              Spend {spend}
              {limit && <span className="text-white/40"> of {limit} hard limit</span>}
            </span>
          )}
          {!spend && limit && (
            <span data-testid="cursor-team-spend" title={`Hard limit ${limit}`}>
              Hard limit {limit}
            </span>
          )}
          {cycle && (
            <span data-testid="cursor-team-cycle" className="text-white/40">
              cycle {cycle}
            </span>
          )}
          {members && (
            <span
              data-testid="cursor-team-members"
              className="text-white/40"
              title="Team size and per-member limit overrides as reported — never summed into a team total"
            >
              {members}
            </span>
          )}
          {usageSpend && (
            <span data-testid="cursor-team-usage" className="text-white/40" title="Summed trailing-window usage spend as reported">
              trailing usage {usageSpend}
            </span>
          )}
        </span>
      ) : (
        <span
          data-testid="cursor-team-billing-na"
          className="text-white/35"
          title={`N/A (${REASON_TEXT[data.unavailableReason ?? "missing"]})`}
        >
          N/A ({REASON_TEXT[data.unavailableReason ?? "missing"]})
          {!data.configured && (
            <span className="ml-1 text-white/25">— set CURSOR_ADMIN_API_KEY to enable</span>
          )}
        </span>
      )}
    </div>
  );
}

/** Self-loading card: fetches team billing once per mount/refresh tick. */
export default function CursorTeamBillingCard({ refreshTick }: { refreshTick?: number }) {
  const [data, setData] = useState<CursorTeamBilling | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchCursorTeamBilling()
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
  return <CursorTeamBillingCardView data={data} />;
}
