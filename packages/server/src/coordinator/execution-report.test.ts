// NOT-175: builder tests for GET /api/execution-report — separate
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
const { buildExecutionReport, classifyFailureReason, matchesSessionValue } = await import("./execution-report.js");
const { getCohortExecutionAnalysis } = await import("../read-models/execution-analysis.js");

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

test("classifier anchors keep author/release/unrelated spawn out of buckets", () => {
  // `auth` must not match "author"; `lease` must not match "release"/"please".
  assert.equal(classifyFailureReason("the author released a fix").code, "unknown");
  assert.equal(classifyFailureReason("please release a hotfix").code, "unknown");
  // Standalone words still classify.
  assert.equal(classifyFailureReason("lease expired on worker").code, "coordinator_crash");
  assert.equal(classifyFailureReason("could not spawn worker process").code, "agent_cli_crash");
  assert.equal(classifyFailureReason("failed to push to origin").code, "publish_git_failure");
  assert.equal(classifyFailureReason("authentication failed").code, "authentication_configuration");
  assert.equal(classifyFailureReason("auth failure").code, "authentication_configuration");
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
  // Retry waste is extra attempts after a terminal attempt in the same
  // (issue, role, round): only A's second developer attempt. The reviewer
  // session alongside developer sessions is normal workflow, not waste.
  assert.equal(report.summary.retryExtraAttempts, 1);
  assert.equal(report.summary.retryRate, 0.25);
  // Per-cohort retry follows the same definition.
  const dev = report.byRole.find((r) => r.key === "developer")!;
  assert.equal(dev.retryRate, 1 / 3);
  const reviewer = report.byRole.find((r) => r.key === "reviewer")!;
  assert.equal(reviewer.retryRate, 0);
  const claude = report.byRuntime.find((r) => r.key === "claude_code")!;
  assert.equal(claude.retryRate, 0.5);
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

test("phases are composed from the NOT-173 read model with sample counts", () => {
  const report = buildExecutionReport({});
  assert.ok(report.summary.sessionWallMs.n >= 0);
  assert.equal(report.summary.phaseWallMs.length, 4);
  // agent_process carries the NOT-173 usage-envelope backfill for the two
  // sessions with usage rows (5s reviewer + 60s failed developer): nearest-rank
  // P50/P95 with an explicit sample count, never a guess.
  const agent = report.summary.phaseWallMs.find((p) => p.phase === "agent_process")!;
  assert.equal(agent.stat.n, 2);
  assert.equal(agent.stat.p50, 5_000);
  assert.equal(agent.stat.p95, 60_000);
  assert.equal(agent.stat.quality, "inferred");
  assert.ok(agent.stat.reasons.includes("backfill"));
  // Phases without recorded boundaries stay unavailable with reasons — never zero.
  for (const p of report.summary.phaseWallMs) {
    assert.ok(typeof p.stat.n === "number");
    if (p.phase === "agent_process") continue;
    assert.equal(p.stat.n, 0);
    assert.equal(p.stat.p50, null);
    assert.equal(p.stat.p95, null);
    assert.equal(p.stat.quality, "unavailable");
    assert.ok(p.stat.reasons.length > 0);
  }
  assert.equal(report.meta.partial, true);
});

test("phase percentiles follow the session-level filter scope", () => {
  const filtered = buildExecutionReport({ runtime: "cursor_local" });
  // Only the reviewer attempt (5s usage backfill) contributes.
  const agent = filtered.summary.phaseWallMs.find((p) => p.phase === "agent_process")!;
  assert.equal(agent.stat.n, 1);
  assert.equal(agent.stat.p50, 5_000);
  assert.equal(agent.stat.p95, 5_000);
  const empty = buildExecutionReport({ runtime: "no_such_runtime" });
  for (const p of empty.summary.phaseWallMs) {
    assert.equal(p.stat.n, 0);
    assert.equal(p.stat.p50, null);
  }
});

test("unknown runtime/model filter matches null values, never everything", () => {
  assert.equal(matchesSessionValue(null, "unknown"), true);
  assert.equal(matchesSessionValue("", "unknown"), true);
  assert.equal(matchesSessionValue("cursor_local", "unknown"), false);
  assert.equal(matchesSessionValue("cursor_local", null), true);
  assert.equal(matchesSessionValue(null, null), true);
  // The seed has no null runtimes, so the unknown cohort is honestly empty.
  const unk = buildExecutionReport({ runtime: "unknown" });
  assert.equal(unk.summary.issues, 0);
  assert.equal(unk.summary.attempts, 0);
});

test("failed-attempt waste sums known values only", () => {
  const report = buildExecutionReport({});
  assert.ok(Math.abs(report.summary.failedCostUsd.sum! - 1.5) < 1e-9);
  assert.equal(report.summary.failedCostUsd.known, 1);
  assert.equal(report.summary.failedDurationMs.known, 1);
});

test("per-cohort failed waste is scoped to the cohort's failed attempts", () => {
  const report = buildExecutionReport({});
  const claude = report.byRuntime.find((r) => r.key === "claude_code")!;
  // Only A's failed developer session carries usage: 1/1 known, never zero-filled.
  assert.ok(Math.abs(claude.failedCostUsd.sum! - 1.5) < 1e-9);
  assert.equal(claude.failedCostUsd.known, 1);
  assert.equal(claude.failedCostUsd.total, 1);
  assert.equal(claude.failedTokensIn.sum, 100);
  assert.equal(claude.failedTokensOut.sum, 50);
  assert.equal(claude.failedDurationMs.sum, 60_000);
  // Cursor cohort has no failed attempts: Unavailable, never $0.
  const cursor = report.byRuntime.find((r) => r.key === "cursor_local")!;
  assert.equal(cursor.failedCostUsd.sum, null);
  assert.equal(cursor.failedCostUsd.quality, "unavailable");
  assert.equal(cursor.failedCostUsd.known, 0);
  assert.equal(cursor.failedCostUsd.total, 0);
});

test("role/runtime filters scope issues, success, failures, and pagination", () => {
  const filtered = buildExecutionReport({ runtime: "cursor_local" });
  // Only issue A has a cursor_local session; B (and its unknown failure)
  // drops out of every issue-level aggregate.
  assert.equal(filtered.summary.issues, 1);
  assert.equal(filtered.summary.closedIssues, 1);
  assert.equal(filtered.summary.issueSuccess, 1);
  assert.equal(filtered.summary.attempts, 1);
  assert.equal(filtered.summary.terminalAttempts, 1);
  assert.equal(filtered.summary.attemptSuccess, 1);
  assert.equal(filtered.pagination.total, 1);
  assert.equal(filtered.issues.length, 1);
  assert.equal(filtered.issues[0]!.id, seeded.a.id);
  assert.equal(filtered.issues[0]!.attempts, 1);
  assert.equal(filtered.summary.retryExtraAttempts, 0);
  assert.equal(filtered.summary.retryRate, 0);
  // Failures attribute only to matching failed sessions: the Cursor
  // reviewer-only cohort has no failed attempts, so no failure bucket — the
  // Claude developer's rate-limit payload must not leak in while
  // failed-waste cards show no failed attempts.
  assert.deepEqual(filtered.failures, []);

  const reviewers = buildExecutionReport({ role: "reviewer" });
  assert.equal(reviewers.summary.issues, 1);
  assert.equal(reviewers.pagination.total, 1);
  assert.ok(!reviewers.failures.some((f) => f.code === "unknown"));

  const empty = buildExecutionReport({ runtime: "no_such_runtime" });
  assert.equal(empty.summary.issues, 0);
  assert.equal(empty.summary.attempts, 0);
  assert.equal(empty.summary.retryRate, null);
  assert.equal(empty.summary.issueSuccess, null);
  assert.deepEqual(empty.failures, []);
  assert.equal(empty.pagination.total, 0);
  assert.deepEqual(empty.issues, []);
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

test("phase stats equal getCohortExecutionAnalysis for the same filters", () => {
  const now = Date.now();
  const base = {
    from: null, to: null, role: null, runtime: null, model: null,
    status: null, repo: null, limit: 50, offset: 0,
  };
  const cases = [
    { report: {}, cohort: { ...base } },
    { report: { runtime: "cursor_local" }, cohort: { ...base, runtime: "cursor_local" } },
    { report: { role: "developer" }, cohort: { ...base, role: "developer" } },
    { report: { status: ["done"] }, cohort: { ...base, status: "done" } },
    { report: { runtime: "no_such_runtime" }, cohort: { ...base, runtime: "no_such_runtime" } },
  ];
  for (const c of cases) {
    const report = buildExecutionReport(c.report, now);
    const cohort = getCohortExecutionAnalysis(c.cohort, now);
    // Same shared window (conservative default + 365-day cap).
    assert.equal(report.window.from, cohort.window.from);
    assert.equal(report.window.to, cohort.window.to);
    for (const { phase, stat } of report.summary.phaseWallMs) {
      assert.deepEqual(stat, cohort.phaseWallTime[phase], `phase ${phase} with ${JSON.stringify(c.report)}`);
    }
  }
});

test("window over 365 days is capped like the shared cohort window", () => {
  const now = Date.now();
  const from = new Date(now - 400 * 86_400_000).toISOString();
  const report = buildExecutionReport({ from }, now);
  const cohort = getCohortExecutionAnalysis({
    from, to: null, role: null, runtime: null, model: null,
    status: null, repo: null, limit: 50, offset: 0,
  }, now);
  assert.equal(report.window.from, cohort.window.from);
  assert.equal(report.window.to, cohort.window.to);
  assert.ok(Date.parse(report.window.from) > Date.parse(from), "span is capped, not unbounded");
  assert.equal(report.summary.issues, 2);
});

test("status filter matches session status, not just issue status", () => {
  // B's issue status is closed but its session timed_out: visible by session status.
  const bySession = buildExecutionReport({ status: ["timed_out"] });
  assert.equal(bySession.summary.issues, 1);
  assert.equal(bySession.issues[0]!.id, seeded.b.id);
  // A matches done via its issue status and its done sessions.
  const byDone = buildExecutionReport({ status: ["done"] });
  assert.equal(byDone.summary.issues, 1);
  assert.equal(byDone.issues[0]!.id, seeded.a.id);
  // Several statuses union with OR semantics.
  const both = buildExecutionReport({ status: ["done", "closed"] });
  assert.equal(both.summary.issues, 2);
});
