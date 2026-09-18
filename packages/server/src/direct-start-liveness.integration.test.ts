// packages/server/src/direct-start-liveness.integration.test.ts
//
// Reproduces the exact reviewer-reported gap: `npm run dev` / `npm run start` launch
// packages/server/src/index.ts directly, bypassing the CLI daemon supervisor that writes
// run.json — so a liveness check that only looked at run.json silently reported "not
// running" for the two most common ways this app is actually launched. This spawns that
// real entrypoint (not a fake), the same way `npm run dev` does, and drives
// migrate-to-issues.ts's isServiceRunning() against it end to end.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { resolveTsxBin } from "./resolve-tsx-bin.js";
import {
  DirectStartLiveCleanup,
  sweepAbandonedDirectStartHomes,
} from "./direct-start-temp-home-cleanup.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const serverEntry = path.join(repoRoot, "packages", "server", "src", "index.ts");

const tsxBin = resolveTsxBin(repoRoot);

const { isServiceRunning, runMigration } = await import("./db/migrate-to-issues.js");
const Database = (await import("better-sqlite3")).default;

// One-time sweep of abandoned dealer-direct-start-* homes left by earlier interrupted
// runs. Live-pid + recent-mtime guards keep this from deleting out from under a run
// that is still in flight on this machine (NOT-140).
sweepAbandonedDirectStartHomes(os.tmpdir());

async function getEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not allocate an ephemeral port")));
      }
    });
    srv.on("error", reject);
  });
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs: number, stepMs = 150): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// Every server spawned by this file that stopServer() has not yet confirmed dead, plus
// every temp home makeHome() still owns. A detached child sits in its own session, so it
// no longer receives the terminal's SIGINT along with the test runner — the usual
// "Ctrl-C reaps the whole foreground group" safety net does not cover these, and an
// interrupted run would leak exactly what this file was leaking before. This registry is
// that net, re-implemented explicitly — servers and homes share one reapAll so
// process.exit(1) cannot clear one and abandon the other (NOT-140).
const liveCleanup = new DirectStartLiveCleanup();

function reapAllLiveCleanup(): void {
  liveCleanup.reapAll(signalGroup);
}

process.on("exit", reapAllLiveCleanup);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  // Registering a listener suppresses the default terminate, so exit explicitly.
  process.on(signal, () => {
    reapAllLiveCleanup();
    process.exit(1);
  });
}

/** A temp AGENT_DEALER_HOME that is deleted when the test ends, however it ends. Registered
 * as a test hook rather than dropped in a `finally` on purpose: teardown here asserts (that
 * the server it stopped is really dead), and an assertion that throws must not be able to
 * skip the cleanup and leave a directory behind — which is precisely how $TMPDIR filled up
 * with hundreds of these. Runs after the body's own `finally`, so servers are stopped by
 * then. The interrupt path (SIGINT/SIGTERM/SIGHUP → process.exit) skips t.after, so the
 * home is also tracked on `liveCleanup` and reaped there (NOT-140). */
