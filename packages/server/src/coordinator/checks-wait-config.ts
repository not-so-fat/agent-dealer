// packages/server/src/coordinator/checks-wait-config.ts
//
// NOT-311: how long one work item may wait on CI before the wait itself escalates.
// The per-poll bound (CHECKS_POLL_TIMEOUT_MS, default 10 min) only ends a single
// poll with a `checks_pending` deferral; this ceiling bounds the whole wait measured
// from the first poll, across deferrals. Past it the item stops re-queueing and a
// human is asked to look at the stuck CI run instead of waiting forever.

/** Overall CI-wait ceiling measured from the first checks poll (default 2 h). */
export function checksWaitCeilingMs(): number {
  const parsed = Number(process.env.CHECKS_WAIT_CEILING_MS ?? 2 * 60 * 60_000);
  return Number.isFinite(parsed) ? parsed : 2 * 60 * 60_000;
}

/** True once `nowMs` is at or past the ceiling after the first wait started. */
export function checksWaitCeilingExceeded(firstWaitStartedAt: string, nowMs = Date.now()): boolean {
  const start = Date.parse(firstWaitStartedAt);
  if (!Number.isFinite(start)) return false;
  return nowMs - start >= checksWaitCeilingMs();
}
