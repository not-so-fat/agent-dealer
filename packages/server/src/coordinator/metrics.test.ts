// packages/server/src/coordinator/metrics.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { HumanAction } from "@agent-dealer/shared";
import { computeHumanWaitMs, computeInterventionCount } from "./metrics.js";

function action(requestedAt: string, resolvedAt: string | null): HumanAction {
  return {
    id: "a",
    issueId: "i",
    workflowInstanceId: null,
    actionType: "policy_escalation",
    reason: "r",
    question: "q",
    evidenceJson: null,
    responseOptionsJson: null,
    continuationPreviewJson: null,
    status: resolvedAt ? "resolved" : "open",
    resolutionJson: null,
    resolvedBy: null,
    requestedAt,
    resolvedAt,
  };
}

test("computeHumanWaitMs sums a single resolved interval", () => {
  const ms = computeHumanWaitMs([action("2026-01-01T00:00:00.000Z", "2026-01-01T00:10:00.000Z")]);
  assert.equal(ms, 10 * 60_000);
});

test("computeHumanWaitMs does not double-count overlapping intervals", () => {
  const actions = [
    action("2026-01-01T00:00:00.000Z", "2026-01-01T00:10:00.000Z"),
    action("2026-01-01T00:05:00.000Z", "2026-01-01T00:15:00.000Z"),
  ];
  // Union is [00:00, 00:15] = 15 minutes, not 10+10=20.
  assert.equal(computeHumanWaitMs(actions), 15 * 60_000);
});

test("computeHumanWaitMs treats a still-open action as waiting until `now`", () => {
  const now = new Date("2026-01-01T00:20:00.000Z").getTime();
  const ms = computeHumanWaitMs([action("2026-01-01T00:00:00.000Z", null)], now);
  assert.equal(ms, 20 * 60_000);
});

test("computeHumanWaitMs sums disjoint intervals", () => {
  const actions = [
    action("2026-01-01T00:00:00.000Z", "2026-01-01T00:05:00.000Z"),
    action("2026-01-01T01:00:00.000Z", "2026-01-01T01:05:00.000Z"),
  ];
  assert.equal(computeHumanWaitMs(actions), 10 * 60_000);
});

test("computeInterventionCount counts every action raised, resolved or not", () => {
  const actions = [action("2026-01-01T00:00:00.000Z", "2026-01-01T00:05:00.000Z"), action("2026-01-01T01:00:00.000Z", null)];
  assert.equal(computeInterventionCount(actions), 2);
});