function makeHome(t: TestContext, prefix: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  liveCleanup.trackHome(home);
  t.after(() => {
    liveCleanup.untrackHome(home);
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
}

function spawnServer(home: string, port: number) {
  const child = spawn(tsxBin, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AGENT_DEALER_HOME: home,
      AGENT_DEALER_ENV: "development",
      PORT: String(port),
    },
    stdio: "ignore",
    // The launcher and the child it forks get their own process group (pgid == launcher
    // pid), so stopServer() can signal both at once.
    detached: true,
  });
  // Every test awaits its own teardown, so this handle is never what keeps the run
  // correct — but while it is ref'd it *does* keep the runner's event loop alive, so a
  // teardown that throws before stopping a server wedges the whole file at 100% "waiting
  // for a child that will never exit" instead of failing. unref() + reapAllLiveCleanup()
  // on exit is the pair that makes the failure path terminate and still reap.
  child.unref();
  liveCleanup.addServer(child);
  return child;
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The process group `pid` belongs to, or undefined once it is gone. */
function pgidOf(pid: number): number | undefined {
  try {
    const pgid = Number.parseInt(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim(), 10);
    return Number.isFinite(pgid) ? pgid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The pid recorded in `<home>/server.pid`, but only when that pid is part of `child`'s
 * process group — i.e. only when this particular server is the marker's current owner.
 *
 * These tests deliberately point two servers at one AGENT_DEALER_HOME, and the loser never
 * writes the marker, so "the pid in server.pid" is emphatically *not* "the pid of the
 * server I am holding a handle to". Signalling or asserting on it unconditionally would
 * reach across to the healthy server the test is still using.
 */
function ownedRecordedPid(child: ChildProcess, home: string): number | undefined {
  if (child.pid === undefined) return undefined;
  let recorded: unknown;
  try {
    recorded = (JSON.parse(fs.readFileSync(path.join(home, "server.pid"), "utf8")) as { pid?: unknown }).pid;
  } catch {
    return undefined; // no marker (never claimed, or already released on a clean exit)
  }
  if (typeof recorded !== "number" || !Number.isFinite(recorded)) return undefined;
  return pgidOf(recorded) === child.pid ? recorded : undefined;
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // ESRCH — the whole group is already gone, which is exactly what we were after.
  }
}

interface StopResult {
  /** True when the group was gone within 10s of SIGTERM, with no SIGKILL backstop needed. */
  exitedOnTerm: boolean;
  /** The pid this server recorded in `<home>/server.pid`, when it owned that marker. */
  recordedPid?: number;
}

/**
 * The one place in this file that knows how to terminate a server spawned by
 * spawnServer() — every case goes through it, so this knowledge is not re-derived per test.
 *
 * spawnServer() launches `node_modules/.bin/tsx`, not node, and that bin *forks a child* to
 * actually run the TypeScript: `child.pid` is the launcher, and the real server is its
 * grandchild. tsx forwards a catchable SIGTERM but cannot forward an unblockable SIGKILL,
 * so `child.kill("SIGKILL")` reaps the launcher and leaves the server alive, reparented to
 * init, still bound to its PORT — forever. (pid-marker-hold-arbiter-child.ts documents the
 * same wrapper behaviour for the same reason.) Hence: signal the whole process group,
 * SIGTERM first so the server can release its own marker, SIGKILL only as a backstop, and
 * then prove the pid the server actually recorded is dead rather than trusting the launcher
 * handle's exit code to speak for it.
 */
async function stopServer(child: ChildProcess, home: string): Promise<StopResult> {
  // Read while the server is still alive: a clean shutdown deletes the marker.
  const recordedPid = ownedRecordedPid(child, home);
  const allDead = () => hasExited(child) && (recordedPid === undefined || !isPidAlive(recordedPid));

  signalGroup(child, "SIGTERM");
  const exitedOnTerm = await waitUntil(allDead, 10000);
  if (!exitedOnTerm) {
    signalGroup(child, "SIGKILL");
    await waitUntil(allDead, 5000);
  }

  if (recordedPid !== undefined) {
    assert.equal(
      isPidAlive(recordedPid),
      false,
      `the server pid recorded in server.pid (${recordedPid}) survived teardown — the tsx launcher (${child.pid}) was reaped but its server child leaked`
    );
  }
  liveCleanup.removeServer(child);
  return { exitedOnTerm, recordedPid };
}

async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  return waitUntil(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }, timeoutMs);
}

test(
  "a directly-launched server (npm run dev's exact entrypoint) is detected as running, and stops being detected once it exits",
  { timeout: 45000 },
  async (t) => {
    const home = makeHome(t, "dealer-direct-start-");
    const dbPath = path.join(home, "dealer.db");
    const port = await getEphemeralPort();

    const child = spawnServer(home, port);

    try {
      const healthy = await waitForHealth(port, 20000);
      assert.ok(healthy, "the directly-launched server should become healthy within 20s");

      const running = isServiceRunning(dbPath);
      assert.equal(running.running, true, "a directly-launched server should be detected as running");
      assert.ok(running.detail?.includes("server.pid"), `expected server.pid evidence, got: ${running.detail}`);

      const { exitedOnTerm } = await stopServer(child, home);
      assert.ok(exitedOnTerm, "the server should exit within 10s of SIGTERM");

      const stopped = await waitUntil(() => !isServiceRunning(dbPath).running, 5000);
      assert.ok(stopped, "the server should no longer be detected as running once it has exited");
    } finally {
      await stopServer(child, home);
    }
  }
);

