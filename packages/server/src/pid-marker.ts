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

/**
 * Claims the marker for this process (process.pid), refusing only when a *different*,
 * still-alive pid already holds it. A stale marker (dead pid, or unreadable content) is
 * reclaimed rather than treated as a blocker — a crashed prior owner must never
 * permanently wedge this lock. `extra` fields (e.g. `port`, `role`) are merged into the
 * written state alongside `pid`/`startedAt`.
 *
 * The create itself is atomic (`wx`: fails with EEXIST rather than silently overwriting),
 * so two processes racing this same call cannot both believe they claimed it — only one
 * `writeFileSync` with `wx` can win when the file did not previously exist; the loser
 * always observes EEXIST and falls through to the live-owner check.
 */
export function claimPidMarker(filePath: string, extra: Record<string, unknown> = {}): boolean {
  const state = { pid: process.pid, startedAt: new Date().toISOString(), ...extra };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(filePath, JSON.stringify(state, null, 2), { flag: "wx" });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const owner = readPidMarkerOwner(filePath);
      if (owner && owner.pid !== process.pid && owner.alive) {
        return false; // a different, live owner holds this marker — do not touch it
      }
      // Stale (dead pid) or unreadable — safe to reclaim. Loop once to retry the atomic
      // create; a concurrent reclaimer racing this same stale file is the only way the
      // second attempt can itself hit EEXIST again, which just falls through to false
      // below rather than looping forever.
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* another process may have already removed or reclaimed it — fine either way */
      }
    }
  }
  return false;
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
