// packages/server/src/coordinator/clock-jump.ts
//
// NOT-125: tell "the host was suspended" apart from "the worker went silent".
//
// The coordinator measures lease liveness against `Date.now()`. When the host sleeps no
// timer fires, but wall-clock keeps advancing — so on wake every in-flight lease is already
// expired and the very first tick reclaims all of them at once.
//
// What identifies that wake is a gap the coordinator did not live through. Two measurements
// of the same gap are taken (see `observeClockJump`) because the obvious one — wall-clock
// against a monotonic clock — is only reliable where the monotonic clock actually stops
// during suspend, which is not guaranteed on macOS.
//
// This is defence-in-depth for the pid-liveness gate (NOT-124), not a replacement for it:
// liveness evidence only exists for work this host spawned and can signal, while a clock
// jump is observable for every lease — including future runtimes with no local pid at all.
const num = (name: string, dflt: number): number => Number(process.env[name] ?? dflt);

export interface ClockJump {
  /** Wall-clock ms at the tick that observed the jump — leases from before this are protected. */
  detectedAt: number;
  /** No lease that predates the jump may be reclaimed until this wall-clock time. */
  graceUntil: number;
  /** How far wall-clock moved across the gap. */
  wallGapMs: number;
  /** The part of the gap the monotonic clock did NOT see. Zero on a platform whose
   *  monotonic clock keeps counting through suspend — which is why it is not the only signal. */
  unelapsedMs: number;
  /** How much longer the gap was than the tick that should have closed it. */
  unobservedMs: number;
}

/**
 * A gap must exceed this before it counts as a suspension rather than ordinary scheduling
 * noise. A late tick or a long GC pause is sub-second; a real sleep is seconds-to-hours.
 */
function jumpThresholdMs(): number {
  return num(
    "COORDINATOR_CLOCK_JUMP_THRESHOLD_MS",
    Math.max(num("COORDINATOR_POLL_INTERVAL_MS", 3_000) * 2, 5_000)
  );
}

/** How long a tick should take. A gap materially longer than this means the poll timer did
 *  not fire, so the coordinator observed nothing of what happened in between. */
function expectedGapMs(): number {
  return num("COORDINATOR_POLL_INTERVAL_MS", 3_000);
}

/** The grace window granted after a jump — one full lease, so a live worker's heartbeat
 *  (which resumes on wake) has a complete cycle to renew before anything is reclaimed. */
function graceMs(): number {
  return num("COORDINATOR_LEASE_MS", 60_000);
}

let lastWall: number | null = null;
let lastMonotonic: number | null = null;
let activeJump: ClockJump | null = null;

/**
 * Samples both clocks for this tick and reports a jump the first time one is seen.
 *
 * @returns the newly detected jump, or null. Only ever non-null on the tick that observes
 *          it, so the caller can log once per suspension rather than once per tick.
 */
export function observeClockJump(opts?: { now?: number; monotonic?: number }): ClockJump | null {
  const now = opts?.now ?? Date.now();
  const monotonic = opts?.monotonic ?? performance.now();

  const prevWall = lastWall;
  const prevMonotonic = lastMonotonic;
  lastWall = now;
  lastMonotonic = monotonic;
  if (prevWall === null || prevMonotonic === null) return null; // first tick — no baseline yet

  const wallGapMs = now - prevWall;
  const monotonicGapMs = monotonic - prevMonotonic;

  // Two independent signals, because neither is sufficient alone:
  //
  // 1. Time the monotonic clock never saw. This is the ticket's signal, and it is the
  //    right one for a wall-clock STEP (an NTP correction) where timers kept firing. But
  //    it reads zero on any platform whose monotonic clock counts through suspend —
  //    libuv uses mach_continuous_time() on some Darwin versions — so relying on it alone
  //    would mean shipping a sleep detector that detects no sleep on the very laptop this
  //    was written for.
  // 2. Time the poll loop never observed: the gap between two ticks of a 3s interval was
  //    far longer than 3s, so the timer did not fire. Whatever the cause — suspend, a
  //    stepped clock, a wedged event loop — the coordinator was not running, and so the
  //    heartbeats that would have renewed these leases were not running either. That is
  //    precisely the condition under which an expired lease proves nothing.
  const unelapsedMs = wallGapMs - monotonicGapMs;
  const unobservedMs = wallGapMs - expectedGapMs();
  if (Math.max(unelapsedMs, unobservedMs) <= jumpThresholdMs()) return null;

  // Each detection restarts the grace window. A host sleeping more often than once per
  // grace window would keep deferring a genuinely dead worker's reclaim — but such a host
  // is barely awake enough to run anything, and the reclaim is delayed, never skipped.
  activeJump = { detectedAt: now, graceUntil: now + graceMs(), wallGapMs, unelapsedMs, unobservedMs };
  return activeJump;
}

/**
 * The jump whose grace window still covers `now`, or null. A lease that expired at or
 * before `detectedAt` was healthy when the host went down, so it is not reclaimable until
 * `graceUntil` — by which point a worker that really is alive has heartbeated and a worker
 * that really is gone has had a full lease window to prove it.
 */
export function activeClockJumpGrace(now: number = Date.now()): ClockJump | null {
  if (!activeJump) return null;
  if (now >= activeJump.graceUntil) {
    activeJump = null;
    return null;
  }
  return activeJump;
}

/** Tests only — drops the clock baseline and any in-flight grace window. */
export function resetClockJumpState(): void {
  lastWall = null;
  lastMonotonic = null;
  activeJump = null;
}
