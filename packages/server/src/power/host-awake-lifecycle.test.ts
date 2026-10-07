// NOT-369: drive session outcomes through the production withHostAwakeHold wrapper
// (the same helper worker-loop / auto-merge call). A test-only try/finally mirror
// would stay green if the production finally were removed — this file must not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  installHostAwakeForTests,
  releaseHostAwake,
  releaseAllHostAwake,
  isHostAwakeHoldActive,
  getHostAwakeGuard,
  withHostAwakeHold,
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

/**
 * Outcomes the worker session can hit. Each path goes through withHostAwakeHold —
 * the production wrapper processWorkItem / finalizeAutoMerge use.
 */
async function runSessionThroughProductionHold(
  outcome: "done" | "failed" | "timed_out" | "cancelled" | "kill"
): Promise<void> {
  await withHostAwakeHold(async () => {
    if (outcome === "kill" || outcome === "failed") {
      throw new Error(outcome === "kill" ? "killed" : "session crashed");
    }
    if (outcome === "timed_out") {
      // Timeout path still settles the awaitable (runner surfaces timed_out).
      return;
    }
    if (outcome === "cancelled") {
      return;
    }
    // done
  }).catch(() => {
    // crash / kill — hold must still be released by withHostAwakeHold's finally
  });
}

test("production wiring: worker-loop and auto-merge call withHostAwakeHold", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const workerLoop = readFileSync(join(here, "../coordinator/worker-loop.ts"), "utf8");
  const autoMerge = readFileSync(join(here, "../coordinator/auto-merge.ts"), "utf8");
  assert.match(workerLoop, /withHostAwakeHold\s*\(\s*\(\)\s*=>\s*processWorkItemHeld/);
  assert.match(autoMerge, /withHostAwakeHold\s*\(\s*\(\)\s*=>\s*finalizeAutoMergeOnce/);
  // Must not keep a local try/finally acquire/release mirror beside the helper.
  assert.doesNotMatch(workerLoop, /acquireHostAwake\s*\(\s*\)/);
  assert.doesNotMatch(autoMerge, /acquireHostAwake\s*\(\s*\)/);
});

test("each session outcome through withHostAwakeHold leaves zero live holds", async () => {
  for (const outcome of ["done", "failed", "timed_out", "cancelled", "kill"] as const) {
    const { children } = installFake();
    await runSessionThroughProductionHold(outcome);
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
  await withHostAwakeHold(async () => {
    assert.equal(isHostAwakeHoldActive(), true);
    releaseAllHostAwake();
    assert.equal(getHostAwakeGuard().holdCount(), 0);
    assert.equal(children[0]!.kills, 1);
  });
  // Outer withHostAwakeHold finally still runs — double release is harmless.
  assert.equal(getHostAwakeGuard().holdCount(), 0);
});

test("linux: withHostAwakeHold completes with no spawn and no log", async () => {
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
  await runSessionThroughProductionHold("done");
  await runSessionThroughProductionHold("failed");
  assert.equal(spawned, 0);
  assert.equal(logs.length, 0);
  assert.equal(getHostAwakeGuard().holdCount(), 0);
});

test("darwin: throwing spawner does not fail the session; at most one log", async () => {
  const logs: string[] = [];
  installHostAwakeForTests({
    platform: "darwin",
    pid: 9,
    spawn: () => {
      throw new Error("ENOENT");
    },
    log: (m) => logs.push(m),
  });
  await runSessionThroughProductionHold("done");
  await runSessionThroughProductionHold("kill");
  assert.equal(getHostAwakeGuard().holdCount(), 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /caffeinate unavailable/);
});
