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

export function writeServerPidFile(port: number): void {
  const state: ServerLivenessState = { pid: process.pid, port, startedAt: new Date().toISOString() };
  fs.writeFileSync(serverPidFilePath(), JSON.stringify(state, null, 2));
}

export function removeServerPidFile(): void {
  try {
    fs.unlinkSync(serverPidFilePath());
  } catch {
    // already gone — fine on a second cleanup call or a fresh install
  }
}
