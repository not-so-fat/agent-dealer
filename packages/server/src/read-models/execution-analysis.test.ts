// packages/server/src/read-models/execution-analysis.test.ts
//
// NOT-173: pure read-model tests — union/percentile/covered aggregates,
// reviewer derivation, cohort window, and issue composition over synthetic
// evidence (no database).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composeCohortReport,
  composeIssueAnalysis,
  coveredTotal,
  deriveReviewerView,
  doneMarkerStore,
  filterIssueEvidence,
  hasAttemptFilter,
  nearestRank,
  percentileStat,
  rateStat,
  resolveCohortWindow,
  unionDurationMs,
  unionRanges,
  weakestQuality,
  type IssueEvidence,
} from "./execution-analysis.js";

const T0 = Date.parse("2026-09-21T10:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const MIN = 60_000;

function baseEvidence(overrides: Partial<IssueEvidence> = {}): IssueEvidence {
  return {
    issueId: "issue-1",
    events: [],
    sessions: [],
    usages: [],
    humanActions: [],
    failureCauses: [],
    activities: [],
    queueRows: [],
    instances: [{ issueId: "issue-1", startedAt: iso(T0), completedAt: iso(T0 + 60 * MIN), outcome: "done" }],
    nowMs: T0 + 90 * MIN,
    ...overrides,
  };
}

// ---------------------------------------------------------- union

test("unionRanges merges overlapping and adjacent half-open ranges", () => {
  // §9.2: [10:00,10:20) + [10:15,10:40) union to 40 min, not 45.
  assert.deepEqual(unionRanges([{ start: 0, end: 20 }, { start: 15, end: 40 }]), [{ start: 0, end: 40 }]);
  // Adjacent [a,b) + [b,c) share no time; the union length is still c - a.
  assert.equal(unionDurationMs([{ start: 0, end: 10 }, { start: 10, end: 30 }]), 30);
  assert.equal(unionDurationMs([{ start: 0, end: 20 }, { start: 15, end: 40 }]), 40);
});

test("unionRanges drops empty and invalid ranges", () => {
  assert.deepEqual(unionRanges([{ start: 5, end: 5 }, { start: 9, end: 3 }]), []);
  assert.equal(unionDurationMs([]), 0);
});

// ---------------------------------------------------------- percentiles

test("nearestRank follows ceil(p/100 * n) (§9.6)", () => {
  // Cost P50 over [$0.90, $1.10, $2.20]: rank = ceil(0.5·3) = 2 → $1.10.
  const sorted = [0.9, 1.1, 2.2];
  assert.equal(nearestRank(sorted, 50), 1.1);
  assert.equal(nearestRank(sorted, 95), 2.2);
  assert.equal(nearestRank([], 50), null);
  assert.equal(nearestRank([7], 95), 7);
});

test("percentileStat excludes nulls and reports the known sample count", () => {
  const stat = percentileStat([10, null, 30, undefined, 20]);
  assert.equal(stat.n, 3);
  assert.equal(stat.p50, 20);
  assert.equal(stat.p95, 30);
  assert.ok(stat.reasons.includes("partial_sample"));
});

test("percentileStat with no known observations is unavailable, never zero", () => {
  const stat = percentileStat([null, undefined]);
  assert.equal(stat.n, 0);
  assert.equal(stat.p50, null);
  assert.equal(stat.p95, null);
  assert.equal(stat.quality, "unavailable");
});

// ---------------------------------------------------------- covered totals

test("coveredTotal sums known values only with known/total counts", () => {
  // §9.6: $4.20 over 3 of 5 — exact with partial_sample, not $4.20/5.
  const total = coveredTotal([1.1, 0.9, 2.2, null, null]);
  assert.ok(Math.abs((total.value ?? 0) - 4.2) < 1e-9);
  assert.equal(total.known, 3);
  assert.equal(total.total, 5);
  assert.equal(total.quality, "exact");
  assert.ok(total.reasons.includes("partial_sample"));
});

test("coveredTotal with zero known is unavailable, never 0", () => {
  const total = coveredTotal([null, null]);
  assert.equal(total.value, null);
  assert.equal(total.quality, "unavailable");
  assert.equal(total.known, 0);
});

test("weakestQuality takes the weakest known input and unions reasons", () => {
  const { quality, reasons } = weakestQuality([
    { quality: "exact", reasons: [] },
    { quality: "inferred", reasons: ["proxy_boundary"] },
  ]);
  assert.equal(quality, "inferred");
  assert.ok(reasons.includes("proxy_boundary"));
});

test("rateStat keeps its own denominator", () => {
  const attempt = rateStat(2, 8);
  const issue = rateStat(1, 2);
  assert.equal(attempt.rate, 0.25);
  assert.equal(issue.rate, 0.5);
  assert.notEqual(attempt.denominator, issue.denominator);
  const empty = rateStat(0, 0);
  assert.equal(empty.rate, null);
  assert.equal(empty.quality, "unavailable");
});

// ---------------------------------------------------------- reviewer

test("deriveReviewerView computes the change-request rate over verdicts", () => {
  const view = deriveReviewerView({
    reviewerSessionCount: 2,
    verdicts: [{ verdict: "changes_requested" }, { verdict: "approved" }],
  });
  assert.equal(view.rounds, 2);
  assert.equal(view.verdicts, 2);
  assert.equal(view.changeRequests, 1);
  assert.equal(view.changeRequestRate, 0.5);
  assert.equal(view.quality, "exact");
});

test("deriveReviewerView without verdicts is inferred, without sessions unavailable", () => {
  assert.equal(deriveReviewerView({ reviewerSessionCount: 2, verdicts: [] }).quality, "inferred");
  const none = deriveReviewerView({ reviewerSessionCount: 0, verdicts: [] });
  assert.equal(none.quality, "unavailable");
  assert.equal(none.changeRequestRate, null);
});

// ---------------------------------------------------------- cohort window

test("resolveCohortWindow defaults to 30 days and caps at 365", () => {
  const now = Date.parse("2026-09-21T00:00:00.000Z");
  const def = resolveCohortWindow({ from: null, to: null, role: null, runtime: null, model: null, status: null, repo: null, limit: 50, offset: 0 }, now);
  assert.equal(def.defaultApplied, true);
  assert.equal(def.toMs, now);
  assert.equal(def.fromMs, now - 30 * 86_400_000);
  const capped = resolveCohortWindow(
    { from: "2020-01-01T00:00:00.000Z", to: "2026-09-21T00:00:00.000Z", role: null, runtime: null, model: null, status: null, repo: null, limit: 50, offset: 0 },
    now,
  );
  assert.equal(capped.defaultApplied, false);
  assert.equal(capped.toMs - capped.fromMs, 365 * 86_400_000);
});

// ---------------------------------------------------------- issue composition

test("overlapping attempts union by phase; nested/human wait stay out of the exclusive total", () => {
  const ev = baseEvidence({
    sessions: [
      { id: "s1", issueId: "issue-1", role: "developer", round: 1, runtime: "claude_code", model: "m", status: "failed", errorJson: "{}", createdAt: iso(T0) },
      { id: "s2", issueId: "issue-1", role: "developer", round: 1, runtime: "claude_code", model: "m", status: "done", errorJson: null, createdAt: iso(T0) },
    ],
    events: [
      // s1 agent_process [0,20m); s2 [15m,40m) — overlapping attempts (§9.2).
      { issueId: "issue-1", sessionId: "s1", type: "worker.started", ts: iso(T0), cursor: 1, payloadJson: null },
      { issueId: "issue-1", sessionId: "s1", type: "agent.started", ts: iso(T0), cursor: 2, payloadJson: null },
      { issueId: "issue-1", sessionId: "s1", type: "agent.completed", ts: iso(T0 + 20 * MIN), cursor: 3, payloadJson: null },
      { issueId: "issue-1", sessionId: "s1", type: "worker.failed", ts: iso(T0 + 21 * MIN), cursor: 4, payloadJson: null },
      { issueId: "issue-1", sessionId: "s2", type: "worker.started", ts: iso(T0 + 15 * MIN), cursor: 5, payloadJson: null },
      { issueId: "issue-1", sessionId: "s2", type: "agent.started", ts: iso(T0 + 15 * MIN), cursor: 6, payloadJson: null },
      { issueId: "issue-1", sessionId: "s2", type: "agent.completed", ts: iso(T0 + 40 * MIN), cursor: 7, payloadJson: null },
      { issueId: "issue-1", sessionId: "s2", type: "worker.completed", ts: iso(T0 + 41 * MIN), cursor: 8, payloadJson: null },
    ],
    usages: [
      { issueId: "issue-1", workerSessionId: "s1", tokensIn: 100, tokensOut: 50, costUsd: 1.1, durationMs: 20 * MIN, ts: iso(T0 + 20 * MIN) },
    ],
    // Overlapping human waits (§9.1): [0,10m) + [5m,20m) union to 20m.
    humanActions: [
      { issueId: "issue-1", requestedAt: iso(T0), resolvedAt: iso(T0 + 10 * MIN) },
      { issueId: "issue-1", requestedAt: iso(T0 + 5 * MIN), resolvedAt: iso(T0 + 20 * MIN) },
    ],
  });
  const analysis = composeIssueAnalysis(ev);
  const agent = analysis.unionedDurations.find((u) => u.phase === "agent_process")!;
  assert.equal(agent.durationMs, 40 * MIN);
  assert.equal(agent.quality, "exact");
  assert.equal(analysis.humanWaitMs, 20 * MIN);
  assert.equal(analysis.humanWaitQuality, "exact");
  assert.equal(analysis.interventionCount, 2);
  // Exclusive total = unioned top-level phases only: setup 0 + agent 40m +
  // validation (s1 1m + s2 1m union to 2m — disjoint) = 42m. Human wait excluded.
  assert.equal(analysis.exclusiveTotalMs, 42 * MIN);
  assert.ok(!analysis.exclusiveTotalReasons.includes("open_interval"));
  // Missing cost on s2 is preserved as null, not zero.
  assert.equal(analysis.attempts.find((a) => a.sessionId === "s2")!.costUsd, null);
  assert.equal(analysis.coverage.cost.known, 1);
  assert.equal(analysis.coverage.cost.total, 2);
});

test("open human actions close at now as inferred (§9.1)", () => {
  const analysis = composeIssueAnalysis(
    baseEvidence({
      humanActions: [{ issueId: "issue-1", requestedAt: iso(T0), resolvedAt: null }],
    }),
  );
  assert.equal(analysis.humanWaitMs, 90 * MIN);
  assert.equal(analysis.humanWaitQuality, "inferred");
  assert.ok(analysis.humanWaitReasons.includes("open_interval"));
});

test("primary failure is the earliest primary cause; the rest are consequences", () => {
  const cause = (overrides: Record<string, unknown>) => ({
    issueId: "issue-1",
    code: "unknown",
    domain: "unknown",
    primary: true,
    confidence: "low",
    evidenceSource: "workflow_event",
    occurredAt: null,
    eventCursor: null,
    rawReason: "boom",
    sessionId: null,
    logPath: null,
    eventId: null,
    eventType: null,
    quality: "exact",
    ...overrides,
  });
  const analysis = composeIssueAnalysis(
    baseEvidence({
      // Same millisecond: durable cursor decides, never the timestamp alone.
      failureCauses: [
        cause({ code: "validation_failure", domain: "task", primary: false, occurredAt: iso(T0 + 5 * MIN), eventCursor: 9, sessionId: "s1" }),
        cause({ code: "unknown", occurredAt: iso(T0 + 5 * MIN), eventCursor: 4, sessionId: "s1" }),
      ] as never,
    }),
  );
  assert.equal(analysis.primaryFailure?.code, "unknown");
  assert.equal(analysis.primaryFailure?.eventCursor, 4);
  assert.deepEqual(analysis.consequenceCauses.map((c) => c.code), ["validation_failure"]);
});

test("negative durations are unavailable, never clamped", () => {
  const analysis = composeIssueAnalysis(
    baseEvidence({
      sessions: [
        { id: "s1", issueId: "issue-1", role: "developer", round: 1, runtime: null, model: null, status: "failed", errorJson: "{}", createdAt: iso(T0) },
      ],
      events: [
        { issueId: "issue-1", sessionId: "s1", type: "worker.started", ts: iso(T0 + 10 * MIN), cursor: 1, payloadJson: null },
        { issueId: "issue-1", sessionId: "s1", type: "agent.started", ts: iso(T0), cursor: 2, payloadJson: null },
      ],
    }),
  );
  const setup = analysis.attempts[0]!.setup;
  assert.equal(setup.durationMs, null);
  assert.equal(setup.quality, "unavailable");
  assert.ok(setup.reasons.includes("negative_duration"));
});

test("issues with no failure evidence report an unavailable primary, not unknown-as-zero", () => {
  const analysis = composeIssueAnalysis(baseEvidence());
  assert.equal(analysis.primaryFailure, null);
  assert.equal(analysis.primaryFailureQuality, "unavailable");
  assert.ok(analysis.primaryFailureReasons.includes("missing_classification"));
  assert.equal(analysis.attempts.length, 0);
});

// ---------------------------------------------------------- cohort filter scoping

const cursorOnly = {
  from: null,
  to: null,
  role: null,
  runtime: "cursor_local",
  model: null,
  status: null,
  repo: null,
  limit: 50,
  offset: 0,
};

/** One issue with a failed claude_code attempt (session a) and a failed
 * cursor_local attempt (session b, reused retry). */
function mixedRuntimeEvidence(): IssueEvidence {
  const cause = (overrides: Record<string, unknown>) => ({
    issueId: "issue-1",
    code: "unknown",
    domain: "unknown",
    primary: true,
    confidence: "low",
    evidenceSource: "workflow_event",
    occurredAt: null,
    eventCursor: null,
    rawReason: "boom",
    sessionId: null,
    logPath: null,
    eventId: null,
    eventType: null,
    quality: "exact",
    ...overrides,
  });
  return baseEvidence({
    sessions: [
      { id: "a", issueId: "issue-1", role: "developer", round: 1, runtime: "claude_code", model: "m", status: "failed", errorJson: "{}", createdAt: iso(T0) },
      { id: "b", issueId: "issue-1", role: "developer", round: 1, runtime: "cursor_local", model: "m", status: "failed", errorJson: "{}", createdAt: iso(T0) },
    ],
    events: [
      { issueId: "issue-1", sessionId: "a", type: "worker.started", ts: iso(T0), cursor: 1, payloadJson: null },
      { issueId: "issue-1", sessionId: "a", type: "agent.started", ts: iso(T0 + MIN), cursor: 2, payloadJson: null },
      { issueId: "issue-1", sessionId: "a", type: "agent.completed", ts: iso(T0 + 11 * MIN), cursor: 3, payloadJson: null },
      { issueId: "issue-1", sessionId: "a", type: "worker.failed", ts: iso(T0 + 12 * MIN), cursor: 4, payloadJson: null },
      { issueId: "issue-1", sessionId: "b", type: "worker.started", ts: iso(T0 + 15 * MIN), cursor: 5, payloadJson: null },
      { issueId: "issue-1", sessionId: "b", type: "agent.started", ts: iso(T0 + 16 * MIN), cursor: 6, payloadJson: null },
      { issueId: "issue-1", sessionId: "b", type: "agent.completed", ts: iso(T0 + 26 * MIN), cursor: 7, payloadJson: null },
      { issueId: "issue-1", sessionId: "b", type: "worker.failed", ts: iso(T0 + 27 * MIN), cursor: 8, payloadJson: null },
      {
        issueId: "issue-1", sessionId: "b", type: "retry.reused", ts: iso(T0 + 16 * MIN), cursor: 9,
        payloadJson: JSON.stringify({ kinds: ["commit"], retryReason: "infra retry" }),
      },
    ],
    usages: [
      { issueId: "issue-1", workerSessionId: "a", tokensIn: 100, tokensOut: 50, costUsd: 1, durationMs: 10 * MIN, ts: iso(T0 + 11 * MIN) },
      { issueId: "issue-1", workerSessionId: "b", tokensIn: 300, tokensOut: 150, costUsd: 3, durationMs: 10 * MIN, ts: iso(T0 + 26 * MIN) },
    ],
    failureCauses: [
      cause({ sessionId: "a", occurredAt: iso(T0 + 12 * MIN), eventCursor: 4 }),
      cause({ code: "agent_cli_crash", domain: "infrastructure", sessionId: "b", occurredAt: iso(T0 + 27 * MIN), eventCursor: 8 }),
    ] as never,
  });
}

test("filterIssueEvidence keeps only matching attempts with exact waste semantics", () => {
  assert.equal(hasAttemptFilter(cursorOnly), true);
  assert.equal(
    hasAttemptFilter({ from: null, to: null, role: null, runtime: null, model: null, status: null, repo: null, limit: 50, offset: 0 }),
    false,
  );
  const ev = mixedRuntimeEvidence();
  const full = composeIssueAnalysis(ev);
  assert.equal(full.waste.failedAttempts, 2);
  assert.equal(full.waste.tokensIn.value, 400);
  assert.equal(full.primaryFailure?.code, "unknown");

  const scoped = composeIssueAnalysis(filterIssueEvidence(ev, cursorOnly));
  // Only the cursor_local failed attempt contributes waste now.
  assert.deepEqual(scoped.attempts.map((a) => a.sessionId), ["b"]);
  assert.equal(scoped.waste.failedAttempts, 1);
  assert.equal(scoped.waste.tokensIn.value, 300);
  assert.equal(scoped.waste.costUsd.value, 3);
  // Retry and primary failure follow the kept attempt as well.
  assert.deepEqual([scoped.retry.attempts, scoped.retry.retries, scoped.retry.reused], [1, 0, 0]);
  assert.equal(scoped.primaryFailure?.code, "agent_cli_crash");
});

test("composeIssueAnalysis passes per-attempt reuse kinds and preserved kinds through", () => {
  // NOT-174: session b reused the prior commit; session a is the first attempt.
  const full = composeIssueAnalysis(mixedRuntimeEvidence());
  assert.deepEqual(full.attempts.find((a) => a.sessionId === "b")?.reuseKinds, ["commit"]);
  assert.equal(full.attempts.find((a) => a.sessionId === "a")?.reuseKinds, undefined);
  assert.deepEqual(full.retry.preservedKinds, ["commit"]);
});

test("composeCohortReport aggregates attempt-scoped metrics from filtered analyses", () => {
  const ev = mixedRuntimeEvidence();
  const full = composeIssueAnalysis(ev);
  const scoped = composeIssueAnalysis(filterIssueEvidence(ev, cursorOnly));
  const window = resolveCohortWindow(cursorOnly, T0 + 90 * MIN);
  const page = { issueIds: ["issue-1"], totalIssues: 1 };
  doneMarkerStore.clear();
  doneMarkerStore.set("issue-1", true);
  try {
    const report = composeCohortReport([full], cursorOnly, window, page, [scoped]);
    assert.equal(report.waste.failedAttempts, 1);
    assert.equal(report.waste.tokensIn.value, 300);
    assert.deepEqual(report.primaryFailures, [{ code: "agent_cli_crash", count: 1, rate: 1 }]);
    assert.equal(report.primaryFailureDenominator, 1);
    // Attempt success still uses the filtered attempt denominator (0 done of 1).
    assert.deepEqual([report.attemptSuccess.numerator, report.attemptSuccess.denominator], [0, 1]);
    // Issue success keeps its own denominator over all cohort issues.
    assert.deepEqual([report.issueSuccess.numerator, report.issueSuccess.denominator], [1, 1]);
  } finally {
    doneMarkerStore.clear();
  }
});
