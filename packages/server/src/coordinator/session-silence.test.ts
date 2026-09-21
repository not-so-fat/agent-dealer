// packages/server/src/coordinator/session-silence.test.ts
//
// NOT-170: pure silence-derivation tests. A long tool call is tool_or_subprocess_in_flight
// and completion closes it; provider retry evidence is model_provider_wait while lack of
// evidence is unknown; startup with no output is no_structured_output; host sleep
// overrides without double-counting; starts pair with completions by call id.
import { test } from "node:test";
import assert from "node:assert/strict";

const { deriveSilenceIntervals, deriveSilenceFromHistoricalLog } = await import("./session-silence.js");

const T0 = Date.parse("2026-09-01T10:00:00.000Z");
const MIN = 60_000;

function nested(intervals: Array<{ startMs: number; endMs: number }>, s: number, e: number): void {
  for (const iv of intervals) {
    assert.ok(iv.startMs >= s && iv.endMs <= e, "interval nested inside agent-process time");
    assert.ok(iv.endMs > iv.startMs, "non-empty interval");
  }
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i]!.startMs >= sorted[i - 1]!.endMs, "non-overlapping intervals");
  }
}

test("a long tool call becomes tool_or_subprocess_in_flight; completion closes it", () => {
  const d = deriveSilenceIntervals({
    processStartMs: T0,
    processEndMs: T0 + 10 * MIN,
    activities: [
      { observedMs: T0 + 10_000, kind: "assistant_output" },
      { observedMs: T0 + 20_000, kind: "tool_started", callId: "tu_1" },
      // Completion 5 minutes later: the 20s→320s gap is an in-flight silence.
      { observedMs: T0 + 320_000, kind: "tool_completed", callId: "tu_1" },
      { observedMs: T0 + 330_000, kind: "assistant_output" },
    ],
  });
  assert.equal(d.quality, "inferred");
  const flight = d.intervals.filter((iv) => iv.category === "tool_or_subprocess_in_flight");
  assert.equal(flight.length, 1);
  assert.equal(flight[0]!.startMs, T0 + 20_000);
  assert.equal(flight[0]!.endMs, T0 + 320_000);
  for (const iv of d.intervals) {
    assert.deepEqual(iv.reasons, ["sampler_observed_time"]);
    assert.equal(iv.quality, "inferred");
  }
  // After the completion the flight is closed: the later [330s, end) gap is
  // unknown, never tool_or_subprocess_in_flight.
  const after = d.intervals.filter((iv) => iv.startMs >= T0 + 320_000);
  assert.equal(after.length, 1);
  assert.equal(after[0]!.category, "unknown");
  assert.equal(after[0]!.startMs, T0 + 330_000);
  nested(d.intervals, T0, T0 + 10 * MIN);
});

test("a completion for another call id does not close the flight", () => {
  const d = deriveSilenceIntervals({
    processStartMs: T0,
    processEndMs: T0 + 10 * MIN,
    activities: [
      { observedMs: T0 + 10_000, kind: "tool_started", callId: "tu_1" },
      { observedMs: T0 + 70_000, kind: "tool_completed", callId: "tu_other" },
    ],
  });
  const flight = d.intervals.filter((iv) => iv.category === "tool_or_subprocess_in_flight");
  assert.equal(flight.length, 1);
  assert.equal(flight[0]!.endMs, T0 + 10 * MIN);
});

test("parallel Claude starts need every completion before the flight closes", () => {
  const d = deriveSilenceIntervals({
    processStartMs: T0,
    processEndMs: T0 + 10 * MIN,
    activities: [
      { observedMs: T0 + 10_000, kind: "tool_started", callId: "tu_1" },
      { observedMs: T0 + 11_000, kind: "tool_started", callId: "tu_2" },
      { observedMs: T0 + 200_000, kind: "tool_completed", callId: "tu_1" },
      { observedMs: T0 + 400_000, kind: "tool_completed", callId: "tu_2" },
    ],
  });
  const flight = d.intervals.filter((iv) => iv.category === "tool_or_subprocess_in_flight");
  assert.equal(flight.length, 1);
  assert.equal(flight[0]!.startMs, T0 + 11_000);
  assert.equal(flight[0]!.endMs, T0 + 400_000);
});

