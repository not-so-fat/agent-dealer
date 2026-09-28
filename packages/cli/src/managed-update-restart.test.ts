// NOT-279: a managed update downloaded while Dealer runs stays pending until a safe
// start/restart, and status reports the version the backend itself is running.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { readCurrentManagedVersion, readUpdateState, writeUpdateState } from "./managed/index.js";
import { activateVersion } from "./managed/activate.js";
import { cliEntryInVersionDir, versionDir } from "./managed/paths.js";
import { runStart } from "./start.js";
import { runStatus } from "./status.js";
import { maybeCheckForUpdateOnRun } from "./update-check.js";
import { getVersion } from "./version.js";

const RUNNING = "1.0.0";
const PENDING = "1.1.0";

/** Stands in for an agent-dealer backend; `version` null mimics a build that predates /api/version. */
async function startFakeBackend(version: string | null): Promise<{ child: ChildProcess; port: number }> {
  const script = `
const http = require("node:http");
const version = ${JSON.stringify(version)};
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/version" && version === null) { res.statusCode = 404; res.end("{}"); return; }
  res.end(JSON.stringify(req.url === "/api/version" ? { version } : { ok: true }));
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.stdout!.once("data", (chunk) => resolve(Number(String(chunk).trim())));
  });
  return { child, port };
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface ManagedHome {
  home: string;
  /** Where the pending version's stub CLI records the argv it was re-exec'd with. */
  reexecLog: string;
}

/**
 * A managed home with RUNNING active and PENDING downloaded. The pending CLI is a stub that
 * records its argv, standing in for the new version's `agent-dealer start`.
 */
function seedManagedHome(): ManagedHome {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-dealer-managed-restart-"));
  const reexecLog = path.join(home, "reexec.json");
  process.env.AGENT_DEALER_HOME = home;
  process.env.AGENT_DEALER_LOCAL_BIN = path.join(home, "local-bin");
  for (const version of [RUNNING, PENDING]) {
    const entry = cliEntryInVersionDir(versionDir(version));
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(
      entry,
      `require("node:fs").writeFileSync(${JSON.stringify(reexecLog)}, JSON.stringify({ version: ${JSON.stringify(version)}, argv: process.argv.slice(2) }));\n`,
    );
  }
  activateVersion(RUNNING);
  // Fresh checkedAt: the entry hook's background check must not reach the registry.
  writeUpdateState({ checkedAt: new Date().toISOString(), latest: PENDING, pendingVersion: PENDING });
  return { home, reexecLog };
}

async function withManagedHome(env: Record<string, string | undefined>, fn: (home: ManagedHome) => Promise<void>): Promise<void> {
  const keys = ["AGENT_DEALER_HOME", "AGENT_DEALER_LOCAL_BIN", "AGENT_DEALER_DISABLE_AUTOUPDATER", "AGENT_DEALER_SUPERVISOR", "PORT", "WEB_PORT", ...Object.keys(env)];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  delete process.env.AGENT_DEALER_DISABLE_AUTOUPDATER;
  delete process.env.AGENT_DEALER_SUPERVISOR;
  delete process.env.WEB_PORT;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const managed = seedManagedHome();
  try {
    await fn(managed);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(managed.home, { recursive: true, force: true });
  }
}

async function captureOutput(fn: () => Promise<number>): Promise<{ code: number; text: string }> {
  const original = { log: console.log, warn: console.warn, error: console.error };
  const lines: string[] = [];
  console.log = console.warn = console.error = (message?: unknown) => {
    lines.push(String(message));
  };
  try {
    const code = await fn();
    return { code, text: lines.join("\n") };
  } finally {
    Object.assign(console, original);
  }
}

function assertStillPending(managed: ManagedHome): void {
  assert.equal(readCurrentManagedVersion(), RUNNING, "`current` must not switch under a live backend");
  assert.equal(readUpdateState()?.pendingVersion, PENDING);
  assert.equal(fs.existsSync(managed.reexecLog), false, "the pending version must not be launched");
}

test("pending version stays pending while a backend runs; status shows running A and pending B", async () => {
  const { child, port } = await startFakeBackend(RUNNING);
  try {
    await withManagedHome({ PORT: String(port) }, async (managed) => {
      assert.deepEqual(await maybeCheckForUpdateOnRun(), { upgraded: false });
      const start = await captureOutput(() => runStart({ port }));
      assert.equal(start.code, 0);
      assert.match(start.text, /Already running/);
      assert.match(start.text, new RegExp(`${PENDING} is downloaded but not active`));
      assertStillPending(managed);

      const status = await captureOutput(() => runStatus());
      assert.equal(status.code, 0);
      assert.match(status.text, new RegExp(`Agent Dealer version ${getVersion()}`), "NOT-224 installed line is kept");
      assert.match(status.text, new RegExp(`running version ${RUNNING.replace(/\./g, "\\.")}`));
      assert.match(status.text, new RegExp(`Pending +managed version ${PENDING.replace(/\./g, "\\.")}`));
      assert.match(status.text, /Version mismatch: backend is running 1\.0\.0, installed CLI is/);
      assert.match(status.text, /restart after current execution finishes/);
      assertStillPending(managed);
    });
    assert.equal(isAlive(child.pid!), true, "observing an update must not stop the backend");
  } finally {
    child.kill("SIGKILL");
  }
});

test("status says running version unknown for a backend without /api/version", async () => {
  const { child, port } = await startFakeBackend(null);
  try {
    await withManagedHome({ PORT: String(port) }, async () => {
      const status = await captureOutput(() => runStatus());
      assert.equal(status.code, 0);
      assert.match(status.text, /running version unknown/);
      assert.doesNotMatch(status.text, new RegExp(`running version ${getVersion().replace(/\./g, "\\.")}`));
      assert.doesNotMatch(status.text, /Version mismatch/);
    });
  } finally {
    child.kill("SIGKILL");
  }
});

test("stopped backend: start activates the pending version before spawning and hands off to it", async () => {
  const port = await freePort();
  await withManagedHome({ PORT: String(port) }, async (managed) => {
    const result = await captureOutput(() => runStart({ port }));
    assert.equal(result.code, 0);
    assert.match(result.text, new RegExp(`Activated managed version ${PENDING.replace(/\./g, "\\.")}`));
    assert.equal(readCurrentManagedVersion(), PENDING);
    assert.equal(readUpdateState()?.pendingVersion, null);
    const handoff = JSON.parse(fs.readFileSync(managed.reexecLog, "utf8")) as { version: string; argv: string[] };
    assert.equal(handoff.version, PENDING);
    assert.deepEqual(handoff.argv, ["start", "--port", String(port)]);
  });
});

test("stopped backend: status reports the pending version for the next start", async () => {
  const port = await freePort();
  await withManagedHome({ PORT: String(port) }, async () => {
    const status = await captureOutput(() => runStatus());
    assert.equal(status.code, 1);
    assert.match(status.text, /Status: not running/);
    assert.match(status.text, /Update pending: 1\.1\.0 activates on the next `agent-dealer start`/);
  });
});

test("start refuses to activate while the server's own pid marker is live, even if /health is down", async () => {
  const port = await freePort();
  await withManagedHome({ PORT: String(port) }, async (managed) => {
    fs.writeFileSync(path.join(managed.home, "server.pid"), JSON.stringify({ pid: process.pid, port }));
    const result = await captureOutput(() => runStart({ port }));
    assert.equal(result.code, 1);
    assert.match(result.text, /not activating/);
    assertStillPending(managed);
  });
});

for (const daemon of [false, true]) {
  const label = daemon ? "start --daemon --force" : "start --force";

  test(`${label}: failed stop leaves the pending version inactive and starts nothing`, async () => {
    const { child, port } = await startFakeBackend(RUNNING);
    try {
      // No run.json in an isolated home = no proof of ownership, so stop leaves the listener up.
      await withManagedHome({ PORT: String(port) }, async (managed) => {
        const result = await captureOutput(() => runStart({ force: true, daemon, port }));
        assert.equal(result.code, 1);
        assertStillPending(managed);
        assert.equal(fs.existsSync(path.join(managed.home, "run.json")), false);
      });
      assert.equal(isAlive(child.pid!), true);
    } finally {
      child.kill("SIGKILL");
    }
  });

  test(`${label}: successful stop activates and starts the pending version`, async () => {
    const { child, port } = await startFakeBackend(RUNNING);
    try {
      await withManagedHome({ PORT: String(port) }, async (managed) => {
        fs.writeFileSync(
          path.join(managed.home, "run.json"),
          JSON.stringify({ host: "127.0.0.1", port, serverPid: child.pid, cliPid: 2 ** 22, startedAt: new Date().toISOString() }),
        );
        const result = await captureOutput(() => runStart({ force: true, daemon, port }));
        assert.equal(result.code, 0, result.text);
        assert.equal(readCurrentManagedVersion(), PENDING);
        const handoff = JSON.parse(fs.readFileSync(managed.reexecLog, "utf8")) as { version: string; argv: string[] };
        assert.equal(handoff.version, PENDING);
        assert.deepEqual(handoff.argv, ["start", "--force", "--port", String(port), ...(daemon ? ["--daemon"] : [])]);
      });
    } finally {
      child.kill("SIGKILL");
    }
  });
}
