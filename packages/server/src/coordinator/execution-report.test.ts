// NOT-175: builder tests for GET /api/execution-analysis — separate
// attempt/issue denominators, exact percentile passthrough, coverage that never
// coerces missing Cursor/provider data to zero, the visible unknown bucket,
// sparse samples, and pagination.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-exec-report-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, transitionIssue } = await import("../repository/issues.js");
const { createWorkerSession, completeSession, startSession } = await import("../repository/worker-sessions.js");
const { recordUsageEvent } = await import("../repository/usage-events.js");
const { appendWorkflowEvent } = await import("../repository/workflow-events.js");
const { buildExecutionReport, classifyFailureReason } = await import("./execution-report.js");

before(() => {
  migrate();
});

function seed() {
  // Issue A: done, two developer sessions (one failed retry with cost, one done
  // without cost evidence) + one reviewer session reusing the same input sha.
  const a = createIssue({
    title: "Report issue A",
    repo: "github.com/acme/app",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
  });
  const aDev1 = createWorkerSession({
    issueId: a.id, role: "developer", round: 1, agentId: BUILTIN_AGENT_CLAUDE_ID,
    runtime: "claude_code", model: "opus",
  });
  startSession(aDev1.id);
  completeSession(aDev1.id, { status: "failed", errorJson: JSON.stringify({ reason: "Rate limit 429, capacity exceeded" }) });
  recordUsageEvent({ issueId: a.id, workerSessionId: aDev1.id, role: "developer", runtime: "claude_code",
    tokensIn: 100, tokensOut: 50, costUsd: 1.5, durationMs: 60_000 });
  appendWorkflowEvent({ issueId: a.id, type: "worker.failed", actorType: "developer", stage: "developing",
    payload: { reason: "Rate limit 429, capacity exceeded" } });
  const aDev2 = createWorkerSession({
    issueId: a.id, role: "developer", round: 1, agentId: BUILTIN_AGENT_CLAUDE_ID,
    runtime: "claude_code", model: "opus", inputSha: "sha-1",
  });
  startSession(aDev2.id);
  completeSession(aDev2.id, { status: "done" });
  // No usage event: unknown cost/tokens must read as Unavailable, never $0.
  const aRev = createWorkerSession({
    issueId: a.id, role: "reviewer", round: 1, agentId: BUILTIN_AGENT_CURSOR_ID,
    runtime: "cursor_local", model: "cursor-default", inputSha: "sha-1",
  });
  startSession(aRev.id);
  completeSession(aRev.id, { status: "done" });
  recordUsageEvent({ issueId: a.id, workerSessionId: aRev.id, role: "reviewer", runtime: "cursor_local",
    tokensIn: 10, tokensOut: 5, costUsd: null, durationMs: 5_000 });
  transitionIssue(a.id, "developing");
  transitionIssue(a.id, "reviewing");
  transitionIssue(a.id, "final_review");
  transitionIssue(a.id, "done");

  // Issue B: closed with an ambiguous timeout failure (stays unknown).
  const b = createIssue({
    title: "Report issue B",
    repo: "github.com/acme/app",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
  });
  const bDev = createWorkerSession({
    issueId: b.id, role: "developer", round: 1, agentId: BUILTIN_AGENT_CLAUDE_ID,
    runtime: "codex_local", model: "gpt",
  });
  startSession(bDev.id);
  completeSession(bDev.id, { status: "timed_out", errorJson: JSON.stringify({ reason: "Timed out after 60 minutes" }) });
  transitionIssue(b.id, "closed");
  return { a, b };
}

const seeded = seed();

test("classifier keeps ambiguous timeouts unknown", () => {
  assert.equal(classifyFailureReason("Timed out after 60 minutes").code, "unknown");
  assert.equal(classifyFailureReason("Rate limit 429, capacity exceeded").code, "provider_capacity_rate_limit");
  assert.equal(classifyFailureReason(null).code, "unknown");
  assert.equal(classifyFailureReason("").code, "unknown");
});

