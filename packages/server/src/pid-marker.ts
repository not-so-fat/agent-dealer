// packages/server/src/pid-marker.ts
//
// A generic, path-parameterized exclusive pid marker: a JSON file naming the pid that
// currently "owns" whatever it's guarding, claimed via an atomic exclusive create and
// released only by its own owner. Two independent callers build on this:
//
//   - server-liveness.ts: the server's own entrypoint claims a marker at
//     AGENT_DEALER_HOME/server.pid for its whole running lifetime.
//   - db/migrate-to-issues.ts: the cutover script claims that SAME file for the duration
//     of the migration, so a server trying to start concurrently sees the migration's own
//     (live) pid as the current owner and refuses to start, and the migration's claim
//     itself fails if a server is already running — the same primitive closes the race
//     from both directions instead of one side merely observing the other's state.
//
// Kept path-parameterized (not bound to AGENT_DEALER_HOME/getDataDir()) so the migration
// script — which operates on an arbitrary caller-supplied database path, not necessarily
// this process's own AGENT_DEALER_HOME — can guard the directory the target database
// actually lives in.
import fs from "node:fs";

export interface PidMarkerOwner {
  pid: number;
  alive: boolean;
  raw: Record<string, unknown>;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readRaw(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Whoever currently owns this marker, or null if the file is absent or unreadable.
 * `alive` reflects a live process.kill(pid, 0) probe against the recorded pid — a
 * present-but-stale marker (dead pid) still returns a result, with `alive: false`, so a
 * caller can distinguish "nothing here" from "something here, but it's stale." */
export function readPidMarkerOwner(filePath: string): PidMarkerOwner | null {
  const raw = readRaw(filePath);
  if (!raw) return null;
  const pid = raw.pid;
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return null;
  return { pid, alive: isPidAlive(pid), raw };
}

/** How long a `.reclaim-lock` may sit held before another process is allowed to force it
 * open. This lock is only ever held for the few synchronous statements between reading
 * the main marker and replacing it (microseconds in practice) — the only way it outlives
 * this is its holder crashing mid-decision, an exceedingly narrow window. A lease-style
 * time bound is used here (rather than the main marker's own pid-liveness check) precisely
 * to terminate that recursion: the lock exists so pid-liveness reclaim of the *main*
 * marker is safe, so the lock itself cannot lean on the same mechanism. */
const RECLAIM_LOCK_STALE_MS = 5000;

function reclaimLockPath(filePath: string): string {
  return `${filePath}.reclaim-lock`;
}

/** Acquires the per-marker reclaim lock, stealing it if it looks abandoned (older than
 * RECLAIM_LOCK_STALE_MS). Returns false if someone else currently, genuinely holds it. */
function acquireReclaimLock(filePath: string): boolean {
  const lockPath = reclaimLockPath(filePath);
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  try {
    const age = Date.now() - fs.statSync(lockPath).mtimeMs;
    if (age <= RECLAIM_LOCK_STALE_MS) return false; // held, and recently — genuinely contested
  } catch {
    return false; // vanished mid-check — whoever is racing us gets it, not worth a retry here
  }
  // Old enough to be a crashed holder's leftover — steal it. If someone else steals it in
  // the same instant, exactly one of us wins this final attempt; the other correctly fails.
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* already gone */
  }
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return false;
  }
}

function releaseReclaimLock(filePath: string): void {
  try {
    fs.unlinkSync(reclaimLockPath(filePath));
  } catch {
    /* fine */
  }
}

/**
 * Claims the marker for this process (process.pid), refusing only when a *different*,
 * still-alive pid already holds it. A stale marker (dead pid, or unreadable content) is
 * reclaimed rather than treated as a blocker — a crashed prior owner must never
 * permanently wedge this lock. `extra` fields (e.g. `port`, `role`) are merged into the
 * written state alongside `pid`/`startedAt`.
 *
 * The fast path (nobody home) is a single atomic exclusive create (`wx`), so two processes
 * racing an *absent* marker cannot both believe they claimed it. Reclaiming a *stale*
 * marker is different: "read it, decide it's dead, replace it" is not one atomic step, so
 * two processes racing the same stale marker could otherwise both decide "safe to
 * replace" and the second one's unlink-then-recreate would destroy the first one's
 * already-legitimate fresh claim — both would return true for the same marker. That
 * decide-and-replace sequence is therefore itself serialized through a dedicated
 * `.reclaim-lock` (see acquireReclaimLock), so only one process at a time can be in the
 * "is this stale, should I replace it" step for a given marker.
 */
export function claimPidMarker(filePath: string, extra: Record<string, unknown> = {}): boolean {
  const state = { pid: process.pid, startedAt: new Date().toISOString(), ...extra };
  const payload = JSON.stringify(state, null, 2);

  try {
    fs.writeFileSync(filePath, payload, { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  const owner = readPidMarkerOwner(filePath);
  if (owner && owner.pid !== process.pid && owner.alive) {
    return false; // a different, live owner holds this marker — do not touch it
  }
  if (owner && owner.pid === process.pid) {
    return true; // already ours (e.g. a re-entrant claim) — nothing to replace
  }

  // Stale (dead pid) or unreadable — the destructive replace must happen under the
  // reclaim lock, not on the strength of the read above alone.
  if (!acquireReclaimLock(filePath)) {
    return false; // another process is deciding this exact marker's fate right now
  }
  try {
    // Re-check under the lock: the marker may have been legitimately reclaimed by whoever
    // held this lock just before us.
    const ownerUnderLock = readPidMarkerOwner(filePath);
    if (ownerUnderLock && ownerUnderLock.pid !== process.pid && ownerUnderLock.alive) {
      return false;
    }
    // No `wx` here: holding the reclaim lock is what makes this replace exclusive, not the
    // create flag — the destination may legitimately still exist (the stale file itself).
    fs.writeFileSync(filePath, payload);
    return true;
  } finally {
    releaseReclaimLock(filePath);
  }
}

/** Releases the marker only if it currently names *this* process — never a different
 * (possibly still-alive) owner's marker, including one this process never actually claimed
 * because claimPidMarker() returned false for it. */
export function releasePidMarker(filePath: string): void {
  const owner = readPidMarkerOwner(filePath);
  if (!owner || owner.pid !== process.pid) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    // already gone — fine on a second release call
  }
}
