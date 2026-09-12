// packages/server/src/direct-start-liveness.integration.test.ts
//
// Reproduces the exact reviewer-reported gap: `npm run dev` / `npm run start` launch
// packages/server/src/index.ts directly, bypassing the CLI daemon supervisor that writes
// run.json — so a liveness check that only looked at run.json silently reported "not
// running" for the two most common ways this app is actually launched. This spawns that
// real entrypoint (not a fake), the same way `npm run dev` does, and drives
// migrate-to-issues.ts's isServiceRunning() against it end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
const serverEntry = path.join(repoRoot, "packages", "server", "src", "index.ts");

const { isServiceRunning, runMigration } = await import("./db/migrate-to-issues.js");
const Database = (await import("better-sqlite3")).default;

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

function spawnServer(home: string, port: number) {
  return spawn(tsxBin, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AGENT_DEALER_HOME: home,
      AGENT_DEALER_ENV: "development",
      PORT: String(port),
    },
    stdio: "ignore",
  });
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
  async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-direct-start-"));
    const dbPath = path.join(home, "dealer.db");
    const port = await getEphemeralPort();

    const child = spawnServer(home, port);

    try {
      const healthy = await waitForHealth(port, 20000);
      assert.ok(healthy, "the directly-launched server should become healthy within 20s");

      const running = isServiceRunning(dbPath);
      assert.equal(running.running, true, "a directly-launched server should be detected as running");
      assert.ok(running.detail?.includes("server.pid"), `expected server.pid evidence, got: ${running.detail}`);

      child.kill("SIGTERM");
      const exited = await waitUntil(() => child.exitCode !== null || child.signalCode !== null, 10000);
      assert.ok(exited, "the server should exit within 10s of SIGTERM");

      const stopped = await waitUntil(() => !isServiceRunning(dbPath).running, 5000);
      assert.ok(stopped, "the server should no longer be detected as running once it has exited");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  }
);

test(
  "a second server losing the port race does not corrupt or delete the first server's liveness marker",
  { timeout: 45000 },
  async () => {
    // Reproduces the reviewer's exact second-round finding: two real index.ts launches
    // sharing one AGENT_DEALER_HOME and port. Before the ownership-aware fix, B's write
    // clobbered A's marker with B's own (dead-after-exit) pid, and B's unconditional exit
    // cleanup then deleted it — leaving a healthy A with no liveness marker at all.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-direct-start-race-"));
    const dbPath = path.join(home, "dealer.db");
    const port = await getEphemeralPort();

    const serverA = spawnServer(home, port);
    let serverB: ReturnType<typeof spawnServer> | undefined;

    try {
      const aHealthy = await waitForHealth(port, 20000);
      assert.ok(aHealthy, "server A should become healthy within 20s");

      // The marker's own recorded pid is the real process.pid inside index.ts, which is
      // *not* necessarily serverA.pid: the tsx bin wrapper spawn() returns forks a child
      // to actually run the TypeScript, so serverA.pid is the launcher, not the server.
      // Compare against this recorded value, not serverA.pid, for that reason.
      const stateBeforeB = JSON.parse(fs.readFileSync(path.join(home, "server.pid"), "utf8"));
      const serverAActualPid: number = stateBeforeB.pid;
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
      if (serverB && serverB.exitCode === null && serverB.signalCode === null) {
        serverB.kill("SIGKILL");
      }
      serverA.kill("SIGKILL");
    }
  }
);

test(
  "a second server on a different port is refused at startup rather than running unmonitored",
  { timeout: 45000 },
  async () => {
    // Reproduces the reviewer's exact third-round finding: with a *different* port, B is
    // no longer stopped by app.listen()'s EADDRINUSE. Before treating a failed claim as
    // fatal, B ran to completion fully healthy but untracked (A owns server.pid), so once
    // A stopped — correctly removing its own marker — B kept running with no liveness
    // marker at all, and isServiceRunning() returned false despite B being very much alive.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-direct-start-diffport-"));
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

      // And once A stops (removing its own marker as intended), isServiceRunning correctly
      // reports nothing running — B never having claimed the marker means there is no
      // now-invisible second server left behind for this check to miss.
      assert.equal(isServiceRunning(dbPath).running, true);
    } finally {
      if (serverB && serverB.exitCode === null && serverB.signalCode === null) {
        serverB.kill("SIGKILL");
      }
      serverA.kill("SIGTERM");
      await waitUntil(() => serverA.exitCode !== null || serverA.signalCode !== null, 10000);
    }
    assert.equal(isServiceRunning(dbPath).running, false, "nothing should be left running or tracked after A stops");
  }
);

test(
  "a real running server blocks the migration end to end, and the migration succeeds once the server is stopped",
  { timeout: 45000 },
  async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-direct-start-migration-"));
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

      server.kill("SIGTERM");
      const exited = await waitUntil(() => server.exitCode !== null || server.signalCode !== null, 10000);
      assert.ok(exited, "the server should exit within 10s of SIGTERM");
      await waitUntil(() => !isServiceRunning(dbPath).running, 5000);

      const succeeded = runMigration(dbPath);
      assert.deepStrictEqual(succeeded.mismatches, []);
      assert.equal(succeeded.issuesCreated, 1);
    } finally {
      if (server.exitCode === null && server.signalCode === null) {
        server.kill("SIGKILL");
      }
    }
  }
);
