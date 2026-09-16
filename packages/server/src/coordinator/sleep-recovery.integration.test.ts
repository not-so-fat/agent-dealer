// packages/server/src/coordinator/sleep-recovery.integration.test.ts
//
// NOT-124 + NOT-125: a sleeping laptop must not kill live workers.
//
// Six healthy developer sessions were failed as "presumed dead" across five macOS wakes on
// 2026-09-15/16 — one of them had already pushed and opened its PR. The coordinator process
// never restarted; only its timers were frozen while wall-clock kept moving, so every wake
// was indistinguishable from a crash. These are the acceptance scenarios from both tickets:
// the pid gate (is the CLI actually gone?) and the clock-jump gate (was the host suspended?),
// each proven to block a wrong reclaim WITHOUT blocking a right one.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-sleep-"));
process.env.COORDINATOR_FAIL_BACKOFF_MS = "0";
process.env.COORDINATOR_LEASE_MS = "60000";

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("../repository/issues.js");
const {
  createWorkerSession,
  startSession,
  recordSessionProcess,
  getWorkerSession,
  listWorkerSessionsForIssue,
} = await import("../repository/worker-sessions.js");
const { getWorkItem, listWorkItemsForIssue, claimWorkItem, bindWorkItemSession } = await import(
  "../repository/work-items.js"
);
const { startWorkflow } = await import("./commands.js");
const { recoverCoordinator } = await import("./recovery.js");
const { COORDINATOR_PROCESS_OWNER, processLiveness } = await import("./process-liveness.js");
const { observeClockJump, activeClockJumpGrace, resetClockJumpState } = await import("./clock-jump.js");

const LEASE_MS = 60_000;
/** A clock far enough past any lease that timestamp-only recovery would always reclaim. */
const LONG_AFTER = () => Date.now() + 3_600_000;

before(() => migrate());
beforeEach(() => {
  // Recovery scans every leased row in the table, so a prior test's leftovers would be
  // picked up as this test's candidates.
  getDb().exec("DELETE FROM work_items");
  resetClockJumpState();
});

