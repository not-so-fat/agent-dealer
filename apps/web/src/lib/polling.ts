// NOT-643: the Issues page live-refresh cadence. Mount and poll run one
// shared loader through this helper so the admission refresh can never drop
// out of either path again the way NOT-228 dropped it; regression tests
// capture the scheduled tick and assert it re-requests admission status.

/** The existing Issues live-panel cadence: refresh every 5 seconds. */
export const ISSUES_POLL_INTERVAL_MS = 5000;

/**
 * Run `load` on the given cadence until the returned cleanup runs. The
 * caller owns the initial (mount) load — this schedules the ticks only, so
 * mounting never double-fetches.
 */
export function startPolling(load: () => void, intervalMs: number): () => void {
  const timer = setInterval(load, intervalMs);
  return () => clearInterval(timer);
}
