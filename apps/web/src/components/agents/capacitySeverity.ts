// Shared remaining-capacity severity for the Agents strip and the top bar
// (NOT-290). Both surfaces classify the raw unrounded remaining percent:
// below 10% is critical (red), 10% to under 30% is a warning (yellow), 30%
// or above is normal. Classification must happen before rounding — rounding
// first would let e.g. 9.6% (critical) read as 10% and 29.6% (warning) read
// as 30%. Styling stays per-surface; this helper only prevents threshold
// drift between them.
export type CapacitySeverity = "critical" | "warning" | "normal";

export function capacitySeverity(remainingPercent: number): CapacitySeverity {
  if (remainingPercent < 10) return "critical";
  if (remainingPercent < 30) return "warning";
  return "normal";
}
