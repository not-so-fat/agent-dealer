import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import { runCli } from "./index.js";
import { runStart } from "./start.js";
import { runStatus } from "./status.js";
import { getVersion } from "./version.js";

const EXPECTED = `Agent Dealer version ${getVersion()}`;

// No real sockets or child processes: health probing goes through node:http
// (NOT-370: probes avoid undici fetch; http.get is stubbed per test) and TCP
// reachability goes through net.connect (patched per test).
let serviceUp = false;
let tcpOpen = false;

type StubResponse = EventEmitter & { statusCode: number; resume: () => void };
type StubRequest = EventEmitter & { destroy: () => void };

function stubHttpGet(url: unknown, callback?: (res: StubResponse) => void): StubRequest {
  const request = new EventEmitter() as StubRequest;
  request.destroy = () => {};
  process.nextTick(() => {
    if (serviceUp && String(url).endsWith("/health")) {
      const response = new EventEmitter() as StubResponse;
      response.statusCode = 200;
      response.resume = () => {};
      callback?.(response);
      response.emit("data", Buffer.from(JSON.stringify({ ok: true })));
      response.emit("end");
    } else {
      request.emit("error", new Error("connect ECONNREFUSED (test stub)"));
    }
  });
  return request;
}

function stubConnect(): net.Socket {
  const socket = new net.Socket();
  process.nextTick(() => {
    socket.emit(tcpOpen ? "connect" : "error", tcpOpen ? undefined : new Error("connect ECONNREFUSED"));
  });
  return socket;
}

async function withServiceIO(options: { up: boolean; tcp: boolean }, fn: () => Promise<void>): Promise<void> {
  const originalGet = http.get;
  const originalConnect = net.connect;
  serviceUp = options.up;
  tcpOpen = options.tcp;
  (http as unknown as { get: unknown }).get = stubHttpGet;
  (net as unknown as { connect: unknown }).connect = stubConnect;
  // Isolate run state from the developer's real home, and simulate a normal
  // operator terminal (a supervisor env marker would legitimately silence output).
  const originalHome = process.env.AGENT_DEALER_HOME;
  const originalSupervisor = process.env.AGENT_DEALER_SUPERVISOR;
  process.env.AGENT_DEALER_HOME = "/tmp/agent-dealer-version-output-test-home";
  delete process.env.AGENT_DEALER_SUPERVISOR;
  try {
    await fn();
  } finally {
    (http as unknown as { get: unknown }).get = originalGet;
    (net as unknown as { connect: unknown }).connect = originalConnect;
    if (originalHome === undefined) delete process.env.AGENT_DEALER_HOME;
    else process.env.AGENT_DEALER_HOME = originalHome;
    if (originalSupervisor === undefined) delete process.env.AGENT_DEALER_SUPERVISOR;
    else process.env.AGENT_DEALER_SUPERVISOR = originalSupervisor;
  }
}