test("provider retry evidence becomes model_provider_wait; lack of evidence is unknown", () => {
  const withEvidence = deriveSilenceIntervals({
    processStartMs: T0,
    processEndMs: T0 + 10 * MIN,
    activities: [
      { observedMs: T0 + 10_000, kind: "assistant_output" },
      { observedMs: T0 + 20_000, kind: "provider_wait" },
    ],
  });
  assert.deepEqual(
    withEvidence.intervals.map((iv) => iv.category),
    ["model_provider_wait"]
  );

  const withoutEvidence = deriveSilenceIntervals({
    processStartMs: T0,
    processEndMs: T0 + 10 * MIN,
    activities: [{ observedMs: T0 + 10_000, kind: "assistant_output" }],
  });
  assert.deepEqual(
    withoutEvidence.intervals.map((iv) => iv.category),
    ["unknown"]
  );
});

test("startup with no output becomes no_structured_output", () => {
  const d = deriveSilenceIntervals({
    processStartMs: T0,
    processEndMs: T0 + 10 * MIN,
    activities: [{ observedMs: T0 + 5 * MIN, kind: "assistant_output" }],
  });
  assert.deepEqual(
    d.intervals.map((iv) => iv.category),
    ["no_structured_output", "unknown"]
  );
  assert.equal(d.intervals[0]!.startMs, T0);
  assert.equal(d.intervals[0]!.endMs, T0 + 5 * MIN);
});

test("host sleep overrides the overlapping silence without double-counting", () => {
  const d = deriveSilenceIntervals({
    processStartMs: T0,
    processEndMs: T0 + 60 * MIN,
    activities: [
      { observedMs: T0, kind: "assistant_output" },
      { observedMs: T0 + 60 * MIN - 1, kind: "assistant_output" },
    ],
    // Suspended minutes 2..44 of an otherwise unknown hour-long gap.
    sleepWindows: [{ startMs: T0 + 2 * MIN, endMs: T0 + 44 * MIN }],
  });
  assert.deepEqual(
    d.intervals.map((iv) => iv.category),
    ["unknown", "host_suspended", "unknown"]
  );
  const total = d.intervals.reduce((a, iv) => a + iv.durationMs, 0);
  assert.equal(total, 60 * MIN - 1);
  nested(d.intervals, T0, T0 + 60 * MIN);
});

test("sub-threshold gaps produce no intervals and short processes stay empty", () => {
  const d = deriveSilenceIntervals({
    processStartMs: T0,
    processEndMs: T0 + 20_000,
    activities: [],
  });
  assert.deepEqual(d.intervals, []);
  assert.equal(d.quality, "inferred");
});

test("missing boundaries are unavailable, never fabricated", () => {
  const d = deriveSilenceIntervals({
    processStartMs: null,
    processEndMs: T0 + 10 * MIN,
    activities: [],
  });
  assert.deepEqual(d.intervals, []);
  assert.equal(d.quality, "unavailable");
  assert.ok(d.reasons.includes("no_defensible_boundary"));
});

test("untrusted historical logs are unavailable; trusted ones backfill as inferred", () => {
  const base = {
    processStartMs: T0,
    processEndMs: T0 + 10 * MIN,
    activities: [{ observedMs: T0 + 10_000, kind: "assistant_output" as const }],
  };
  const untrusted = deriveSilenceFromHistoricalLog({ ...base, trustworthyTimestamps: false });
  assert.deepEqual(untrusted.intervals, []);
  assert.equal(untrusted.quality, "unavailable");
  assert.deepEqual(untrusted.reasons, ["untrusted_log_timestamps"]);

  const trusted = deriveSilenceFromHistoricalLog({ ...base, trustworthyTimestamps: true });
  assert.equal(trusted.quality, "inferred");
  assert.ok(trusted.reasons.includes("backfill"));
  assert.deepEqual(
    trusted.intervals.map((iv) => iv.category),
    ["unknown"]
  );
});

test("custom threshold is honored", () => {
  const d = deriveSilenceIntervals({
    processStartMs: T0,
    processEndMs: T0 + 120_000,
    activities: [{ observedMs: T0 + 10_000, kind: "assistant_output" }],
    thresholdMs: 5 * MIN,
  });
  assert.deepEqual(d.intervals, []);
});