test(
  "a second server losing the port race does not corrupt or delete the first server's liveness marker",
  { timeout: 45000 },
  async (t) => {
    // Reproduces the reviewer's exact second-round finding: two real index.ts launches
    // sharing one AGENT_DEALER_HOME and port. Before the ownership-aware fix, B's write
    // clobbered A's marker with B's own (dead-after-exit) pid, and B's unconditional exit
    // cleanup then deleted it — leaving a healthy A with no liveness marker at all.
    const home = makeHome(t, "dealer-direct-start-race-");
    const dbPath = path.join(home, "dealer.db");
    const port = await getEphemeralPort();

    const serverA = spawnServer(home, port);
    let serverB: ReturnType<typeof spawnServer> | undefined;
    let serverAActualPid: number | undefined;

    try {
      const aHealthy = await waitForHealth(port, 20000);
      assert.ok(aHealthy, "server A should become healthy within 20s");

      // The marker's own recorded pid is the real process.pid inside index.ts, which is
      // *not* necessarily serverA.pid: the tsx bin wrapper spawn() returns forks a child
      // to actually run the TypeScript, so serverA.pid is the launcher, not the server.
      // Compare against this recorded value, not serverA.pid, for that reason — and, just
      // as importantly, signal that value too (stopServer()), not serverA.pid.
      const stateBeforeB = JSON.parse(fs.readFileSync(path.join(home, "server.pid"), "utf8"));
      serverAActualPid = stateBeforeB.pid;
      assert.ok(Number.isFinite(serverAActualPid));

      // Same home, same port — B can only ever lose the app.listen() race.
      serverB = spawnServer(home, port);
      const bExited = await waitUntil(
        () => serverB!.exitCode !== null || serverB!.signalCode !== null,
        20000
      );
      assert.ok(bExited, "server B should exit (losing the port bind) within 20s");
      assert.notEqual(serverB.exitCode, 0, "server B should exit non-zero, having failed to bind the port");

      // A must still be healthy, and the marker must still be A's — never overwritten by
      // B, and never deleted by B's own exit cleanup.
      const aStillHealthy = await waitForHealth(port, 5000);
      assert.ok(aStillHealthy, "server A should remain healthy after B's failed launch and exit");

      const running = isServiceRunning(dbPath);
      assert.equal(running.running, true, "the migration guard must still see server A as running");
      const stateAfterB = JSON.parse(fs.readFileSync(path.join(home, "server.pid"), "utf8"));
      assert.equal(stateAfterB.pid, serverAActualPid, "the marker must still name server A, not server B");
    } finally {
      if (serverB) await stopServer(serverB, home);
      // A is healthy and unsignalled at this point, so this teardown is the *only* thing
      // between it and outliving the test run: it must reach the real server, not the
      // launcher (see stopServer()).
      const { recordedPid } = await stopServer(serverA, home);
      if (serverAActualPid !== undefined) {
        assert.equal(recordedPid, serverAActualPid, "teardown must have signalled server A's own recorded pid, not the launcher's");
      }
    }
  }
);