test("attempt and issue denominators stay separate", () => {
  const report = buildExecutionReport({ status: [] });
  assert.equal(report.summary.issues, 2);
  assert.equal(report.summary.closedIssues, 2);
  assert.equal(report.summary.issueSuccess, 0.5);
  // 4 sessions, all terminal, 2 done.
  assert.equal(report.summary.attempts, 4);
  assert.equal(report.summary.terminalAttempts, 4);
  assert.equal(report.summary.attemptSuccess, 0.5);
  // 4 sessions over 2 issues → 50% retry waste.
  assert.equal(report.summary.retryRate, 0.5);
  assert.equal(report.summary.retryExtraAttempts, 2);
});

test("missing cost/token data is Unavailable with known/total, never zero", () => {
  const report = buildExecutionReport({});
  const claude = report.byRuntime.find((r) => r.key === "claude_code")!;
  assert.ok(claude);
  assert.equal(claude.costUsd.known, 1);
  assert.equal(claude.costUsd.total, 2);
  // Developer cohort: 3 sessions, 1 with recorded cost → partial sample.
  const dev = report.byRole.find((r) => r.key === "developer")!;
  assert.equal(dev.costUsd.known, 1);
  assert.equal(dev.costUsd.total, 3);
  assert.ok(dev.costUsd.reasons.includes("partial_sample"));
  assert.ok(Math.abs(dev.costUsd.sum! - 1.5) < 1e-9);
  // Reviewer cost is null (Cursor-style missing provider metadata) → unavailable.
  const reviewer = report.byRole.find((r) => r.key === "reviewer")!;
  assert.equal(reviewer.costUsd.sum, null);
  assert.equal(reviewer.costUsd.quality, "unavailable");
  assert.equal(reviewer.attempts, 1);
});

test("unknown failures have their own visible bucket", () => {
  const report = buildExecutionReport({});
  const unknown = report.failures.find((f) => f.code === "unknown")!;
  assert.ok(unknown, "unknown bucket must exist");
  assert.equal(unknown.domain, "unknown");
  assert.ok(unknown.issueIds.includes(seeded.b.id));
  const rate = report.failures.find((f) => f.code === "provider_capacity_rate_limit")!;
  assert.ok(rate.issueIds.includes(seeded.a.id));
  const total = report.failures.reduce((n, f) => n + f.count, 0);
  assert.equal(total, 2);
});

test("percentiles carry sample counts and phases stay unavailable", () => {
  const report = buildExecutionReport({});
  assert.ok(report.summary.sessionWallMs.n >= 0);
  assert.equal(report.summary.phaseWallMs.length, 4);
  for (const p of report.summary.phaseWallMs) {
    assert.equal(p.stat.n, 0);
    assert.equal(p.stat.p50, null);
    assert.equal(p.stat.quality, "unavailable");
  }
  assert.equal(report.meta.partial, true);
});

test("failed-attempt waste sums known values only", () => {
  const report = buildExecutionReport({});
  assert.ok(Math.abs(report.summary.failedCostUsd.sum! - 1.5) < 1e-9);
  assert.equal(report.summary.failedCostUsd.known, 1);
  assert.equal(report.summary.failedDurationMs.known, 1);
});

test("filters narrow the report and pagination pages the issue list", () => {
  const filtered = buildExecutionReport({ repo: "github.com/acme/app", role: "developer", limit: 1, page: 2 });
  assert.equal(filtered.summary.issues, 2);
  assert.equal(filtered.summary.attempts, 3);
  assert.equal(filtered.pagination.total, 2);
  assert.equal(filtered.pagination.totalPages, 2);
  assert.equal(filtered.pagination.page, 2);
  assert.equal(filtered.issues.length, 1);
  const empty = buildExecutionReport({ repo: "github.com/other/repo" });
  assert.equal(empty.summary.issues, 0);
  assert.equal(empty.summary.attemptSuccess, null);
  assert.equal(empty.summary.issueSuccess, null);
  assert.equal(empty.pagination.totalPages, 0);
  assert.deepEqual(empty.issues, []);
});

test("invalid date range is a 400-class error, not a silent empty report", () => {
  assert.throws(() => buildExecutionReport({ from: "not-a-date" }), /Invalid date range/);
});
