// packages/server/src/coordinator/restart-recovery.integration.test.ts
//
// NOT-131: a coordinator RESTART must not kill live workers.
//
// NOT-124 made lease expiry a liveness check, but scoped the evidence to the process that
// produced it — so every restart (`tsx watch` reload, crash, operator restart, deploy)
// regenerated COORDINATOR_PROCESS_OWNER, every in-flight session read "unknown", and the
// guard could never fire. Observed 2026-09-16: four developer attempts in 22 minutes, each
// failed "presumed dead" by a different coordinator owner, each leaving its CLI running —
// at peak three `claude -p` processes implementing one ticket in three worktrees. One was
// failed 13 seconds after an operator restart, heartbeating up to the moment the old
// process went away.
//
// These are that run's acceptance scenarios. The restart is simulated the way it actually
// happens: the session row carries a process_owner from a coordinator that is gone, while
// the child it names is still running.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-restart-"));
process.env.COORDINATOR_FAIL_BACKOFF_MS = "0";
process.env.COORDINATOR_LEASE_MS = "60000";

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("../repository/issues.js");
const { createWorkerSession, startSession, recordSessionProcess, listWorkerSessionsForIssue } =
  await import("../repository/worker-sessions.js");
const { getWorkItem, listWorkItemsForIssue, claimWorkItem, bindWorkItemSession } = await import(
  "../repository/work-items.js"
);
const { startWorkflow } = await import("./commands.js");
const { recoverCoordinator } = await import("./recovery.js");
const { COORDINATOR_PROCESS_OWNER, processLiveness, readProcessStartTime, terminateWorkerProcess } =
  await import("./process-liveness.js");

const LEASE_MS = 60_000;
/** A clock far enough past any lease that timestamp-only recovery would always reclaim. */
const LONG_AFTER = () => Date.now() + 3_600_000;

/**
 * A process_owner naming a coordinator that no longer exists, on THIS host — exactly what a
 * session row holds a moment after a restart. The pid it names is irrelevant; what matters
 * is that it is not COORDINATOR_PROCESS_OWNER.
 */
const DEAD_COORDINATOR = `${os.hostname()}:999999:0badc0de`;
/** The other machine case, where no local probe is meaningful at all. */
const OTHER_HOST = "some-other-host:999:abcd1234";

before(() => migrate());
beforeEach(() => {
  getDb().exec("DELETE FROM work_items");
});

interface LiveChild {
  pid: number;
  startTime: string;
  exited: Promise<"exited">;
  kill: () => void;
}

const spawnedChildren: LiveChild[] = [];

/** A genuinely alive, same-user process standing in for a spawned agent CLI. */
function spawnLiveChild(): LiveChild {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const pid = child.pid!;
  const startTime = readProcessStartTime(pid)!;
  assert.ok(startTime, "ps must report a start time for a process we just spawned");
  const live: LiveChild = {
    pid,
    startTime,
    exited: new Promise<"exited">((resolve) => child.once("exit", () => resolve("exited"))),
    kill: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    },
  };
  spawnedChildren.push(live);
  return live;
}

/** Resolves "exited" or "still-running" — never hangs the runner on a process that lives. */
function exitedWithin(child: LiveChild, ms: number): Promise<"exited" | "still-running"> {
  return Promise.race([
    child.exited,
    new Promise<"still-running">((resolve) => {
      const t = setTimeout(() => resolve("still-running"), ms);
      t.unref?.();
    }),
  ]);
}

after(async () => {
  for (const child of spawnedChildren) child.kill();
  await Promise.all(spawnedChildren.map((c) => exitedWithin(c, 2_000)));
});

/** A pid that certainly no longer exists: spawn a process, then wait for it to exit. */
async function deadPid(): Promise<{ pid: number; startTime: string }> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid!;
  const startTime = readProcessStartTime(pid) ?? "Thu Jan  1 00:00:00 1970";
  await new Promise<void>((resolve) => child.on("close", () => resolve()));
  return { pid, startTime };
}

function newIssue(): string {
  return createIssue({
    title: "Survive the restart",
    acceptanceCriteria: "It survives",
    repo: "/repo",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
  }).id;
}

/** A leased developer work item with a running session bound to it, as a live attempt has. */
function leasedAttempt(leaseMs = LEASE_MS): { issueId: string; itemId: string; sessionId: string } {
  const issueId = newIssue();
  startWorkflow(issueId);
  const item = listWorkItemsForIssue(issueId).find((i) => i.kind === "developer")!;
  const claimed = claimWorkItem("loop-test", { leaseMs })!;
  const session = createWorkerSession({
    issueId,
    role: "developer",
    round: 1,
    agentId: BUILTIN_AGENT_CLAUDE_ID,
    runtime: null,
  });
  startSession(session.id);
  assert.equal(bindWorkItemSession(item.id, session.id, claimed.leaseToken!), true);
  return { issueId, itemId: item.id, sessionId: session.id };
}

// ------------------------------------------------- the ticket's headline acceptance case

