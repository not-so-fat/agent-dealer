// packages/server/src/coordinator/attempt-waste.test.ts
//
// NOT-172: failed-attempt waste, first checkpoint, and retry-reuse derivation.
//
// Pure derivation over durable evidence shapes (no DB): exact agent intervals
// beat the inferred spawn envelope, null provider fields stay null with
// known/total counts, publish-only attempts add zero agent waste but remain
// retries, and legacy payloads derive only as inferred.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveAttemptWaste,
  deriveFirstCheckpoint,
  deriveRetrySummary,
  isWastedSession,
  type AgentBoundary,
  type CheckpointRecord,
  type WasteSession,
  type WasteUsage,
} from "./attempt-waste.js";

const T0 = "2026-09-21T00:00:00.000Z";
const T1 = "2026-09-21T00:05:00.000Z";
const T2 = "2026-09-21T00:10:00.000Z";

function session(overrides: Partial<WasteSession> & { id: string }): WasteSession {
  return {
    role: "developer",
    status: "failed",
    errorJson: null,
    createdAt: T0,
    ...overrides,
  };
}

function checkpoint(overrides: Partial<CheckpointRecord> = {}): CheckpointRecord {
  return {
    sessionId: "session-1",
    kind: "commit",
    observedSha: "a".repeat(40),
    observedAt: T1,
    origin: "sampler",
    inputSha: "b".repeat(40),
    samplingPrecisionMs: 10_000,
    branch: "issue-1",
    ts: T1,
    cursor: 7,
    ...overrides,
  };
}

// ---------------------------------------------------------- first checkpoint

test("first checkpoint reports ms since workflow start as exact", () => {
  const first = deriveFirstCheckpoint({ workflowStartedAt: T0, checkpoints: [checkpoint()] });
  assert.equal(first.kind, "commit");
  assert.equal(first.msSinceWorkflowStart, 5 * 60_000);
  assert.equal(first.quality, "exact");
  assert.deepEqual(first.reasons, []);
});

test("earliest of several checkpoints wins by (ts, cursor) order", () => {
  const first = deriveFirstCheckpoint({
    workflowStartedAt: T0,
    checkpoints: [
      checkpoint({ observedAt: T2, ts: T2, cursor: 9, kind: "branch_pushed" }),
      checkpoint({ observedAt: T1, ts: T1, cursor: 7, kind: "commit" }),
    ],
  });
  assert.equal(first.kind, "commit");
  assert.equal(first.msSinceWorkflowStart, 5 * 60_000);
});

test("no checkpoints and no legacy evidence is unavailable, never zero", () => {
  const first = deriveFirstCheckpoint({ workflowStartedAt: T0, checkpoints: [] });
  assert.equal(first.msSinceWorkflowStart, null);
  assert.equal(first.quality, "unavailable");
  assert.ok(first.reasons.includes("missing_checkpoint"));
});

test("legacy evidence derives an inferred first checkpoint, never exact", () => {
  const first = deriveFirstCheckpoint({ workflowStartedAt: T0, checkpoints: [], legacyFirstEvidenceAt: T2 });
  assert.equal(first.msSinceWorkflowStart, 10 * 60_000);
  assert.equal(first.quality, "inferred");
  assert.ok(first.reasons.includes("backfill"));
});

test("a checkpoint before workflow start is a negative duration, not clamped", () => {
  const first = deriveFirstCheckpoint({ workflowStartedAt: T2, checkpoints: [checkpoint()] });
  assert.equal(first.msSinceWorkflowStart, null);
  assert.equal(first.quality, "unavailable");
  assert.ok(first.reasons.includes("negative_duration"));
});

// --------------------------------------------------------------- waste scope

test("failed and timed_out count as waste; done never does", () => {
  assert.equal(isWastedSession(session({ id: "a", status: "failed" })), true);
  assert.equal(isWastedSession(session({ id: "b", status: "timed_out" })), true);
  assert.equal(isWastedSession(session({ id: "c", status: "done" })), false);
  assert.equal(isWastedSession(session({ id: "d", status: "queued" })), false);
  assert.equal(isWastedSession(session({ id: "e", status: "running" })), false);
});

