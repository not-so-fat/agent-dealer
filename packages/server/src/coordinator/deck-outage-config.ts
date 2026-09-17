// packages/server/src/coordinator/deck-outage-config.ts
//
// NOT-136: how long a work item waits between preflights while Agent Deck is unreachable.
//
// The fixed ~3s coordinator backoff is the wrong timescale for a hard-down dependency: four
// attempts in nine seconds burned the whole infra budget during a routine deck restart.
// Exponential backoff keeps a short restart cheap (first retry in seconds) without turning a
// long outage into a tight retry loop.

const num = (name: string, dflt: number): number => {
  const parsed = Number(process.env[name] ?? dflt);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : dflt;
};

/**
 * Backoff for the Nth deferral, where `priorDeferrals` is how many this item has already
 * taken (0 for the first). Doubles from the base and flattens at the cap so a multi-hour
 * outage still re-probes on a predictable cadence.
 */
export function deckOutageBackoffMs(priorDeferrals: number): number {
  const base = num("DECK_OUTAGE_BACKOFF_BASE_MS", 15_000);
  const max = num("DECK_OUTAGE_BACKOFF_MAX_MS", 10 * 60_000);
  const exponent = Math.min(Math.max(0, priorDeferrals), 20);
  return Math.min(max, base * 2 ** exponent);
}

/**
 * After this long the wait stops reading as "the deck is restarting" and the timeline says
 * how long it has been down. Deliberately *not* a deferral ceiling: the item keeps
 * re-preflighting on the capped backoff, so an outage of any length still resolves itself
 * the moment the deck comes back, with no human in the loop.
 */
export function deckOutageProlongedAfterMs(): number {
  return num("DECK_OUTAGE_PROLONGED_AFTER_MS", 15 * 60_000);
}