test(
  "a second server on a different port is refused at startup rather than running unmonitored",
  { timeout: 45000 },
  async (t) => {
    // Reproduces the reviewer's exact third-round finding: with a *different* port, B is
    // no longer stopped by app.listen()'s EADDRINUSE. Before treating a failed claim as
    // fatal, B ran to completion fully healthy but untracked (A owns server.pid), so once
    // A stopped — correctly removing its own marker — B kept running with no liveness
    // marker at all, and isServiceRunning() returned false despite B being very much alive.
    const home = makeHome(t, "dealer-direct-start-diffport-");
    const dbPath = path.join(home, "dealer.db");
    const portA = await getEphemeralPort();
    const portB = await getEphemeralPort();

    const serverA = spawnServer(home, portA);
    let serverB: ReturnType<typeof spawnServer> | undefined;

    try {
      const aHealthy = await waitForHealth(portA, 20000);
      assert.ok(aHealthy, "server A should become healthy within 20s");
      const stateBeforeB = JSON.parse(fs.readFileSync(path.join(home, "server.pid"), "utf8"));

      serverB = spawnServer(home, portB);
      const bExited = await waitUntil(
        () => serverB!.exitCode !== null || serverB!.signalCode !== null,
        20000
      );
      assert.ok(bExited, "server B should exit within 20s of failing to claim the liveness marker");
      assert.notEqual(serverB.exitCode, 0, "server B should exit non-zero, having refused to start");

      // B must never have become healthy on its own port — it should have aborted before
      // ever reaching app.listen().
      const bEverHealthy = await waitUntil(async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${portB}/health`);
          return res.ok;
        } catch {
          return false;
        }
      }, 1500);
      assert.equal(bEverHealthy, false, "server B must never have started serving on its own port");

      // A is unaffected, and the marker still names A.
      const aStillHealthy = await waitForHealth(portA, 5000);
      assert.ok(aStillHealthy);
      const stateAfterB = JSON.parse(fs.readFileSync(path.join(home, "server.pid"), "utf8"));
      assert.equal(stateAfterB.pid, stateBeforeB.pid);

      assert.equal(isServiceRunning(dbPath).running, true);

      // And once A stops (removing its own marker as intended), isServiceRunning correctly
      // reports nothing running — B never having claimed the marker means there is no
      // now-invisible second server left behind for this check to miss.
      const { exitedOnTerm } = await stopServer(serverA, home);
      assert.ok(exitedOnTerm, "server A should exit within 10s of SIGTERM");
      assert.equal(isServiceRunning(dbPath).running, false, "nothing should be left running or tracked after A stops");
    } finally {
      if (serverB) await stopServer(serverB, home);
      await stopServer(serverA, home);
    }
  }
);

test(
  "a real running server blocks the migration end to end, and the migration succeeds once the server is stopped",
  { timeout: 45000 },
  async (t) => {
    const home = makeHome(t, "dealer-direct-start-migration-");
    const dbPath = path.join(home, "dealer.db");
    const port = await getEphemeralPort();

    const server = spawnServer(home, port);
    try {
      const healthy = await waitForHealth(port, 20000);
      assert.ok(healthy, "the server should become healthy within 20s (this also runs migrate(), creating the schema)");

      // Seed one legacy lineage directly — a separate connection to the same file is fine
      // alongside the server's own WAL-mode connection.
      const now = new Date().toISOString();
      const seedDb = new Database(dbPath);
      seedDb
        .prepare(
          `INSERT INTO runs (id, source, external_id, task_category, title, repo, agent_id, status,
            lineage_id, created_at, updated_at)
           VALUES ('run-live-block', 'manual', 'run-live-block', 'code', 'Blocked task', '/repo', NULL, 'done', NULL, ?, ?)`
        )
        .run(now, now);
      seedDb.close();

      const refused = runMigration(dbPath);
      assert.ok(refused.mismatches.length > 0);
      assert.match(refused.mismatches[0], /service is running/);
      assert.equal(fs.existsSync(`${dbPath}.pre-issue-migration-backup`), false);

      const { exitedOnTerm } = await stopServer(server, home);
      assert.ok(exitedOnTerm, "the server should exit within 10s of SIGTERM");
      await waitUntil(() => !isServiceRunning(dbPath).running, 5000);

      const succeeded = runMigration(dbPath);
      assert.deepStrictEqual(succeeded.mismatches, []);
      assert.equal(succeeded.issuesCreated, 1);
    } finally {
      await stopServer(server, home);
    }
  }
);

function listOrphanIndexTsPids(): number[] {
  try {
    const out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
    const orphans: number[] = [];
    for (const line of out.split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      const command = match[3];
      if (ppid === 1 && command.includes("packages/server/src/index.ts")) orphans.push(pid);
    }
    return orphans;
  } catch {
    return [];
  }
}

test(
  "SIGINT mid-run leaves zero dealer-direct-start homes from that run and no PPID=1 index.ts orphans",
  { timeout: 60000 },
  async () => {
    // Acceptance for NOT-140: the probe mirrors this file's signal handler (reapAll then
    // process.exit(1)). process.exit skips t.after, so only the shared liveCleanup registry
    // can remove the temp home — and it must still reap the detached server group.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-direct-start-sigint-"));
    const readyFile = path.join(home, "ready.json");
    const port = await getEphemeralPort();
    const probe = path.join(__dirname, "direct-start-interrupt-probe.ts");

    const orphansBefore = new Set(listOrphanIndexTsPids());

    const probeChild = spawn(tsxBin, [probe, home, readyFile, serverEntry, String(port)], {
      cwd: repoRoot,
      stdio: "ignore",
    });

    try {
      const ready = await waitUntil(() => fs.existsSync(readyFile), 15000);
      assert.ok(ready, "interrupt probe should write its ready file");

      const healthy = await waitForHealth(port, 20000);
      assert.ok(healthy, "interrupt probe's server should become healthy before SIGINT");

      probeChild.kill("SIGINT");
      const exited = await waitUntil(
        () => probeChild.exitCode !== null || probeChild.signalCode !== null,
        15000
      );
      assert.ok(exited, "interrupt probe should exit after SIGINT");

      assert.equal(
        fs.existsSync(home),
        false,
        "SIGINT must rmSync the tracked temp home — t.after never runs after process.exit(1)"
      );

      const orphansAfter = listOrphanIndexTsPids().filter((pid) => !orphansBefore.has(pid));
      assert.deepEqual(
        orphansAfter,
        [],
        `SIGINT must not leave packages/server/src/index.ts reparented to init; new orphans: ${orphansAfter.join(",")}`
      );
    } finally {
      if (probeChild.exitCode === null && probeChild.signalCode === null) {
        probeChild.kill("SIGKILL");
      }
      // If the probe failed before reaping, do not leave debris behind for the suite.
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {
        // already gone on the success path
      }
    }
  }
);