function newIssue(): string {
  return createIssue({
    title: "Sleep through it",
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

/** A pid that certainly no longer exists: spawn a process, then wait for it to exit. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.on("close", () => resolve()));
  return pid;
}

// ---------------------------------------------------------------- NOT-124: pid liveness

test("NOT-124: a lease whose CLI is still running is never reclaimed, however stale", async () => {
  const { itemId, sessionId, issueId } = leasedAttempt();
  // process.pid is this test runner — a process that is unambiguously alive.
  recordSessionProcess(sessionId, process.pid, COORDINATOR_PROCESS_OWNER);

  const res = await recoverCoordinator({ now: LONG_AFTER(), clockJump: null });

  assert.deepEqual(res.reclaimed, [], "a live worker must never be reclaimed");
  assert.deepEqual(res.deadLettered, []);
  assert.deepEqual(res.heldAlive, [itemId]);
  assert.equal(getWorkItem(itemId)!.status, "leased");
  assert.equal(listWorkerSessionsForIssue(issueId)[0].status, "running", "session stays running");
});

test("NOT-124: holding a live lease extends it, so it stops re-raising every tick", async () => {
  // A lease that is expired against the real clock, not an injected one — the renewal this
  // asserts is written with Date.now(), the same clock the next tick's scan will read.
  const { itemId, sessionId } = leasedAttempt(0);
  const before = getWorkItem(itemId)!.leaseExpiresAt!;
  recordSessionProcess(sessionId, process.pid, COORDINATOR_PROCESS_OWNER);

  const first = await recoverCoordinator({ now: Date.now() + 1_000, clockJump: null });
  assert.deepEqual(first.heldAlive, [itemId]);

  const after = getWorkItem(itemId)!.leaseExpiresAt!;
  assert.ok(Date.parse(after) > Date.parse(before), "the frozen heartbeat's renewal is done for it");
  assert.equal(getWorkItem(itemId)!.status, "leased");

  // And the extension actually takes it out of the candidate set, rather than re-raising
  // the same item (and the same warning) on every 3s tick for as long as it runs.
  const second = await recoverCoordinator({ now: Date.now() + 1_000, clockJump: null });
  assert.deepEqual(second.heldAlive, [], "no longer an expired lease at all");
  assert.deepEqual(second.reclaimed, []);
});

test("NOT-124: a lease whose CLI really exited is still reclaimed (NOT-116 preserved)", async () => {
  const { itemId, sessionId, issueId } = leasedAttempt();
  recordSessionProcess(sessionId, await deadPid(), COORDINATOR_PROCESS_OWNER);

  const res = await recoverCoordinator({ now: LONG_AFTER(), clockJump: null });

  assert.deepEqual(res.reclaimed, [itemId], "a dead pid is positive evidence — reclaim it");
  assert.deepEqual(res.heldAlive, []);
  assert.equal(getWorkItem(itemId)!.status, "pending");
  assert.match(listWorkerSessionsForIssue(issueId)[0].errorJson ?? "", /presumed dead/);
});

test("NOT-124: a session with no recorded pid falls back to timestamp-only reclaim", async () => {
  const { itemId, sessionId } = leasedAttempt();
  assert.equal(getWorkerSession(sessionId)!.processPid, null, "legacy rows carry no pid");

  const res = await recoverCoordinator({ now: LONG_AFTER(), clockJump: null });

  assert.deepEqual(res.reclaimed, [itemId]);
  assert.equal(getWorkItem(itemId)!.status, "pending");
});

test("NOT-124: an uncorroborated pid from another coordinator proves nothing", async () => {
  // The pid-reuse hazard: after a restart the OS may have handed this number to an
  // unrelated program, so kill(pid, 0) would succeed forever and strand the item — which is
  // why a foreign owner is not on its own sufficient evidence.
  //
  // NOT-131 narrowed this rather than reversing it: a pid from a dead coordinator on THIS
  // host is now corroborated by its recorded start time (see
  // restart-recovery.integration.test.ts). What still proves nothing, and is asserted here,
  // is a pid on another machine — unprobeable and unsignallable from here at any time.
  const { itemId, sessionId } = leasedAttempt();
  recordSessionProcess(sessionId, process.pid, "some-other-host:999:abcd1234");

  assert.equal(processLiveness(process.pid, "some-other-host:999:abcd1234"), "unknown");
  const res = await recoverCoordinator({ now: LONG_AFTER(), clockJump: null });
  assert.deepEqual(res.reclaimed, [itemId]);
});

// ------------------------------------------------------- NOT-125: host sleep / clock jump

test("NOT-125: a wall-clock jump larger than the lease does not reclaim pre-jump leases", async () => {
  const { itemId } = leasedAttempt();
  const t0 = Date.now();

  // Tick before the sleep establishes the baseline; the tick after it sees 49 minutes of
  // wall-clock against ~20ms of monotonic time — the clamshell sleep from the ticket.
  assert.equal(observeClockJump({ now: t0, monotonic: 1_000 }), null, "first tick has no baseline");
  const slept = 49 * 60_000;
  const jump = observeClockJump({ now: t0 + slept, monotonic: 1_020 });

  assert.ok(jump, "the gap the monotonic clock never saw is a host suspension");
  assert.equal(jump!.wallGapMs, slept);
  assert.ok(jump!.unelapsedMs > LEASE_MS, "un-elapsed time exceeds a whole lease");

  const res = await recoverCoordinator({ now: t0 + slept });
  assert.deepEqual(res.reclaimed, [], "nothing that was healthy before the sleep is reclaimed");
  assert.deepEqual(res.heldAcrossClockJump, [itemId]);
  assert.equal(getWorkItem(itemId)!.status, "leased");
});

test("NOT-125: a genuinely silent worker is reclaimed once the grace period passes", async () => {
  const { itemId, issueId } = leasedAttempt();
  const t0 = Date.now();
  observeClockJump({ now: t0, monotonic: 1_000 });
  const wake = t0 + 49 * 60_000;
  observeClockJump({ now: wake, monotonic: 1_020 });

  // Still inside the grace window: held.
  assert.deepEqual((await recoverCoordinator({ now: wake + 1_000 })).heldAcrossClockJump, [itemId]);

  // Grace elapsed with no heartbeat — this worker really is gone.
  const res = await recoverCoordinator({ now: wake + LEASE_MS + 1 });
  assert.deepEqual(res.reclaimed, [itemId]);
  assert.deepEqual(res.heldAcrossClockJump, []);
  assert.equal(getWorkItem(itemId)!.status, "pending");
  assert.match(listWorkerSessionsForIssue(issueId)[0].errorJson ?? "", /presumed dead/);
});

test("NOT-125: a sleep is detected even when the monotonic clock counts through it", async () => {
  // libuv's monotonic clock on some Darwin versions is mach_continuous_time(), which keeps
  // advancing while the machine is asleep — so the wall-vs-monotonic delta reads ~zero for
  // the very sleep this is meant to catch. The gap between poll ticks catches it anyway:
  // a 3s timer that took 49 minutes to fire did not fire.
  const { itemId } = leasedAttempt();
  const t0 = Date.now();
  observeClockJump({ now: t0, monotonic: 1_000 });
  const slept = 49 * 60_000;
  const jump = observeClockJump({ now: t0 + slept, monotonic: 1_000 + slept });

  assert.ok(jump, "the poll loop never observed the gap, whatever the monotonic clock says");
  assert.equal(jump!.unelapsedMs, 0, "the monotonic signal alone would have seen nothing");
  assert.ok(jump!.unobservedMs > LEASE_MS);

  const res = await recoverCoordinator({ now: t0 + slept });
  assert.deepEqual(res.reclaimed, []);
  assert.deepEqual(res.heldAcrossClockJump, [itemId]);
});

test("NOT-125: the grace window expires on its own and stops protecting anything", async () => {
  const t0 = Date.now();
  observeClockJump({ now: t0, monotonic: 1_000 });
  const wake = t0 + 600_000;
  const jump = observeClockJump({ now: wake, monotonic: 1_020 })!;

  assert.ok(activeClockJumpGrace(wake), "grace is live immediately after the jump");
  assert.equal(activeClockJumpGrace(jump.graceUntil), null, "and lapses at graceUntil");
});

test("NOT-125: ordinary tick jitter is not mistaken for a host sleep", async () => {
  const { itemId } = leasedAttempt();
  const t0 = Date.now();
  observeClockJump({ now: t0, monotonic: 1_000 });
  // A slow tick: wall and monotonic advance together, so nothing was un-elapsed.
  assert.equal(observeClockJump({ now: t0 + 4_000, monotonic: 5_000 }), null);

  const res = await recoverCoordinator({ now: LONG_AFTER() });
  assert.deepEqual(res.reclaimed, [itemId], "a hung worker is still reclaimed normally");
});

test("NOT-125: a lease that expired AFTER the jump is not protected by it", async () => {
  // The grace covers work that was healthy when the host went down. An item whose lease
  // expired in real time after the wake is a genuinely silent worker and is reclaimed.
  const t0 = Date.now();
  observeClockJump({ now: t0, monotonic: 1_000 });
  const wake = t0 + 600_000;
  observeClockJump({ now: wake, monotonic: 1_020 });

  const { itemId } = leasedAttempt(); // leased now — its lease expires after the jump
  const res = await recoverCoordinator({ now: wake + LEASE_MS + 10_000 });

  assert.deepEqual(res.heldAcrossClockJump, []);
  assert.deepEqual(res.reclaimed, [itemId]);
});

// --------------------------------------------- both gates: the actual production scenario

test("NOT-124+125: the observed incident — a live CLI across a 49-minute clamshell sleep", async () => {
  const { itemId, sessionId, issueId } = leasedAttempt();
  recordSessionProcess(sessionId, process.pid, COORDINATOR_PROCESS_OWNER);

  const t0 = Date.now();
  observeClockJump({ now: t0, monotonic: 1_000 });
  const wake = t0 + 49 * 60_000;
  observeClockJump({ now: wake, monotonic: 1_020 });

  // The first tick on wake — the one that failed all six sessions before this fix.
  const onWake = await recoverCoordinator({ now: wake });
  assert.deepEqual(onWake.reclaimed, [], "no reclaim storm on wake");
  assert.deepEqual(onWake.heldAlive, [itemId], "the pid gate answers first — it is verifiably alive");
  assert.equal(listWorkerSessionsForIssue(issueId)[0].status, "running");

  // ...and it keeps surviving later ticks, long past the grace window, because the process
  // itself is still there. This is the criterion the clock-jump grace alone cannot meet.
  const later = await recoverCoordinator({ now: wake + 10 * 60_000 });
  assert.deepEqual(later.reclaimed, []);
  assert.deepEqual(later.heldAlive, [itemId]);
  assert.equal(getWorkItem(itemId)!.status, "leased");
});
