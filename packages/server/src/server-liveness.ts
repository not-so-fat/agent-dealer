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
//
// Thin wrapper over pid-marker.ts's generic exclusive-claim primitive — see that module
// for why the claim/release semantics are ownership-aware rather than a plain overwrite,
// and for why the migration script (db/migrate-to-issues.ts) claims this *same* file for
// the duration of a cutover.
import path from "node:path";
import { getDataDir } from "./db/index.js";
import { claimPidMarker, releasePidMarker } from "./pid-marker.js";

export function serverPidFilePath(): string {
  return path.join(getDataDir(), "server.pid");
}

/** Claims the marker for this server process. A false return means a different, live
 * process already owns this AGENT_DEALER_HOME — the caller (index.ts) must treat that as
 * fatal and refuse to start, not merely warn and continue, or this server would run
 * fully unmonitored: untracked by the marker, invisible to isServiceRunning(), and free
 * to write to the same database a migration might concurrently believe is safe to touch. */
export function writeServerPidFile(port: number): boolean {
  return claimPidMarker(serverPidFilePath(), { port });
}

export function removeServerPidFile(): void {
  releasePidMarker(serverPidFilePath());
}
