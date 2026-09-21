// packages/server/src/coordinator/execution-intervals.test.ts
//
// NOT-169: pure interval derivation from durable boundary events.
// EXECUTION_ANALYSIS.md §2 (phases) / §4 (quality) / §8 (missing data).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveAttemptIntervals,
  type BoundaryEvent,
} from "./execution-intervals.js";

function ev(type: string, ts: string, rowid: number): BoundaryEvent {
  return { type, ts, rowid };
}

const T0 = "2026-09-20T10:00:00.000Z";
const T1 = "2026-09-20T10:00:05.000Z";
const T2 = "2026-09-20T10:20:00.000Z";
const T3 = "2026-09-20T10:20:30.000Z";

function happyPath(): BoundaryEvent[] {
  return [
    ev("worker.started", T0, 1),
    ev("agent.started", T1, 2),
    ev("agent.completed", T2, 3),
    ev("worker.completed", T3, 4),
  ];
}

test("happy path derives one setup, one agent-process, one validation interval, all exact and non-negative", () => {
  const r = deriveAttemptIntervals({ events: happyPath() });
  assert.equal(r.setup.quality, "exact");
  assert.equal(r.setup.durationMs, 5_000);
  assert.equal(r.agentProcess.quality, "exact");
  assert.equal(r.agentProcess.durationMs, 20 * 60_000 - 5_000);
  assert.equal(r.validationPublish.quality, "exact");
  assert.equal(r.validationPublish.durationMs, 30_000);
  for (const i of [r.setup, r.agentProcess, r.validationPublish]) {
    assert.ok(i.durationMs !== null && i.durationMs >= 0);
    assert.deepEqual(i.reasons, []);
  }
  assert.equal(r.coordinatorWork, null);
});

test("same-millisecond boundaries order by rowid: adjacent intervals are empty but exact", () => {
  const ts = "2026-09-20T10:40:00.123Z";
  const r = deriveAttemptIntervals({
    events: [
      ev("worker.started", T0, 1),
      ev("agent.started", T1, 2),
      ev("agent.completed", ts, 10),
      ev("worker.failed", ts, 11),
    ],
  });
  assert.equal(r.validationPublish.quality, "exact");
  assert.equal(r.validationPublish.durationMs, 0);
});

test("rowid order is deterministic across restarts: reversed input derives identically", () => {
  const a = deriveAttemptIntervals({ events: happyPath() });
  const b = deriveAttemptIntervals({ events: [...happyPath()].reverse() });
  assert.deepEqual(a, b);
});

test("negative duration is unavailable, never clamped to zero", () => {
  const r = deriveAttemptIntervals({
    events: [
      ev("worker.started", T1, 1),
      ev("agent.started", T0, 2), // end before start
      ev("agent.completed", T2, 3),
      ev("worker.completed", T3, 4),
    ],
  });
  assert.equal(r.setup.quality, "unavailable");
  assert.deepEqual(r.setup.reasons, ["negative_duration"]);
  assert.equal(r.setup.durationMs, null);
});

test("missing agent.started leaves setup and agent process unavailable", () => {
  const r = deriveAttemptIntervals({
    events: [ev("worker.started", T0, 1), ev("worker.failed", T3, 4)],
  });
  assert.equal(r.setup.quality, "unavailable");
  assert.equal(r.agentProcess.quality, "unavailable");
  assert.ok(r.setup.reasons.includes("no_defensible_boundary"));
});

test("publishOnly attempts have no agent interval; coordinator work is measurable and tagged", () => {
  const r = deriveAttemptIntervals({
    events: [ev("worker.started", T0, 1), ev("worker.completed", T3, 2)],
    publishOnly: true,
  });
  assert.equal(r.agentProcess.quality, "unavailable");
  assert.ok(r.agentProcess.reasons.includes("no_agent_process"));
  assert.equal(r.agentProcess.durationMs, null);
  assert.notEqual(r.coordinatorWork, null);
  assert.equal(r.coordinatorWork!.quality, "exact");
  assert.equal(r.coordinatorWork!.durationMs, Date.parse(T3) - Date.parse(T0));
  assert.ok(r.coordinatorWork!.reasons.includes("publish_only"));
});

test("usage duration supports an inferred agent duration but is never exact boundaries", () => {
  const r = deriveAttemptIntervals({
    events: [ev("worker.started", T0, 1), ev("worker.failed", T3, 4)],
    usageDurationMs: 123_456,
  });
  assert.equal(r.agentProcess.quality, "inferred");
  assert.equal(r.agentProcess.durationMs, 123_456);
  assert.equal(r.agentProcess.startMs, null);
  assert.equal(r.agentProcess.endMs, null);
  assert.ok(r.agentProcess.reasons.includes("proxy_boundary"));
  // The spawn envelope itself is resource evidence, always inferred, never exact.
  assert.equal(r.spawnEnvelope.quality, "inferred");
  assert.equal(r.spawnEnvelope.durationMs, 123_456);
  assert.ok(r.spawnEnvelope.reasons.includes("includes_spawn_slot_wait"));
  assert.ok(r.spawnEnvelope.reasons.includes("includes_post_exit_work"));
});

test("absent usage duration is unavailable, never zero", () => {
  const r = deriveAttemptIntervals({ events: happyPath() });
  assert.equal(r.spawnEnvelope.quality, "unavailable");
  assert.equal(r.spawnEnvelope.durationMs, null);
});
