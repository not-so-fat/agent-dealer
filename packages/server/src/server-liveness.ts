// packages/server/src/server-liveness.ts
//
// A liveness marker the server writes for *itself*, directly from its own entrypoint
// (index.ts), independent of how it was launched. This exists because the only prior
// liveness signal — packages/cli/src/runtime-state.ts's run.json — is written solely by
// the packaged CLI's daemon supervisor (`agent-dealer start`). The documented `npm run
// dev` and `npm run start` paths invoke this package's entrypoint directly and never go
// through that supervisor, so a check that only looked at run.json (as
// db/migrate-to-issues.ts's isServiceRunning() originally did) silently reported "not
// running" for the two most common ways this app is actually launched during development
// and self-hosted production use — the migration script's core safety promise ("refuses
// to run against a live service") was a no-op for those paths. Writing this file from the
// server's own main(), before it touches the database, makes the guard hold in every
// launch mode: dev, `npm start`, and the CLI daemon (which runs this exact same entrypoint
// as a spawned child).
import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "./db/index.js";

export interface ServerLivenessState {
  pid: number;
  port: number;
  startedAt: string;
}

export function serverPidFilePath(): string {
  return path.join(getDataDir(), "server.pid");
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

function readRecordedPid(filePath: string): number | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(filePath, "utf8")) as { pid?: unknown };
    return typeof state.pid === "number" ? state.pid : null;
  } catch {
    return null;
  }
}

/**
 * Claims the marker for this process — but never by clobbering a different, still-alive
 * owner. Two servers launched against the same AGENT_DEALER_HOME (e.g. two direct `npm run
 * dev` invocations racing the same port) must not corrupt each other's liveness signal: a
 * plain unconditional overwrite would let the loser's write replace the winner's pid, and
 * the loser's later cleanup would then delete the marker out from under a still-healthy
 * winner — reopening the exact live-service race this file exists to close. `wx` makes the
 * create atomic; on EEXIST, a *stale* marker (dead pid, or unreadable) is safe to reclaim,
 * but a live different pid means this process backs off and returns false without touching
 * the file at all.
 */
export function writeServerPidFile(port: number): boolean {
  const filePath = serverPidFilePath();
  const state: ServerLivenessState = { pid: process.pid, port, startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(filePath, JSON.stringify(state, null, 2), { flag: "wx" });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const recordedPid = readRecordedPid(filePath);
      if (recordedPid !== null && recordedPid !== process.pid && isPidAlive(recordedPid)) {
        return false; // a different, live owner holds this marker — do not touch it
      }
      // Stale — dead pid or unreadable content. Safe to reclaim; loop once to retry the
      // exclusive create (a concurrent reclaimer racing the same stale file is the only
      // way this second attempt can itself hit EEXIST again, which just falls through to
      // returning false below rather than looping forever).
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* another process may have already removed or reclaimed it — fine either way */
      }
    }
  }
  return false;
}

/** Removes the marker only if it currently names *this* process — never a different
 * (possibly still-alive) owner's marker, including one left behind after this process
 * lost the write race in writeServerPidFile() and therefore never actually owned it. */
export function removeServerPidFile(): void {
  const filePath = serverPidFilePath();
  if (readRecordedPid(filePath) !== process.pid) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    // already gone — fine on a second cleanup call
  }
}
