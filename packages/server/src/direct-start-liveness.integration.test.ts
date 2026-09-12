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

const { isServiceRunning } = await import("./db/migrate-to-issues.js");

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

test(
  "a directly-launched server (npm run dev's exact entrypoint) is detected as running, and stops being detected once it exits",
  { timeout: 45000 },
  async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-direct-start-"));
    const dbPath = path.join(home, "dealer.db");
    const port = await getEphemeralPort();

    const child = spawn(tsxBin, [serverEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        AGENT_DEALER_HOME: home,
        AGENT_DEALER_ENV: "development",
        PORT: String(port),
      },
      stdio: "ignore",
    });

    try {
      const healthy = await waitUntil(async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`);
          return res.ok;
        } catch {
          return false;
        }
      }, 20000);
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
