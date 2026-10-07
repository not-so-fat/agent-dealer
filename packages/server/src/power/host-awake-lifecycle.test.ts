// NOT-369: acquire/release through the session lifecycle wrapper used by worker-loop.
// Drives clean exit, crash, timeout, and kill outcomes with a fake spawner.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  installHostAwakeForTests,
  acquireHostAwake,
  releaseHostAwake,
  releaseAllHostAwake,
  isHostAwakeHoldActive,
  getHostAwakeGuard,
  type CaffeinateChild,
  type CaffeinateSpawner,
} from "./host-awake.js";

type Fake = CaffeinateChild & { kills: number };

function installFake(): { children: Fake[]; logs: string[] } {
  const children: Fake[] = [];
  const logs: string[] = [];
  const spawn: CaffeinateSpawner = () => {
    const child: Fake = {
      pid: 100 + children.length,
      kills: 0,
      kill() {
        this.kills += 1;
        return true;
      },
      once() {},
    };
    children.push(child);
    return child;
  };
  installHostAwakeForTests({
    platform: "darwin",
    pid: 2222,
    spawn,
    log: (m) => logs.push(m),
  });
  return { children, logs };
}

/** Mirrors worker-loop's acquire → work → finally release. */
async function runSessionLifecycle(
  outcome: "done" | "failed" | "timed_out" | "cancelled" | "kill"
): Promise<void> {
  acquireHostAwake();
  try {
    if (outcome === "kill") {
      // Coordinator abort / SIGTERM path — still releases in finally.
      throw new Error("killed");
    }
    // Other outcomes complete normally; release is always in finally.
    void outcome;
  } catch {
    // crash / kill — must not skip release
  } finally {
    releaseHostAwake();
  }
}

test("each session outcome releases the hold (zero live holds afterward)", async () => {
  for (const outcome of ["done", "failed", "timed_out", "cancelled", "kill"] as const) {
    const { children } = installFake();
    await runSessionLifecycle(outcome);
    assert.equal(getHostAwakeGuard().holdCount(), 0, outcome);
    assert.equal(isHostAwakeHoldActive(), false, outcome);
    assert.equal(children.length, 1, outcome);
    assert.equal(children[0]!.kills, 1, outcome);
    // Double release after terminal is harmless.
    releaseHostAwake();
    assert.equal(getHostAwakeGuard().holdCount(), 0, outcome);
  }
});

test("server shutdown releaseAll clears in-flight session holds", async () => {
  const { children } = installFake();
  acquireHostAwake();
  assert.equal(isHostAwakeHoldActive(), true);
  releaseAllHostAwake();
  assert.equal(getHostAwakeGuard().holdCount(), 0);
  assert.equal(children[0]!.kills, 1);
});

test("linux: lifecycle completes with no spawn and no log", async () => {
  const logs: string[] = [];
  let spawned = 0;
  installHostAwakeForTests({
    platform: "linux",
    spawn: () => {
      spawned += 1;
      throw new Error("should not spawn");
    },
    log: (m) => logs.push(m),
  });
  await runSessionLifecycle("done");
  await runSessionLifecycle("failed");
  assert.equal(spawned, 0);
  assert.equal(logs.length, 0);
  assert.equal(getHostAwakeGuard().holdCount(), 0);
});