test("NOT-131: a restart does not reclaim a session whose CLI is still running", async () => {
  const { itemId, sessionId, issueId } = leasedAttempt();
  const child = spawnLiveChild();
  // The restart: the row names a coordinator that is gone, the child it names is not.
  recordSessionProcess(sessionId, child.pid, DEAD_COORDINATOR, child.startTime);

  const res = await recoverCoordinator({ now: LONG_AFTER(), clockJump: null });

  assert.deepEqual(res.reclaimed, [], "the successor must not presume a live worker dead");
  assert.deepEqual(res.deadLettered, []);
  assert.deepEqual(res.heldAlive, [itemId]);
  // No duplicate spawn: the item never returns to the pool a dispatcher claims from.
  assert.equal(getWorkItem(itemId)!.status, "leased");
  assert.equal(listWorkerSessionsForIssue(issueId)[0].status, "running");
  assert.equal(await exitedWithin(child, 200), "still-running", "and the CLI is left alone");
});

test("NOT-131: the restarted coordinator extends the lease, so the item stops re-raising", async () => {
  const { itemId, sessionId } = leasedAttempt(0);
  const child = spawnLiveChild();
  const before = getWorkItem(itemId)!.leaseExpiresAt!;
  recordSessionProcess(sessionId, child.pid, DEAD_COORDINATOR, child.startTime);

  const first = await recoverCoordinator({ now: Date.now() + 1_000, clockJump: null });
  assert.deepEqual(first.heldAlive, [itemId]);
  assert.ok(Date.parse(getWorkItem(itemId)!.leaseExpiresAt!) > Date.parse(before));

  const second = await recoverCoordinator({ now: Date.now() + 1_000, clockJump: null });
  assert.deepEqual(second.heldAlive, [], "no longer an expired lease at all");
  assert.deepEqual(second.reclaimed, []);
});

// ------------------------------------------------------------- NOT-116 must not regress

test("NOT-116: a restart still reclaims a lease whose CLI really exited", async () => {
  const { itemId, sessionId, issueId } = leasedAttempt();
  const { pid, startTime } = await deadPid();
  recordSessionProcess(sessionId, pid, DEAD_COORDINATOR, startTime);

  const res = await recoverCoordinator({ now: LONG_AFTER(), clockJump: null });

  assert.deepEqual(res.reclaimed, [itemId], "a genuinely dead worker is still reclaimed");
  assert.deepEqual(res.heldAlive, []);
  assert.equal(getWorkItem(itemId)!.status, "pending");
  assert.match(listWorkerSessionsForIssue(issueId)[0].errorJson ?? "", /presumed dead/);
});

test("NOT-131: a recycled pid is not mistaken for the worker that recorded it", async () => {
  // The hazard the owner-scoping existed to prevent, and the reason a bare pid is not
  // portable evidence: this pid is alive, but it is not the process the session spawned.
  const { itemId, sessionId } = leasedAttempt();
  const stranger = spawnLiveChild();
  recordSessionProcess(sessionId, stranger.pid, DEAD_COORDINATOR, "Thu Jan  1 00:00:00 1970");

  const res = await recoverCoordinator({ now: LONG_AFTER(), clockJump: null });

  assert.deepEqual(res.reclaimed, [itemId], "a start-time mismatch is positive evidence of death");
  assert.deepEqual(res.heldAlive, []);
  assert.equal(
    await exitedWithin(stranger, 200),
    "still-running",
    "and the unrelated program that inherited the pid is never signalled"
  );
});

// --------------------------------------------------- the cases that stay "unknown" (AC 2)

test("NOT-131: a pre-upgrade row is never read as alive, and never signalled", async () => {
  // A session in flight across the upgrade: NOT-124 wrote a pid and an owner, the
  // start-time column is NULL. Reading that as evidence would be strictly wrong in both
  // directions — so it degrades to timestamp-only, and the pid is left untouched because
  // nothing here identifies it.
  const { itemId, sessionId } = leasedAttempt();
  const child = spawnLiveChild();
  recordSessionProcess(sessionId, child.pid, DEAD_COORDINATOR, null);

  assert.equal(processLiveness(child.pid, DEAD_COORDINATOR, null), "unknown");
  const res = await recoverCoordinator({ now: LONG_AFTER(), clockJump: null });

  assert.deepEqual(res.reclaimed, [itemId]);
  assert.deepEqual(res.unverifiedOrphans, [itemId], "reported, not silently assumed clean");
  assert.equal(await exitedWithin(child, 200), "still-running", "an unidentifiable pid is not killed");
});

test("NOT-131: another host's pid is neither probed nor signalled", async () => {
  const { itemId, sessionId } = leasedAttempt();
  const child = spawnLiveChild();
  recordSessionProcess(sessionId, child.pid, OTHER_HOST, child.startTime);

  assert.equal(processLiveness(child.pid, OTHER_HOST, child.startTime), "unknown");
  const res = await recoverCoordinator({ now: LONG_AFTER(), clockJump: null });

  assert.deepEqual(res.reclaimed, [itemId]);
  assert.deepEqual(res.unverifiedOrphans, [itemId]);
  assert.equal(await exitedWithin(child, 200), "still-running");
});

