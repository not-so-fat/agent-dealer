// NOT-175: shared fixtures for the execution-report client and page tests.
// Minimal schema-valid ExecutionReportResponse objects; tests override fields
// per state (loading/error/empty/partial/pagination). Not shipped: no
// production module imports this file.
import type { CohortRow, ExecutionReportResponse } from "@agent-dealer/shared";

const PERCENTILE: { p50: number; p95: number; n: number; quality: "inferred"; reasons: string[] } = {
  p50: 1000, p95: 2000, n: 2, quality: "inferred", reasons: [],
};

const COVERED: { sum: number; known: number; total: number; quality: "exact"; reasons: string[] } = {
  sum: 100, known: 2, total: 2, quality: "exact", reasons: [],
};

const UNAVAILABLE_SUM: { sum: null; known: number; total: number; quality: "unavailable"; reasons: string[] } = {
  sum: null,
  known: 0,
  total: 0,
  quality: "unavailable",
  reasons: ["no_observations"],
};

export function fixtureCohort(over: Partial<CohortRow> = {}): CohortRow {
  return {
    key: "claude_code",
    issues: 2,
    attempts: 3,
    issueSuccess: 0.5,
    issueSuccessDenominator: 2,
    attemptSuccess: 0.5,
    attemptSuccessDenominator: 2,
    sessionWallMs: { ...PERCENTILE },
    spawnEnvelopeMs: { ...PERCENTILE },
    retryRate: 1 / 3,
    tokensIn: { ...COVERED },
    tokensOut: { ...COVERED },
    costUsd: { ...COVERED, sum: 4.2 },
    durationMs: { ...COVERED, sum: 65000, quality: "inferred", reasons: ["partial_sample"] },
    failedDurationMs: { sum: 60000, known: 1, total: 1, quality: "inferred", reasons: [] },
    failedTokensIn: { sum: 100, known: 1, total: 1, quality: "exact", reasons: [] },
    failedTokensOut: { sum: 50, known: 1, total: 1, quality: "exact", reasons: [] },
    failedCostUsd: { sum: 1.5, known: 1, total: 1, quality: "exact", reasons: [] },
    ...over,
  };
}

export function fixtureReport(
  over: Partial<ExecutionReportResponse> = {}
): ExecutionReportResponse {
  return {
    window: { from: "2026-08-22T00:00:00.000Z", to: "2026-09-21T00:00:00.000Z" },
    filters: { repo: null, role: null, runtime: null, model: null, status: [] },
    summary: {
      issues: 2,
      closedIssues: 2,
      issueSuccess: 0.5,
      attempts: 4,
      terminalAttempts: 4,
      attemptSuccess: 0.5,
      retryRate: 0.25,
      retryExtraAttempts: 1,
      reuseRate: 1,
      reuseDenominator: 1,
      humanWaitMs: 0,
      humanWaitQuality: "exact",
      interventions: 0,
      avgReviewerRounds: 1,
      reviewedIssues: 1,
      changeRequestRate: 0,
      sessionWallMs: { ...PERCENTILE },
      spawnEnvelopeMs: { ...PERCENTILE },
      checkpointMs: { ...PERCENTILE },
      phaseWallMs: [
        { phase: "queue_wait", stat: { p50: null, p95: null, n: 0, quality: "unavailable", reasons: ["missing_queue_terminal"] } },
        { phase: "coordinator_setup", stat: { p50: null, p95: null, n: 0, quality: "unavailable", reasons: ["no_defensible_boundary"] } },
        { phase: "agent_process", stat: { p50: null, p95: null, n: 0, quality: "unavailable", reasons: ["no_defensible_boundary"] } },
        { phase: "coordinator_validation_publish", stat: { p50: null, p95: null, n: 0, quality: "unavailable", reasons: ["no_defensible_boundary"] } },
      ],
      failedDurationMs: { sum: 60000, known: 1, total: 1, quality: "inferred", reasons: [] },
      failedTokensIn: { sum: 100, known: 1, total: 1, quality: "exact", reasons: [] },
      failedTokensOut: { sum: 50, known: 1, total: 1, quality: "exact", reasons: [] },
      failedCostUsd: { sum: 1.5, known: 1, total: 1, quality: "exact", reasons: [] },
    },
    byRole: [fixtureCohort({ key: "developer" }), fixtureCohort({ key: "reviewer", attempts: 1 })],
    byRuntime: [fixtureCohort({ key: "claude_code" })],
    byModel: [fixtureCohort({ key: "opus" })],
    failures: [
      { code: "provider_capacity_rate_limit", domain: "infrastructure", count: 1, share: 0.5, issueIds: ["issue-a"], issueTotal: 1 },
      { code: "unknown", domain: "unknown", count: 1, share: 0.5, issueIds: ["issue-b"], issueTotal: 1 },
    ],
    issues: [
      { id: "issue-a", title: "Report issue A", status: "done", repo: "github.com/acme/app", attempts: 3, updatedAt: "2026-09-20T00:00:00.000Z" },
    ],
    pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
    meta: {
      generatedAt: "2026-09-21T00:00:00.000Z",
      partial: true,
      partialReasons: ["partial_sample: some cost/token aggregates exclude unavailable provider metadata"],
    },
    ...over,
  };
}

export function unavailableSums() {
  return {
    failedDurationMs: { ...UNAVAILABLE_SUM },
    failedTokensIn: { ...UNAVAILABLE_SUM },
    failedTokensOut: { ...UNAVAILABLE_SUM },
    failedCostUsd: { ...UNAVAILABLE_SUM },
  };
}