test("cancelled counts only with failure evidence", () => {
  assert.equal(isWastedSession(session({ id: "a", status: "cancelled", errorJson: JSON.stringify({ reason: "boom" }) })), true);
  assert.equal(isWastedSession(session({ id: "b", status: "cancelled", errorJson: null })), false);
});

// ------------------------------------------------------------------ waste sums

function usage(overrides: Partial<WasteUsage> & { workerSessionId: string }): WasteUsage {
  return { tokensIn: null, tokensOut: null, costUsd: null, durationMs: null, ...overrides };
}

test("a failed session followed by success reports the first attempt as waste", () => {
  const waste = deriveAttemptWaste({
    sessions: [
      session({ id: "s1", status: "failed" }),
      session({ id: "s2", status: "done" }),
    ],
    usages: [
      usage({ workerSessionId: "s1", tokensIn: 100, tokensOut: 50, costUsd: 0.42, durationMs: 60_000 }),
      usage({ workerSessionId: "s2", tokensIn: 200, tokensOut: 60, costUsd: 0.5, durationMs: 70_000 }),
    ],
    agentBoundaries: [],
  });
  assert.equal(waste.failedAttempts, 1);
  // No agent boundaries: the spawn envelope stands in, marked inferred.
  assert.equal(waste.runtimeMs.value, 60_000);
  assert.equal(waste.runtimeMs.quality, "inferred");
  assert.ok(waste.runtimeMs.reasons.includes("includes_spawn_slot_wait"));
  assert.ok(waste.runtimeMs.reasons.includes("includes_post_exit_work"));
  assert.equal(waste.tokensIn.value, 100);
  assert.equal(waste.tokensIn.quality, "exact");
  assert.equal(waste.costUsd.value, 0.42);
});

test("exact agent intervals beat the usage envelope when both exist", () => {
  const start = Date.parse(T0);
  const bounds: AgentBoundary[] = [{ sessionId: "s1", startMs: start, endMs: start + 45_000 }];
  const waste = deriveAttemptWaste({
    sessions: [session({ id: "s1", status: "timed_out" })],
    usages: [usage({ workerSessionId: "s1", durationMs: 60_000 })],
    agentBoundaries: bounds,
  });
  assert.equal(waste.runtimeMs.value, 45_000);
  assert.equal(waste.runtimeMs.quality, "exact");
  assert.deepEqual(waste.runtimeMs.reasons, []);
});

test("missing provider fields stay unavailable with coverage counts, never zero", () => {
  const waste = deriveAttemptWaste({
    sessions: [session({ id: "s1" }), session({ id: "s2", status: "timed_out" })],
    usages: [
      // Cursor-style row: tokens known, cost never reported.
      usage({ workerSessionId: "s1", tokensIn: 100, tokensOut: 50, costUsd: null, durationMs: 60_000 }),
      usage({ workerSessionId: "s2", tokensIn: null, tokensOut: null, costUsd: null, durationMs: null }),
    ],
    agentBoundaries: [],
  });
  assert.equal(waste.tokensIn.value, 100);
  assert.equal(waste.tokensIn.known, 1);
  assert.equal(waste.tokensIn.total, 2);
  assert.ok(waste.tokensIn.reasons.includes("partial_sample"));
  assert.equal(waste.costUsd.value, null);
  assert.equal(waste.costUsd.quality, "unavailable");
  assert.equal(waste.costUsd.known, 0);
  assert.equal(waste.costUsd.total, 2);
  assert.ok(waste.costUsd.reasons.includes("missing_provider_metadata"));
  // Runtime known for one of two — partial, still summed over known only.
  assert.equal(waste.runtimeMs.value, 60_000);
  assert.equal(waste.runtimeMs.known, 1);
  assert.equal(waste.runtimeMs.total, 2);
});