async function captureOutput(fn: () => Promise<number>): Promise<{ code: number; lines: string[] }> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const lines: string[] = [];
  console.log = (message?: unknown) => lines.push(String(message));
  console.warn = (message?: unknown) => lines.push(String(message));
  console.error = (message?: unknown) => lines.push(String(message));
  try {
    const code = await fn();
    return { code, lines };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

function countVersionLines(lines: string[]): number {
  return lines.filter((line) => line === EXPECTED).length;
}

function assertVersionOnceFirst(lines: string[]): void {
  assert.equal(lines[0], EXPECTED, "version line must come before all other output");
  assert.equal(countVersionLines(lines), 1, "version line must appear exactly once");
}

test("status prints the version line exactly once when stopped", async () => {
  await withServiceIO({ up: false, tcp: false }, async () => {
    const result = await captureOutput(() => runStatus());
    assert.equal(result.code, 1);
    assertVersionOnceFirst(result.lines);
  });
});

test("status prints the version line exactly once when running", async () => {
  await withServiceIO({ up: true, tcp: true }, async () => {
    const result = await captureOutput(() => runStatus());
    assert.equal(result.code, 0);
    assertVersionOnceFirst(result.lines);
  });
});

test("foreground start on an already-running instance prints the version line exactly once first", async () => {
  await withServiceIO({ up: true, tcp: true }, async () => {
    const result = await captureOutput(() => runStart({ port: 2299 }));
    assert.equal(result.code, 0);
    assertVersionOnceFirst(result.lines);
  });
});

test("daemon start on an already-running instance prints the version line exactly once first", async () => {
  await withServiceIO({ up: true, tcp: true }, async () => {
    const result = await captureOutput(() => runStart({ daemon: true, port: 2299 }));
    assert.equal(result.code, 0);
    assertVersionOnceFirst(result.lines);
  });
});

test("forced start that cannot stop an unowned listener keeps the version line exactly once", async () => {
  await withServiceIO({ up: true, tcp: true }, async () => {
    const result = await captureOutput(() => runStart({ force: true, port: 2299 }));
    assert.equal(result.code, 1);
    assertVersionOnceFirst(result.lines);
  });
});

test("forced daemon start that cannot stop an unowned listener keeps the version line exactly once", async () => {
  await withServiceIO({ up: true, tcp: true }, async () => {
    const result = await captureOutput(() => runStart({ daemon: true, force: true, port: 2299 }));
    assert.equal(result.code, 1);
    assertVersionOnceFirst(result.lines);
  });
});

test("start failing on a port conflict still prints the version line exactly once first", async () => {
  await withServiceIO({ up: false, tcp: true }, async () => {
    const result = await captureOutput(() => runStart({ port: 2299 }));
    assert.equal(result.code, 1);
    assertVersionOnceFirst(result.lines);
  });
});

test("internal supervisor child does not print a user-visible version line", async () => {
  await withServiceIO({ up: true, tcp: true }, async () => {
    const viaFlag = await captureOutput(() => runStart({ port: 2299, supervisor: true }));
    assert.equal(viaFlag.code, 0);
    assert.equal(countVersionLines(viaFlag.lines), 0);
  });
  await withServiceIO({ up: true, tcp: true }, async () => {
    process.env.AGENT_DEALER_SUPERVISOR = "1";
    try {
      const viaEnv = await captureOutput(() => runStart({ port: 2299 }));
      assert.equal(viaEnv.code, 0);
      assert.equal(countVersionLines(viaEnv.lines), 0);
    } finally {
      delete process.env.AGENT_DEALER_SUPERVISOR;
    }
  });
});

test("version line value matches agent-dealer --version (single getVersion source)", async () => {
  await withServiceIO({ up: false, tcp: false }, async () => {
    const version = await captureOutput(() => runCli(["node", "agent-dealer", "--version"]));
    assert.equal(version.code, 0);
    assert.deepEqual(version.lines, [getVersion()]);
    assert.equal(EXPECTED, `Agent Dealer version ${version.lines[0]}`);
  });
});

test("unknown start option still prints the version line exactly once", async () => {
  const originalCheck = process.env.AGENT_DEALER_DISABLE_UPGRADE_CHECK;
  const originalAuto = process.env.AGENT_DEALER_DISABLE_AUTOUPDATER;
  process.env.AGENT_DEALER_DISABLE_UPGRADE_CHECK = "1";
  process.env.AGENT_DEALER_DISABLE_AUTOUPDATER = "1";
  try {
    await withServiceIO({ up: false, tcp: false }, async () => {
      const result = await captureOutput(() => runCli(["node", "agent-dealer", "start", "--bogus"]));
      assert.equal(result.code, 1);
      assertVersionOnceFirst(result.lines);
    });
  } finally {
    if (originalCheck === undefined) delete process.env.AGENT_DEALER_DISABLE_UPGRADE_CHECK;
    else process.env.AGENT_DEALER_DISABLE_UPGRADE_CHECK = originalCheck;
    if (originalAuto === undefined) delete process.env.AGENT_DEALER_DISABLE_AUTOUPDATER;
    else process.env.AGENT_DEALER_DISABLE_AUTOUPDATER = originalAuto;
  }
});
