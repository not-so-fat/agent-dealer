// packages/server/src/coordinator/usage-cap-config.ts
//
// NOT-111: configurable cooldown when a runtime cap signal lacks a reset timestamp, and a
// ceiling on how long one work item may be deferred before policy escalation.

export function usageCapFallbackCooldownMs(): number {
  return Number(process.env.USAGE_CAP_FALLBACK_COOLDOWN_MS ?? 30 * 60_000);
}

export function usageCapDeferralCeilingMs(): number {
  return Number(process.env.USAGE_CAP_DEFERRAL_CEILING_MS ?? 24 * 60 * 60_000);
}