test("no failed attempts is unavailable across the board, never zero waste presented as exact", () => {
  const waste = deriveAttemptWaste({
    sessions: [session({ id: "s1", status: "done" })],
    usages: [usage({ workerSessionId: "s1", tokensIn: 1, costUsd: 0.01, durationMs: 5 })],
    agentBoundaries: [],
  });
  assert.equal(waste.failedAttempts, 0);
  for (const agg of [waste.runtimeMs, waste.tokensIn, waste.tokensOut, waste.costUsd]) {
    assert.equal(agg.value, null);
    assert.equal(agg.quality, "unavailable");
  }
});

test("coordinator-only publish retries add zero agent waste but remain attempts", () => {
  const waste = deriveAttemptWaste({
    sessions: [session({ id: "s1" }), session({ id: "s2", status: "done" })],
    usages: [usage({ workerSessionId: "s1", tokensIn: 999, tokensOut: 999, costUsd: 9.99, durationMs: 999_999 })],
    agentBoundaries: [{ sessionId: "s1", startMs: 1, endMs: 999_999 }],
    publishOnlySessionIds: new Set(["s1"]),
  });
  assert.equal(waste.failedAttempts, 0, "publish-only is not an agent failure");
  assert.equal(waste.publishOnlyAttempts, 1);
  // Its rows/bounds are structurally excluded — not counted as missing either.
  assert.equal(waste.tokensIn.total, 0);
  assert.equal(waste.runtimeMs.total, 0);
});

// ------------------------------------------------------------- retry summary

test("cold retries are distinguishable from reused-work retries", () => {
  const summary = deriveRetrySummary({
    sessions: [session({ id: "s1", status: "failed" }), session({ id: "s2" }), session({ id: "s3" })],
    reuse: [
      { sessionId: "s2", kinds: ["worktree", "commit"], retryReason: "retry", ts: T1, cursor: 3 },
      { sessionId: "s3", kinds: [], retryReason: "retry", ts: T2, cursor: 5 },
    ],
  });
  assert.equal(summary.attempts, 2 + 1);
  assert.equal(summary.retries, 2);
  assert.equal(summary.reused, 1);
  assert.equal(summary.cold, 1);
  assert.equal(summary.unknown, 0);
  assert.deepEqual(summary.attemptsDetail[0]!.kinds, ["worktree", "commit"]);
  assert.equal(summary.attemptsDetail[0]!.cold, false);
  assert.equal(summary.attemptsDetail[1]!.cold, true);
});

test("a retry with no reuse record is unknown, not cold", () => {
  const summary = deriveRetrySummary({
    sessions: [session({ id: "s1" }), session({ id: "s2" })],
    reuse: [],
  });
  assert.equal(summary.retries, 1);
  assert.equal(summary.cold, 0);
  assert.equal(summary.unknown, 1);
  assert.equal(summary.attemptsDetail[0]!.cold, null);
  assert.equal(summary.attemptsDetail[0]!.quality, "unavailable");
});

test("legacy payloads derive publish_only as inferred, retryReason as unknown", () => {
  const summary = deriveRetrySummary({
    sessions: [session({ id: "s1" }), session({ id: "s2" }), session({ id: "s3" })],
    reuse: [],
    hints: new Map([
      ["s2", { publishOnly: true, retryReason: "presumed dead; republishing 1 commit" }],
      ["s3", { publishOnly: false, retryReason: "Developer session produced no PR." }],
    ]),
  });
  assert.equal(summary.reused, 1);
  assert.equal(summary.publishOnly, 1);
  assert.equal(summary.unknown, 1);
  assert.deepEqual(summary.attemptsDetail[0]!.kinds, ["publish_only"]);
  assert.equal(summary.attemptsDetail[0]!.quality, "inferred");
  assert.ok(summary.attemptsDetail[0]!.reasons.includes("backfill"));
  assert.equal(summary.attemptsDetail[1]!.cold, null);
  assert.equal(summary.attemptsDetail[1]!.quality, "inferred");
});
