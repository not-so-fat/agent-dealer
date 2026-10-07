import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { installNodeHardening } from "./node-hardening.js";
import { fetchRunningBackendVersion, probeAgentDealer } from "./ports.js";
import { runStop } from "./stop.js";

// NOT-370: `agent-dealer stop` must never die with an uncaught `setTypeOfService EINVAL`
// from undici when probing a just-killed localhost listener. These tests are sandbox-safe:
// no listen() — closed ports plus injected probe shapes only.

const CLOSED_PORT = 1;

function einvalError(): Error {
  return Object.assign(new Error("setTypeOfService EINVAL"), {
    code: "EINVAL",
    syscall: "setTypeOfService",
    errno: -22,
  });
}

async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function captureConsole(): { logs: string[]; warns: string[]; restore: () => void } {
  const logs: string[] = [];
  const warns: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (message?: unknown) => {
    logs.push(String(message));
  };
  console.warn = (message?: unknown) => {
    warns.push(String(message));
  };
  return {
    logs,
    warns,
    restore: () => {
      console.log = originalLog;
      console.warn = originalWarn;
    },
  };
}

/** Poison global fetch: any local-probe routing through undici fails the test loudly. */
function poisonFetch(): { calls: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((_url: unknown) => {
    calls += 1;
    throw einvalError();
  }) as typeof fetch;
  return {
    calls: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 25; i += 1) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function spawnSleeper(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
  child.unref();
  return child;
}

test("installNodeHardening swallows only the setTypeOfService EINVAL shape", () => {
  const proto = net.Socket.prototype as unknown as Record<string, unknown>;
  const real = proto.setTypeOfService;
  try {
    let toThrow: unknown;
    proto.setTypeOfService = function stubbedSetTypeOfService(this: unknown): unknown {
      throw toThrow;
    };
    installNodeHardening();
    // @types/node omits the (runtime-present) setTypeOfService; type the call surface locally.
    const raw = new net.Socket();
    const socket = raw as unknown as { setTypeOfService(tos: number): unknown };

    toThrow = einvalError();
    assert.doesNotThrow(() => socket.setTypeOfService(0));
    assert.equal(socket.setTypeOfService(0), raw, "swallow must preserve chaining");

    toThrow = Object.assign(new Error("setTypeOfService EPERM"), {
      code: "EPERM",
      syscall: "setTypeOfService",
    });
    assert.throws(() => socket.setTypeOfService(0), /EPERM/, "other errnos must still throw");

    toThrow = Object.assign(new Error("bind EINVAL"), { code: "EINVAL", syscall: "bind" });
    assert.throws(() => socket.setTypeOfService(0), /bind EINVAL/, "EINVAL from other syscalls must still throw");

    toThrow = new Error("plain failure");
    assert.throws(() => socket.setTypeOfService(0), /plain failure/);
  } finally {
    proto.setTypeOfService = real;
    installNodeHardening();
  }
});

test("installNodeHardening is idempotent", () => {
  installNodeHardening();
  const proto = net.Socket.prototype as unknown as Record<string, unknown>;
  const first = proto.setTypeOfService;
  installNodeHardening();
  assert.equal(proto.setTypeOfService, first, "second install must not double-wrap");
});

test("local probes never route through global fetch and report a closed port as down", async () => {
  const fetch = poisonFetch();
  try {
    const probe = await probeAgentDealer("127.0.0.1", CLOSED_PORT);
    assert.equal(probe.up, false);
    assert.equal(await fetchRunningBackendVersion("127.0.0.1", CLOSED_PORT), null);
    assert.equal(fetch.calls(), 0, "probe path must not call global fetch (undici)");
  } finally {
    fetch.restore();
  }
});

test("runStop exits 0 after signaling pids even when fetch would throw EINVAL", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-dealer-stop-einval-"));
  const server = spawnSleeper();
  const cli = spawnSleeper();
  fs.writeFileSync(
    path.join(home, "run.json"),
    JSON.stringify({
      host: "127.0.0.1",
      port: CLOSED_PORT,
      serverPid: server.pid,
      cliPid: cli.pid,
      startedAt: new Date().toISOString(),
    }),
  );
  const fetch = poisonFetch();
  const consoleCap = captureConsole();
  try {
    await withEnv({ AGENT_DEALER_HOME: home, PORT: undefined, WEB_PORT: undefined }, async () => {
      assert.equal(await runStop(), 0);
    });
    assert.ok(
      consoleCap.logs.some((line) => line.includes(`Stopped server (pid ${server.pid})`)),
      `expected server stop line, got: ${consoleCap.logs.join("\n")}`,
    );
    assert.ok(
      consoleCap.logs.some((line) => line.includes("agent-dealer stopped.")),
      `expected stopped summary, got: ${consoleCap.logs.join("\n")}`,
    );
    assert.equal(fetch.calls(), 0, "stop confirmation must not call global fetch (undici)");
    assert.equal(fs.existsSync(path.join(home, "run.json")), false, "run state must be cleared");
    assert.equal(await waitUntilDead(server.pid!), true, "server pid must be terminated");
    assert.equal(await waitUntilDead(cli.pid!), true, "cli pid must be terminated");
  } finally {
    consoleCap.restore();
    fetch.restore();
    server.kill("SIGKILL");
    cli.kill("SIGKILL");
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("runStop treats a rejecting probe as down and still exits 0", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-dealer-stop-einval-"));
  const consoleCap = captureConsole();
  try {
    await withEnv({ AGENT_DEALER_HOME: home, PORT: undefined, WEB_PORT: undefined }, async () => {
      const code = await runStop({
        probe: async () => {
          throw einvalError();
        },
      });
      assert.equal(code, 0);
    });
    assert.ok(
      consoleCap.logs.some((line) => line.includes("No running agent-dealer instance found.")),
      `expected no-instance summary, got: ${consoleCap.logs.join("\n")}`,
    );
  } finally {
    consoleCap.restore();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("runStop still reports a truly stuck listener with exit 1", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-dealer-stop-einval-"));
  const consoleCap = captureConsole();
  try {
    await withEnv(
      { AGENT_DEALER_HOME: undefined, HOME: home, USERPROFILE: home, PORT: String(CLOSED_PORT), WEB_PORT: undefined },
      async () => {
        const code = await runStop({
          probe: async (host, port) => ({ up: true, url: `http://${host}:${port}` }),
        });
        assert.equal(code, 1);
      },
    );
    assert.ok(
      consoleCap.warns.some((line) => line.includes("still responds on configured port")),
      `expected still-listening warning, got: ${consoleCap.warns.join("\n")}`,
    );
  } finally {
    consoleCap.restore();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
