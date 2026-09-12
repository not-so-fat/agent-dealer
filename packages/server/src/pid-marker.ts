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
import Database from "better-sqlite3";

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

/**
 * Runs `fn` under a real OS-level advisory lock scoped to this marker, via a tiny
 * dedicated SQLite file (`<filePath>.arbiter`) and a `BEGIN EXCLUSIVE` transaction —
 * not a hand-rolled lock *file*, which would face the exact same "check it, decide it's
 * stale, delete it, recreate it" race this exists to close, just one level further down
 * (a prior version of this code tried exactly that with a `.reclaim-lock` file, and it
 * had the identical bug: two processes could both observe the lock file as abandoned and
 * both "steal" it, one destroying the other's fresh claim).
 *
 * SQLite's `BEGIN EXCLUSIVE` acquires a real filesystem advisory lock (fcntl/flock under
 * the hood in rollback-journal mode) that a second connection's own `BEGIN EXCLUSIVE`
 * genuinely blocks on — `busy_timeout` only bounds how long a live contender waits its
 * turn. Critically, this sidesteps the entire "how do I tell a stale lock from a held one"
 * problem: if the holding process dies for any reason (including a crash), the OS
 * releases the underlying advisory lock immediately, so there is no lease/timeout
 * heuristic to get wrong here at all.
 */
function withArbiterLock<T>(filePath: string, fn: () => T): T {
  const db = new Database(`${filePath}.arbiter`);
  try {
    db.pragma("busy_timeout = 3000");
    return db.transaction(fn).exclusive();
  } finally {
    db.close();
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
 * marker is different: "read it, decide it's dead, replace it" is not one atomic step on
 * its own, so the decide-and-replace sequence runs under withArbiterLock — a real OS-level
 * advisory lock, not a second hand-rolled lock file with the same race one level down.
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

  // Stale (dead pid) or unreadable — the destructive replace happens under the arbiter
  // lock, not on the strength of the read above alone.
  return withArbiterLock(filePath, () => {
    // Re-check under the lock: the marker may have been legitimately reclaimed by whoever
    // held this lock just before us.
    const ownerUnderLock = readPidMarkerOwner(filePath);
    if (ownerUnderLock && ownerUnderLock.pid !== process.pid && ownerUnderLock.alive) {
      return false;
    }
    // No `wx` here: holding the arbiter lock is what makes this replace exclusive, not the
    // create flag — the destination may legitimately still exist (the stale file itself).
    fs.writeFileSync(filePath, payload);
    return true;
  });
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
