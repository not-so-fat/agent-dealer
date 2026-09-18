// packages/server/src/direct-start-temp-home-cleanup.test.ts
//
// NOT-140: interrupt path must reap temp AGENT_DEALER_HOME dirs (process.exit skips
// t.after), and a guarded one-time sweep must clear abandoned dealer-direct-start-* debris.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DirectStartLiveCleanup,
  DEFAULT_RECENT_MS,
  sweepAbandonedDirectStartHomes,
} from "./direct-start-temp-home-cleanup.js";

function makeStaleHome(tmpDir: string, name: string, ageMs: number): string {
  const home = path.join(tmpDir, name);
  fs.mkdirSync(home);
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(home, when, when);
  return home;
}

test("DirectStartLiveCleanup.reapAll removes tracked homes after signalling servers", () => {
  const cleanup = new DirectStartLiveCleanup();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-direct-start-reap-"));
  cleanup.trackHome(home);
  fs.writeFileSync(path.join(home, "marker"), "alive");

  const signalled: unknown[] = [];
  cleanup.reapAll((child, signal) => {
    signalled.push({ child, signal });
  });

  assert.equal(fs.existsSync(home), false, "tracked home must be rmSync'd on reap");
  assert.equal(cleanup.homes.size, 0);
  assert.equal(cleanup.servers.size, 0);
  assert.deepEqual(signalled, []);
});

test("sweepAbandonedDirectStartHomes removes stale homes without a live server.pid", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-sweep-root-"));
  const stale = path.join(tmpDir, "dealer-direct-start-stale");
  fs.mkdirSync(stale);
  fs.writeFileSync(path.join(stale, "dealer.db"), "");
  // utimes after writes — creating children bumps the directory mtime.
  const when = new Date(Date.now() - (DEFAULT_RECENT_MS + 5_000));
  fs.utimesSync(stale, when, when);

  const result = sweepAbandonedDirectStartHomes(tmpDir, {
    now: Date.now(),
    recentMs: DEFAULT_RECENT_MS,
    isPidAlive: () => false,
  });

  assert.equal(fs.existsSync(stale), false);
  assert.deepEqual(result.removed, [stale]);
  assert.deepEqual(result.skipped, []);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("sweepAbandonedDirectStartHomes skips a home whose server.pid names a live process", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-sweep-root-"));
  const liveHome = path.join(tmpDir, "dealer-direct-start-live");
  fs.mkdirSync(liveHome);
  fs.writeFileSync(path.join(liveHome, "server.pid"), JSON.stringify({ pid: 424242 }));
  const when = new Date(Date.now() - (DEFAULT_RECENT_MS + 5_000));
  fs.utimesSync(liveHome, when, when);

  const result = sweepAbandonedDirectStartHomes(tmpDir, {
    now: Date.now(),
    recentMs: DEFAULT_RECENT_MS,
    isPidAlive: (pid) => pid === 424242,
  });

  assert.equal(fs.existsSync(liveHome), true, "must not delete out from under a live server");
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.skipped, [liveHome]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("sweepAbandonedDirectStartHomes skips a recently-modified home", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-sweep-root-"));
  const fresh = makeStaleHome(tmpDir, "dealer-direct-start-fresh", 1_000);

  const result = sweepAbandonedDirectStartHomes(tmpDir, {
    now: Date.now(),
    recentMs: DEFAULT_RECENT_MS,
    isPidAlive: () => false,
  });

  assert.equal(fs.existsSync(fresh), true, "must not delete a home still in use by a run in flight");
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.skipped, [fresh]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("sweepAbandonedDirectStartHomes ignores directories that do not use the dealer-direct-start- prefix", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-sweep-root-"));
  const other = makeStaleHome(tmpDir, "dealer-paths-unrelated", DEFAULT_RECENT_MS + 5_000);

  const result = sweepAbandonedDirectStartHomes(tmpDir, {
    now: Date.now(),
    recentMs: DEFAULT_RECENT_MS,
    isPidAlive: () => false,
  });

  assert.equal(fs.existsSync(other), true);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.skipped, []);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