// ------------------------------------------- the bound that keeps "alive" from stalling

test("NOT-131: an alive worker held past its ceiling is killed, then reclaimed", async () => {
  // Without this bound, making the verdict survive restarts trades a destructive reclaim
  // for a permanent stall: the CLI's own timeout lived in the process that died, so a hung
  // worker would re-extend its lease on every tick forever.
  const { itemId, sessionId, issueId } = leasedAttempt();
  const child = spawnLiveChild();
  recordSessionProcess(sessionId, child.pid, DEAD_COORDINATOR, child.startTime);

  const prev = process.env.COORDINATOR_MAX_ALIVE_HOLD_MS;
  process.env.COORDINATOR_MAX_ALIVE_HOLD_MS = "1";
  try {
    const res = await recoverCoordinator({ now: Date.now() + 60_000, clockJump: null });

    assert.deepEqual(res.heldAliveExpired, [itemId]);
    assert.deepEqual(res.heldAlive, [], "the ceiling wins over the liveness hold");
    assert.deepEqual(res.reclaimed, [itemId]);
    assert.deepEqual(res.unverifiedOrphans, [], "a verified pid is confirmed stopped");
    assert.equal(getWorkItem(itemId)!.status, "pending");
    assert.match(listWorkerSessionsForIssue(issueId)[0].errorJson ?? "", /presumed dead/);
  } finally {
    if (prev === undefined) delete process.env.COORDINATOR_MAX_ALIVE_HOLD_MS;
    else process.env.COORDINATOR_MAX_ALIVE_HOLD_MS = prev;
  }

  // AC 2: never two live agents on one issue. The predecessor is gone BEFORE the reclaimed
  // item is available for a successor to claim.
  assert.equal(await exitedWithin(child, 5_000), "exited");
});

test("NOT-131: a sleep grace still protects a lease the ceiling would otherwise reclaim", async () => {
  // A host that slept burned the session's wall-clock budget without the CLI running for
  // any of it, so the ceiling can fire on a perfectly healthy run. NOT-125's window must
  // still win, and the CLI must survive it.
  const { itemId, sessionId } = leasedAttempt();
  const child = spawnLiveChild();
  recordSessionProcess(sessionId, child.pid, DEAD_COORDINATOR, child.startTime);

  const prev = process.env.COORDINATOR_MAX_ALIVE_HOLD_MS;
  process.env.COORDINATOR_MAX_ALIVE_HOLD_MS = "1";
  try {
    const now = Date.now() + 60_000;
    const res = await recoverCoordinator({
      now,
      clockJump: { detectedAt: now, graceUntil: now + 60_000, wallGapMs: 0, unelapsedMs: 0, unobservedMs: 0 },
    });

    assert.deepEqual(res.reclaimed, []);
    assert.deepEqual(res.heldAliveExpired, [], "held, so not reported as reclaimed either");
    assert.deepEqual(res.heldAcrossClockJump, [itemId]);
  } finally {
    if (prev === undefined) delete process.env.COORDINATOR_MAX_ALIVE_HOLD_MS;
    else process.env.COORDINATOR_MAX_ALIVE_HOLD_MS = prev;
  }
  assert.equal(await exitedWithin(child, 200), "still-running");
});

// ------------------------------------------------------------------------ unit coverage

test("readProcessStartTime identifies a process and distinguishes the next one", async () => {
  const child = spawnLiveChild();
  assert.equal(readProcessStartTime(child.pid), child.startTime, "stable for one process");
  const gone = await deadPid();
  assert.equal(readProcessStartTime(gone.pid), null, "null once the process is gone");
  assert.equal(readProcessStartTime(0), null);
  assert.equal(readProcessStartTime(null), null);
});

test("processLiveness: our own child needs no corroboration", () => {
  assert.equal(processLiveness(process.pid, COORDINATOR_PROCESS_OWNER), "alive");
  assert.equal(processLiveness(process.pid, COORDINATOR_PROCESS_OWNER, "whatever"), "alive");
});

test("terminateWorkerProcess declines a pid it cannot identify", async () => {
  const child = spawnLiveChild();
  assert.equal(await terminateWorkerProcess(child.pid, DEAD_COORDINATOR, null), "unverified");
  assert.equal(await terminateWorkerProcess(child.pid, OTHER_HOST, child.startTime), "unverified");
  assert.equal(await exitedWithin(child, 200), "still-running");
});

test("terminateWorkerProcess stops a verified process and reports an already-dead one", async () => {
  const child = spawnLiveChild();
  assert.equal(await terminateWorkerProcess(child.pid, DEAD_COORDINATOR, child.startTime), "stopped");
  assert.equal(await exitedWithin(child, 5_000), "exited");

  const gone = await deadPid();
  assert.equal(await terminateWorkerProcess(gone.pid, DEAD_COORDINATOR, gone.startTime), "stopped");
  assert.equal(await terminateWorkerProcess(null, DEAD_COORDINATOR, null), "stopped");
});
