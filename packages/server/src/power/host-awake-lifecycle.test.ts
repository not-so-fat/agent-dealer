// NOT-369: drive session outcomes through the real worker-loop / auto-merge /
// shutdown registration paths — not a test-local withHostAwakeHold mirror.
// A removed runHeldWork finally, or an unwired registerHostAwakeShutdownCleanup
// in index.ts, must fail this file.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  installHostAwakeForTests,
  releaseHostAwake,
  isHostAwakeHoldActive,
  getHostAwakeGuard,
  acquireHostAwake,
  type CaffeinateChild,
  type CaffeinateSpawner,
} from "./host-awake.js";
import {
  registerHostAwakeShutdownCleanup,
  type ShutdownEventTarget,
} from "./host-awake-lifecycle.js";
import {
  processWorkItemForTests,
  setProcessWorkItemHeldForTests,
} from "../coordinator/worker-loop.js";
import {
  finalizeAutoMerge,
  setFinalizeAutoMergeOnceForTests,
  clearFinalizeInflightForTests,
  type AutoMergeFinalizeResult,
} from "../coordinator/auto-merge.js";
import type { WorkItem } from "../repository/work-items.js";

type Fake = CaffeinateChild & { kills: number };
type SessionOutcome = "done" | "failed" | "timed_out" | "cancelled" | "kill";

afterEach(() => {
  setProcessWorkItemHeldForTests(null);
  setFinalizeAutoMergeOnceForTests(null);
  clearFinalizeInflightForTests();
});

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

function leasedWorkItem(): WorkItem {
  const now = new Date().toISOString();
  return {
    id: "wi-lifecycle",
    issueId: "issue-lifecycle",
    workflowInstanceId: "wf-lifecycle",
    workerSessionId: null,
    kind: "developer",
    round: 1,
    payloadJson: null,
    status: "leased",
    attemptCount: 1,
    maxAttempts: 3,
    leaseOwner: "lifecycle-test",
    leaseToken: "tok-lifecycle",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    heartbeatAt: null,
    availableAt: now,
    idempotencyKey: null,
    resultJson: null,
    errorJson: null,
    createdAt: now,
    updatedAt: now,
  };
}

function stubHeldBodyForOutcome(outcome: SessionOutcome): void {
  setProcessWorkItemHeldForTests(async () => {
    if (outcome === "kill" || outcome === "failed") {
      throw new Error(outcome === "kill" ? "killed" : "session crashed");
    }
    // timed_out / cancelled / done — runner settles; hold released in finally.
  });
}

/** Real processWorkItem path (hold wrapper + injectable held body). */
async function runWorkerSessionOutcome(outcome: SessionOutcome): Promise<void> {
  stubHeldBodyForOutcome(outcome);
  await processWorkItemForTests(leasedWorkItem()).catch(() => {
    // crash / kill — hold must still be released by runHeldWork's finally
  });
}

const mergeOk: AutoMergeFinalizeResult = {
  applied: true,
  issueStatus: "done",
  nextWorkItemId: null,
  humanActionId: null,
  instanceCompleted: true,
  triggerReflect: false,
};

/** Real finalizeAutoMerge path (hold wrapper + injectable once body). */
async function runMergeOutcome(outcome: SessionOutcome): Promise<void> {
  setFinalizeAutoMergeOnceForTests(async () => {
    if (outcome === "kill" || outcome === "failed") {
      throw new Error(outcome === "kill" ? "merge killed" : "merge failed");
    }
    return mergeOk;
  });
  await finalizeAutoMerge(`issue-merge-${outcome}`).catch(() => {
    // crash / kill — hold must still be released
  });
}

test("index.ts registers host-awake shutdown via the lifecycle seam", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const indexSrc = readFileSync(join(here, "../index.ts"), "utf8");
  assert.match(indexSrc, /registerHostAwakeShutdownCleanup\s*\(\s*process\s*\)/);
  assert.doesNotMatch(indexSrc, /releaseAllHostAwake\s*\(/);
});

test("each worker-session outcome through processWorkItem leaves zero live holds", async () => {
  for (const outcome of ["done", "failed", "timed_out", "cancelled", "kill"] as const) {
    const { children } = installFake();
    await runWorkerSessionOutcome(outcome);
    assert.equal(getHostAwakeGuard().holdCount(), 0, outcome);
    assert.equal(isHostAwakeHoldActive(), false, outcome);
    assert.equal(children.length, 1, outcome);
    assert.equal(children[0]!.kills, 1, outcome);
    // Double release after terminal is harmless.
    releaseHostAwake();
    assert.equal(getHostAwakeGuard().holdCount(), 0, outcome);
  }
});

test("each merge outcome through finalizeAutoMerge leaves zero live holds", async () => {
  for (const outcome of ["done", "failed", "timed_out", "cancelled", "kill"] as const) {
    const { children } = installFake();
    await runMergeOutcome(outcome);
    assert.equal(getHostAwakeGuard().holdCount(), 0, `merge:${outcome}`);
    assert.equal(isHostAwakeHoldActive(), false, `merge:${outcome}`);
    assert.equal(children.length, 1, `merge:${outcome}`);
    assert.equal(children[0]!.kills, 1, `merge:${outcome}`);
  }
});

test("registered shutdown cleanup on SIGINT/SIGTERM/exit clears in-flight holds", async () => {
  for (const event of ["SIGINT", "SIGTERM", "exit"] as const) {
    const { children } = installFake();
    acquireHostAwake();
    assert.equal(isHostAwakeHoldActive(), true, event);

    const fakeProcess = new EventEmitter() as EventEmitter & ShutdownEventTarget;
    registerHostAwakeShutdownCleanup(fakeProcess);
    fakeProcess.emit(event);

    assert.equal(getHostAwakeGuard().holdCount(), 0, event);
    assert.equal(children[0]!.kills, 1, event);
    // Double fire (e.g. SIGTERM then exit) is harmless.
    fakeProcess.emit(event);
    assert.equal(getHostAwakeGuard().holdCount(), 0, event);
    assert.equal(children[0]!.kills, 1, event);
  }
});

test("linux: processWorkItem completes with no spawn and no log", async () => {
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
  await runWorkerSessionOutcome("done");
  await runWorkerSessionOutcome("failed");
  assert.equal(spawned, 0);
  assert.equal(logs.length, 0);
  assert.equal(getHostAwakeGuard().holdCount(), 0);
});

test("darwin: throwing spawner does not fail processWorkItem; at most one log", async () => {
  const logs: string[] = [];
  installHostAwakeForTests({
    platform: "darwin",
    pid: 9,
    spawn: () => {
      throw new Error("ENOENT");
    },
    log: (m) => logs.push(m),
  });
  await runWorkerSessionOutcome("done");
  await runWorkerSessionOutcome("kill");
  assert.equal(getHostAwakeGuard().holdCount(), 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /caffeinate unavailable/);
});
