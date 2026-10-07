// NOT-369: host-awake reference-count + caffeinate spawn contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HostAwakeGuard,
  type CaffeinateChild,
  type CaffeinateSpawner,
} from "./host-awake.js";

type FakeChild = CaffeinateChild & {
  killedWith: Array<NodeJS.Signals | number | undefined>;
  exitListeners: Array<(...args: unknown[]) => void>;
  errorListeners: Array<(...args: unknown[]) => void>;
};

function makeFakeSpawner(opts?: {
  throwOnSpawn?: boolean;
  capture?: { command?: string; args?: string[] };
}): { spawn: CaffeinateSpawner; children: FakeChild[]; logs: string[] } {
  const children: FakeChild[] = [];
  const logs: string[] = [];
  const spawn: CaffeinateSpawner = (command, args) => {
    if (opts?.capture) {
      opts.capture.command = command;
      opts.capture.args = args;
    }
    if (opts?.throwOnSpawn) throw new Error("ENOENT: caffeinate");
    const child: FakeChild = {
      pid: 9000 + children.length,
      killedWith: [],
      exitListeners: [],
      errorListeners: [],
      kill(signal) {
        this.killedWith.push(signal);
        for (const l of this.exitListeners) l(0, signal);
        return true;
      },
      once(event, listener) {
        if (event === "exit") this.exitListeners.push(listener);
        else this.errorListeners.push(listener);
      },
    };
    children.push(child);
    return child;
  };
  return { spawn, children, logs };
}

test("darwin: first acquire spawns caffeinate -i -w <pid>; further acquires do not", () => {
  const capture: { command?: string; args?: string[] } = {};
  const { spawn, children } = makeFakeSpawner({ capture });
  const guard = new HostAwakeGuard({ platform: "darwin", pid: 4242, spawn });

  guard.acquire();
  assert.equal(children.length, 1);
  assert.equal(capture.command, "caffeinate");
  assert.deepEqual(capture.args, ["-i", "-w", "4242"]);
  assert.equal(guard.isHoldActive(), true);
  assert.equal(guard.holdCount(), 1);

  guard.acquire();
  guard.acquire();
  assert.equal(children.length, 1, "refcount must not spawn another caffeinate");
  assert.equal(guard.holdCount(), 3);
  assert.equal(guard.isHoldActive(), true);
});

test("darwin: last release terminates the child; double release is harmless", () => {
  const { spawn, children } = makeFakeSpawner();
  const guard = new HostAwakeGuard({ platform: "darwin", pid: 1, spawn });

  guard.acquire();
  guard.acquire();
  guard.release();
  assert.equal(children.length, 1);
  assert.equal(children[0]!.killedWith.length, 0, "still held");
  assert.equal(guard.isHoldActive(), true);

  guard.release();
  assert.equal(children[0]!.killedWith[0], "SIGTERM");
  assert.equal(guard.isHoldActive(), false);
  assert.equal(guard.holdCount(), 0);

  guard.release();
  guard.release();
  assert.equal(guard.holdCount(), 0);
  assert.equal(children[0]!.killedWith.length, 1, "double release must not re-kill");
});

test("darwin: releaseAll drops every hold and kills the child", () => {
  const { spawn, children } = makeFakeSpawner();
  const guard = new HostAwakeGuard({ platform: "darwin", pid: 7, spawn });
  guard.acquire();
  guard.acquire();
  guard.releaseAll();
  assert.equal(guard.holdCount(), 0);
  assert.equal(guard.isHoldActive(), false);
  assert.equal(children[0]!.killedWith[0], "SIGTERM");
});

test("non-darwin: acquire never spawns; sessions can still release", () => {
  const { spawn, children, logs } = makeFakeSpawner();
  const logLines: string[] = [];
  const guard = new HostAwakeGuard({
    platform: "linux",
    pid: 99,
    spawn,
    log: (m) => logLines.push(m),
  });
  guard.acquire();
  guard.acquire();
  assert.equal(children.length, 0);
  assert.equal(guard.isHoldActive(), false);
  assert.equal(guard.holdCount(), 2);
  guard.release();
  guard.release();
  assert.equal(guard.holdCount(), 0);
  assert.equal(logLines.length, 0);
  assert.equal(logs.length, 0);
});

test("darwin: spawn throw logs once and never fails the caller", () => {
  const logLines: string[] = [];
  const { spawn, children } = makeFakeSpawner({ throwOnSpawn: true });
  const guard = new HostAwakeGuard({
    platform: "darwin",
    pid: 3,
    spawn,
    log: (m) => logLines.push(m),
  });
  assert.doesNotThrow(() => guard.acquire());
  assert.doesNotThrow(() => guard.acquire());
  assert.equal(children.length, 0);
  assert.equal(guard.isHoldActive(), false);
  assert.equal(guard.holdCount(), 2);
  assert.equal(logLines.length, 1);
  assert.match(logLines[0]!, /caffeinate unavailable/);
  guard.release();
  guard.release();
  assert.equal(guard.holdCount(), 0);
});

test("session lifecycle outcomes leave zero holds (done, crash, timeout, kill)", () => {
  const outcomes = ["done", "failed", "timed_out", "cancelled"] as const;
  for (const outcome of outcomes) {
    const { spawn, children } = makeFakeSpawner();
    const guard = new HostAwakeGuard({ platform: "darwin", pid: 11, spawn });

    // Mirror worker-loop: acquire when the leased session starts…
    guard.acquire();
    assert.equal(guard.isHoldActive(), true);

    // …and release on every terminal outcome (including crash/timeout/kill).
    void outcome;
    guard.release();
    assert.equal(guard.holdCount(), 0, `holds remain after ${outcome}`);
    assert.equal(guard.isHoldActive(), false);
    assert.equal(children[0]!.killedWith[0], "SIGTERM");

    // Double release after terminal is harmless.
    guard.release();
    assert.equal(guard.holdCount(), 0);
  }
});

test("server shutdown releaseAll clears holds after a live session", () => {
  const { spawn, children } = makeFakeSpawner();
  const guard = new HostAwakeGuard({ platform: "darwin", pid: 12, spawn });
  guard.acquire(); // session
  guard.acquire(); // merge
  guard.releaseAll();
  assert.equal(guard.holdCount(), 0);
  assert.equal(children[0]!.killedWith[0], "SIGTERM");
});

test("linux + throwing spawner: session still completes with at most one log", () => {
  const logLines: string[] = [];
  const { spawn, children } = makeFakeSpawner({ throwOnSpawn: true });
  const guard = new HostAwakeGuard({
    platform: "linux",
    spawn,
    log: (m) => logLines.push(m),
  });
  // Session path must not care about power failures.
  assert.doesNotThrow(() => {
    guard.acquire();
    // pretend session ran to timed_out
    guard.release();
  });
  assert.equal(children.length, 0);
  assert.equal(logLines.length, 0, "non-darwin must not attempt spawn or log");
});
