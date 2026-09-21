// packages/server/src/routes/execution-analysis.test.ts
//
// NOT-173: API schema/integration tests for the issue and cohort
// execution-analysis endpoints — fixtures for unknown failure, host sleep,
// publish-only retry, reused retry, overlapping attempts, overlapping human
// waits, and incomplete provider metadata; filter/pagination tests; and
// query-count / query-plan assertions against N+1 SQL.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-exec-analysis-"));

const { migrate, getDb } = await import("../db/index.js");
const {
  BUILTIN_AGENT_CLAUDE_ID,
  BUILTIN_AGENT_CURSOR_ID,
  IssueExecutionAnalysis,
  CohortExecutionReport,
} = await import("@agent-dealer/shared");
const { registerIssueRoutes } = await import("./issues.js");
const { registerExecutionAnalysisRoutes } = await import("./execution-analysis.js");
const { createIssue } = await import("../repository/issues.js");
const { createWorkerSession, completeSession } = await import("../repository/worker-sessions.js");
const { startWorkflowInstance } = await import("../repository/workflow-events.js");
const { recordUsageEvent } = await import("../repository/usage-events.js");
const { createHumanAction } = await import("../repository/human-actions.js");
const { recordFailureCauses } = await import("../repository/failure-causes.js");
const { insertSessionActivityEvent } = await import("../repository/session-activity.js");
const { setAdmissionHealthCheckerForTests } = await import("../coordinator/admission.js");

const T0 = Date.parse("2026-09-21T10:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const MIN = 60_000;

before(() => {
  migrate();
  setAdmissionHealthCheckerForTests(async () => ({ ok: true }));
});

beforeEach(() => {
  getDb().exec(`
    DELETE FROM session_activity_events;
    DELETE FROM failure_causes;
    DELETE FROM human_actions;
    DELETE FROM usage_events;
    DELETE FROM workflow_events;
    DELETE FROM worker_sessions;
    DELETE FROM workflow_instances;
    DELETE FROM queue_entries;
    DELETE FROM work_items;
    DELETE FROM issues;
  `);
});

async function buildApp() {
  const app = Fastify();
  await registerIssueRoutes(app);
  await registerExecutionAnalysisRoutes(app);
  return app;
}

/** Direct event insert with a controlled timestamp; returns the rowid cursor. */
function insertEvent(input: {
  issueId: string;
  instanceId?: string | null;
  sessionId?: string | null;
  type: string;
  ts: string;
  payload?: unknown;
}): number {
  const db = getDb();
  db.prepare(
    `INSERT INTO workflow_events
       (id, issue_id, workflow_instance_id, worker_session_id, type, actor_type, actor_ref, stage, round, payload_json, artifact_ref, idempotency_key, causation_event_id, ts)
     VALUES (@id, @issue_id, @workflow_instance_id, @worker_session_id, @type, 'coordinator', NULL, 'developing', NULL, @payload_json, NULL, NULL, NULL, @ts)`
  ).run({
    id: randomUUID(),
    issue_id: input.issueId,
    workflow_instance_id: input.instanceId ?? null,
    worker_session_id: input.sessionId ?? null,
    type: input.type,
    payload_json: input.payload !== undefined ? JSON.stringify(input.payload) : null,
    ts: input.ts,
  });
  const row = db.prepare("SELECT last_insert_rowid() AS r").get() as { r: number };
  return row.r;
}

function makeSession(issueId: string, opts: {
  role?: "developer" | "reviewer";
  runtime?: "claude_code" | "cursor_local";
  model?: string | null;
  status?: "done" | "failed" | "timed_out";
}): string {
  const session = createWorkerSession({
    issueId,
    role: opts.role ?? "developer",
    round: 1,
    agentId: BUILTIN_AGENT_CLAUDE_ID,
    runtime: opts.runtime ?? "claude_code",
    model: opts.model ?? "model-a",
  });
  completeSession(session.id, {
    status: opts.status ?? "done",
    errorJson: opts.status && opts.status !== "done" ? JSON.stringify({ reason: "seeded failure" }) : null,
  });
  return session.id;
}

function makeInstance(issueId: string, startedAt: string, completedAt: string | null, outcome: "done" | null): string {
  const instance = startWorkflowInstance(issueId, "v1");
  getDb().prepare("UPDATE workflow_instances SET started_at = ?, completed_at = ?, outcome = ? WHERE id = ?").run(
    startedAt, completedAt, outcome, instance.id
  );
  return instance.id;
}

function makeCause(overrides: Record<string, unknown>) {
  return {
    code: "unknown",
    domain: "unknown",
    primary: true,
    confidence: "low",
    evidenceSource: "workflow_event",
    occurredAt: null,
    eventCursor: null,
    rawReason: "seeded",
    sessionId: null,
    logPath: null,
    eventId: null,
    eventType: null,
    quality: "exact",
    ...overrides,
  };
}

/** The rich fixture: overlapping attempts, unknown failures, host sleep,
 * reused + publish-only retries, overlapping human waits, partial provider
 * metadata. Returns the issue id. */
function seedRichIssue(): string {
  const issue = createIssue({
    title: "Rich analysis issue",
    repo: "acme/app",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
  });
  const issueId = issue.id;
  const instanceId = makeInstance(issueId, iso(T0), iso(T0 + 70 * MIN), "done");

  // Queue evidence: 10m wait with capacity + runtime-health segments.
  const qid = randomUUID();
  getDb().prepare(
    "INSERT INTO queue_entries (id, issue_id, position, enqueued_at, state) VALUES (?, ?, 0, ?, 'admitted')"
  ).run(qid, issueId, iso(T0 - 10 * MIN));
  insertEvent({ issueId, type: "queue.enqueued", ts: iso(T0 - 10 * MIN), payload: { queueEntryId: qid } });
  insertEvent({
    issueId, type: "queue.wait_reason_changed", ts: iso(T0 - 9 * MIN),
    payload: { queueEntryId: qid, to: "waiting for slot: no free admission slots", category: "capacity" },
  });
  insertEvent({
    issueId, type: "queue.wait_reason_changed", ts: iso(T0 - 5 * MIN),
    payload: { queueEntryId: qid, to: "cursor runtime unhealthy: probe timed out", category: "runtime_health" },
  });
  insertEvent({ issueId, type: "queue.admitted", ts: iso(T0), payload: { queueEntryId: qid } });

  // S0: timed_out with no usage row at all (restart-class gap: evidence ends,
  // no provider metadata) and an unknown primary cause.
  const s0 = makeSession(issueId, { status: "timed_out" });
  insertEvent({ issueId, instanceId, sessionId: s0, type: "worker.started", ts: iso(T0) });
  insertEvent({ issueId, instanceId, sessionId: s0, type: "agent.started", ts: iso(T0 + 0.5 * MIN) });
  insertEvent({ issueId, instanceId, sessionId: s0, type: "agent.completed", ts: iso(T0 + 10 * MIN) });
  const s0Failed = insertEvent({ issueId, instanceId, sessionId: s0, type: "worker.failed", ts: iso(T0 + 11 * MIN) });
  recordFailureCauses([{
    issueId,
    workflowInstanceId: instanceId,
    cause: makeCause({ sessionId: s0, occurredAt: iso(T0 + 11 * MIN), eventCursor: s0Failed, rawReason: "timeout, no tool in flight" }) as never,
  }]);

  // S1: failed with exact agent bounds, host sleep, and a consequence cause.
  const s1 = makeSession(issueId, { status: "failed" });
  insertEvent({ issueId, instanceId, sessionId: s1, type: "worker.started", ts: iso(T0 + MIN) });
  insertEvent({ issueId, instanceId, sessionId: s1, type: "agent.started", ts: iso(T0 + 2 * MIN) });
  insertEvent({
    issueId, instanceId, sessionId: s1, type: "host.suspended", ts: iso(T0 + 12 * MIN),
    payload: { detectedAt: iso(T0 + 12 * MIN), unelapsedMs: 5 * MIN, wallGapMs: 43 * MIN },
  });
  insertEvent({ issueId, instanceId, sessionId: s1, type: "agent.completed", ts: iso(T0 + 22 * MIN) });
  const s1Failed = insertEvent({ issueId, instanceId, sessionId: s1, type: "worker.failed", ts: iso(T0 + 23 * MIN) });
  insertSessionActivityEvent({
    issueId, workerSessionId: s1, observedAt: iso(T0 + 3 * MIN),
    activityKind: "tool_started", state: "started", callId: "tu_1", summary: "Running: npm test",
  });
  insertSessionActivityEvent({
    issueId, workerSessionId: s1, observedAt: iso(T0 + 20 * MIN),
    activityKind: "assistant_output", state: "observed", summary: "Back from the long run",
  });
  recordUsageEvent({
    issueId, workerSessionId: s1, role: "developer", runtime: "claude_code",
    tokensIn: 100, tokensOut: 50, costUsd: 1.1, durationMs: 20 * MIN, model: "model-a",
  });
  recordFailureCauses([
    {
      issueId,
      workflowInstanceId: instanceId,
      cause: makeCause({ sessionId: s1, occurredAt: iso(T0 + 23 * MIN), eventCursor: s1Failed, rawReason: "exit before verdict" }) as never,
    },
    {
      issueId,
      workflowInstanceId: instanceId,
      cause: makeCause({
        code: "validation_failure", domain: "task", primary: false, confidence: "medium",
        evidenceSource: "workflow_event", sessionId: s1, occurredAt: iso(T0 + 23 * MIN),
        eventCursor: s1Failed + 1, rawReason: "checks failed after the crash", quality: "inferred",
      }) as never,
    },
  ]);

  // S2: overlapping successful retry that reused the prior commit, with a
  // checkpoint but no cost evidence (incomplete provider metadata).
  const s2 = makeSession(issueId, { status: "done" });
  insertEvent({ issueId, instanceId, sessionId: s2, type: "worker.started", ts: iso(T0 + 15 * MIN) });
  insertEvent({ issueId, instanceId, sessionId: s2, type: "agent.started", ts: iso(T0 + 16 * MIN) });
  insertEvent({
    issueId, instanceId, sessionId: s2, type: "checkpoint.observed", ts: iso(T0 + 30 * MIN),
    payload: { kind: "commit", observedSha: "a".repeat(40), observedAt: iso(T0 + 30 * MIN), origin: "sampler", inputSha: "b".repeat(40), samplingPrecisionMs: 10_000, branch: "issue-x" },
  });
  insertEvent({ issueId, instanceId, sessionId: s2, type: "agent.completed", ts: iso(T0 + 36 * MIN) });
  insertEvent({ issueId, instanceId, sessionId: s2, type: "worker.completed", ts: iso(T0 + 38 * MIN) });
  insertEvent({
    issueId, instanceId, sessionId: s2, type: "retry.reused", ts: iso(T0 + 16 * MIN),
    payload: { kinds: ["commit"], retryReason: "infra retry" },
  });
  recordUsageEvent({
    issueId, workerSessionId: s2, role: "developer", runtime: "claude_code",
    tokensIn: 200, tokensOut: 100, costUsd: null, durationMs: 20 * MIN, model: "model-a",
  });

  // S3/S4: two reviewer rounds — one change request, one approval.
  const s3 = makeSession(issueId, { role: "reviewer", runtime: "cursor_local", model: "model-b" });
  insertEvent({ issueId, instanceId, sessionId: s3, type: "worker.started", ts: iso(T0 + 40 * MIN) });
  insertEvent({ issueId, instanceId, sessionId: s3, type: "agent.started", ts: iso(T0 + 41 * MIN) });
  insertEvent({ issueId, instanceId, sessionId: s3, type: "agent.completed", ts: iso(T0 + 50 * MIN) });
  insertEvent({ issueId, instanceId, sessionId: s3, type: "review.submitted", ts: iso(T0 + 51 * MIN), payload: { verdict: "changes_requested" } });
  insertEvent({ issueId, instanceId, sessionId: s3, type: "worker.completed", ts: iso(T0 + 52 * MIN) });
  recordUsageEvent({
    issueId, workerSessionId: s3, role: "reviewer", runtime: "cursor_local",
    tokensIn: 50, tokensOut: 10, costUsd: 0.5, durationMs: 9 * MIN, model: "model-b",
  });
  const s4 = makeSession(issueId, { role: "reviewer", runtime: "cursor_local", model: "model-b" });
  insertEvent({ issueId, instanceId, sessionId: s4, type: "worker.started", ts: iso(T0 + 55 * MIN) });
  insertEvent({ issueId, instanceId, sessionId: s4, type: "agent.started", ts: iso(T0 + 56 * MIN) });
  insertEvent({ issueId, instanceId, sessionId: s4, type: "agent.completed", ts: iso(T0 + 64 * MIN) });
  insertEvent({ issueId, instanceId, sessionId: s4, type: "review.submitted", ts: iso(T0 + 64 * MIN), payload: { verdict: "approved" } });
  insertEvent({ issueId, instanceId, sessionId: s4, type: "worker.completed", ts: iso(T0 + 65 * MIN) });
  recordUsageEvent({
    issueId, workerSessionId: s4, role: "reviewer", runtime: "cursor_local",
    tokensIn: 60, tokensOut: 12, costUsd: 0.5, durationMs: 8 * MIN, model: "model-b",
  });

  // S5: publish-only retry — no agent process, zero agent waste.
  const s5 = makeSession(issueId, { status: "done" });
  insertEvent({ issueId, instanceId, sessionId: s5, type: "worker.started", ts: iso(T0 + 66 * MIN) });
  insertEvent({ issueId, instanceId, sessionId: s5, type: "worker.completed", ts: iso(T0 + 68 * MIN), payload: { publishOnly: true } });
  insertEvent({
    issueId, instanceId, sessionId: s5, type: "retry.reused", ts: iso(T0 + 66 * MIN),
    payload: { kinds: ["publish_only"], retryReason: "republish" },
  });

  // Overlapping human waits: [5m,15m) + [10m,20m) union to 15m.
  for (const [start, end] of [[T0 + 5 * MIN, T0 + 15 * MIN], [T0 + 10 * MIN, T0 + 20 * MIN]] as const) {
    const action = createHumanAction({
      issueId, actionType: "product_scope_decision", reason: "seed", question: "seed?",
    });
    getDb().prepare("UPDATE human_actions SET requested_at = ?, resolved_at = ?, status = 'resolved' WHERE id = ?").run(
      iso(start), iso(end), action.id
    );
  }
  return issueId;
}

test("issue endpoint 404s for unknown issues", async () => {
  const app = await buildApp();
  try {
    const res = await app.inject({ method: "GET", url: `/api/issues/${randomUUID()}/execution-analysis` });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("issue endpoint answers every product question with stable documented fields", async () => {
  const app = await buildApp();
  try {
    const issueId = seedRichIssue();
    const res = await app.inject({ method: "GET", url: `/api/issues/${issueId}/execution-analysis` });
    assert.equal(res.statusCode, 200);
    const parsed = IssueExecutionAnalysis.safeParse(res.json());
    assert.ok(parsed.success, `schema mismatch: ${JSON.stringify(parsed.error?.issues.slice(0, 3))}`);
    const body = parsed.data;

    // Elapsed: workflow start → completion, exact.
    assert.equal(body.elapsed.durationMs, 70 * MIN);
    assert.equal(body.elapsed.quality, "exact");

    // Overlapping attempts union by phase (§9.2): [0.5,36) + [41,50) + [56,64).
    const agent = body.unionedDurations.find((u) => u.phase === "agent_process")!;
    assert.equal(agent.durationMs, 52.5 * MIN);
    assert.equal(agent.quality, "exact");

    // Exclusive total leaves out human wait (15m) and nested drill-downs.
    assert.equal(body.exclusiveTotalMs, 76 * MIN);
    assert.equal(body.exclusiveTotalQuality, "exact");

    // Queue wait with nested admission + preflight drill-down.
    const queue = body.unionedDurations.find((u) => u.phase === "queue_wait")!;
    assert.equal(queue.durationMs, 10 * MIN);
    const admission = body.nested.filter((n) => n.kind === "admission_dependency_wait");
    assert.ok(admission.some((n) => n.category === "capacity"));
    assert.ok(admission.some((n) => n.category === "runtime_health"));
    const preflight = body.nested.filter((n) => n.kind === "runtime_health_preflight");
    assert.equal(preflight.length, 1);
    assert.equal(preflight[0]!.quality, "inferred");

    // Per-attempt role/runtime/model/status.
    assert.equal(body.attempts.length, 6);
    const byId = new Map(body.attempts.map((a) => [a.sessionId, a]));
    for (const attempt of body.attempts) {
      assert.ok(attempt.role === "developer" || attempt.role === "reviewer");
      assert.ok(typeof attempt.status === "string");
    }
    assert.equal(byId.size, 6);

    // Primary failure (earliest unknown) plus the consequence cause.
    assert.equal(body.primaryFailure?.code, "unknown");
    assert.deepEqual(body.consequenceCauses.map((c) => c.code), ["validation_failure"]);

    // Failed-attempt waste over known values only: S0 has no usage row.
    assert.equal(body.waste.failedAttempts, 2);
    assert.equal(body.waste.publishOnlyAttempts, 0);
    assert.equal(body.waste.runtimeMs.known, 2);
    assert.equal(body.waste.tokensIn.value, 100);
    assert.deepEqual([body.waste.tokensIn.known, body.waste.tokensIn.total], [1, 2]);
    assert.ok(body.waste.tokensIn.reasons.includes("partial_sample"));
    assert.equal(body.waste.costUsd.value, 1.1);
    assert.deepEqual([body.waste.costUsd.known, body.waste.costUsd.total], [1, 2]);

    // First checkpoint 30m after workflow start, exact.
    assert.equal(body.firstCheckpoint.kind, "commit");
    assert.equal(body.firstCheckpoint.msSinceWorkflowStart, 30 * MIN);
    assert.equal(body.firstCheckpoint.quality, "exact");

    // Retry reuse: S2 reused, S5 publish-only reused, S1 unknown.
    assert.deepEqual(
      [body.retry.attempts, body.retry.retries, body.retry.reused, body.retry.unknown, body.retry.cold, body.retry.publishOnly],
      [4, 3, 2, 1, 0, 1],
    );
    assert.equal(body.retry.reuseRate, 1);
    assert.ok(body.retry.reasons.includes("partial_sample"));

    // Reviewer rounds / change-request rate.
    assert.equal(body.reviewer.rounds, 2);
    assert.equal(body.reviewer.verdicts, 2);
    assert.equal(body.reviewer.changeRequests, 1);
    assert.equal(body.reviewer.changeRequestRate, 0.5);

    // Overlapping human waits union to 15m, reported beside the total.
    assert.equal(body.humanWaitMs, 15 * MIN);
    assert.equal(body.humanWaitQuality, "exact");
    assert.equal(body.interventionCount, 2);

    // Host-sleep silence is nested, never additive.
    const silence = body.nested.filter((n) => n.kind === "unexplained_silence");
    assert.ok(silence.length > 0);
    assert.ok(silence.some((n) => n.category === "host_suspended"));

    // Missing cost/token/duration stay null with known/total coverage.
    assert.equal(body.coverage.duration.known, 5);
    assert.equal(body.coverage.duration.total, 6);
    assert.equal(body.coverage.tokens.known, 4);
    assert.equal(body.coverage.cost.known, 3);
  } finally {
    await app.close();
  }
});

test("existing issue-detail consumers stay compatible", async () => {
  const app = await buildApp();
  try {
    const issueId = seedRichIssue();
    const res = await app.inject({ method: "GET", url: `/api/issues/${issueId}` });
    assert.equal(res.statusCode, 200);
    const body = res.json() as Record<string, unknown>;
    for (const key of [
      "issue", "timeline", "humanActions", "findings", "usageSummary", "readiness",
      "humanWaitMs", "interventionCount", "latestWorkflowInstance",
    ]) {
      assert.ok(key in body, `missing legacy key: ${key}`);
    }
    assert.equal((body as { humanWaitMs: number }).humanWaitMs, 15 * MIN);
    assert.equal((body as { interventionCount: number }).interventionCount, 2);
  } finally {
    await app.close();
  }
});

const WINDOW = `from=${encodeURIComponent(iso(T0 - 60 * MIN))}&to=${encodeURIComponent(iso(T0 + 120 * MIN))}`;

test("cohort endpoint aggregates with separate attempt and issue denominators", async () => {
  const app = await buildApp();
  try {
    seedRichIssue();
    seedSimpleIssue();
    const res = await app.inject({ method: "GET", url: `/api/execution-analysis?${WINDOW}` });
    assert.equal(res.statusCode, 200);
    const parsed = CohortExecutionReport.safeParse(res.json());
    assert.ok(parsed.success, `schema mismatch: ${JSON.stringify(parsed.error?.issues.slice(0, 3))}`);
    const body = parsed.data;

    assert.equal(body.pagination.totalIssues, 2);
    assert.equal(body.issueIds.length, 2);
    assert.equal(body.window.defaultApplied, false);

    // Attempt success: 5 done of 7 sessions. Issue success: 2 of 2 issues.
    assert.deepEqual([body.attemptSuccess.numerator, body.attemptSuccess.denominator], [5, 7]);
    assert.deepEqual([body.issueSuccess.numerator, body.issueSuccess.denominator], [2, 2]);

    // Phase wall time carries P50/P95 with sample counts.
    for (const phase of ["coordinator_setup", "agent_process", "coordinator_validation_publish"]) {
      const stat = body.phaseWallTime[phase]!;
      assert.ok(stat.p50 !== null && stat.p95 !== null && stat.n > 0, phase);
    }
    assert.ok((body.phaseWallTime.queue_wait?.n ?? 0) >= 1);

    // Primary failures counted over issues with a recorded primary.
    assert.deepEqual(body.primaryFailures, [{ code: "unknown", count: 1, rate: 1 }]);
    assert.equal(body.primaryFailureDenominator, 1);

    // Waste, checkpoint latency, retry reuse, reviewer, interventions.
    assert.equal(body.waste.failedAttempts, 2);
    assert.ok(body.waste.costUsd.known < body.waste.costUsd.total);
    assert.ok((body.checkpointLatencyMs.n ?? 0) >= 1);
    assert.equal(body.retryReuse.rate, 1);
    assert.equal(body.reviewer.rounds, 2);
    assert.equal(body.reviewer.changeRequestRate, 0.5);
    assert.equal(body.humanInterventions.totalActions, 2);
    assert.equal(body.humanInterventions.issuesWithIntervention, 1);

    // Missing cost/token/duration stay visible in coverage and slices.
    assert.ok(body.coverage.cost.known < body.coverage.cost.total);
    assert.ok(body.coverage.cost.reasons.includes("partial_sample"));
    assert.ok(body.byRole.some((s) => s.key === "developer"));
    assert.ok(body.byRole.some((s) => s.key === "reviewer"));
    assert.ok(body.byRuntime.some((s) => s.key === "claude_code"));
    assert.ok(body.byRuntime.some((s) => s.key === "cursor_local"));
  } finally {
    await app.close();
  }
});

test("cohort endpoint supports every listed filter", async () => {
  const app = await buildApp();
  try {
    seedRichIssue();
    const simple = seedSimpleIssue();

    const get = async (qs: string) => {
      const res = await app.inject({ method: "GET", url: `/api/execution-analysis?${WINDOW}&${qs}` });
      assert.equal(res.statusCode, 200);
      return res.json() as { pagination: { totalIssues: number }; issueIds: string[]; attemptSuccess: { denominator: number } };
    };

    // Role narrows both the issues (EXISTS) and the attempts.
    const reviewer = await get("role=reviewer");
    assert.equal(reviewer.pagination.totalIssues, 1);
    assert.equal(reviewer.attemptSuccess.denominator, 2);

    // Runtime / model slices.
    const cursor = await get("runtime=cursor_local");
    assert.equal(cursor.pagination.totalIssues, 1);
    const modelA = await get("model=model-a");
    assert.equal(modelA.pagination.totalIssues, 2);

    // Status matches failed sessions.
    const failed = await get("status=failed");
    assert.equal(failed.pagination.totalIssues, 1);
    assert.equal(failed.attemptSuccess.denominator, 1);

    // Repository isolates the simple issue.
    const repo = await get(`repo=${encodeURIComponent(simple.repo)}`);
    assert.equal(repo.pagination.totalIssues, 1);
    assert.deepEqual(repo.issueIds, [simple.id]);

    // A date window that excludes the fixtures finds nothing, honestly.
    const emptyRes = await app.inject({
      method: "GET",
      url: `/api/execution-analysis?from=${encodeURIComponent(iso(T0 - 400 * 86_400_000))}&to=${encodeURIComponent(iso(T0 - 399 * 86_400_000))}`,
    });
    assert.equal(emptyRes.statusCode, 200);
    assert.equal((emptyRes.json() as { pagination: { totalIssues: number } }).pagination.totalIssues, 0);
  } finally {
    await app.close();
  }
});

test("cohort endpoint paginates with a stable order and bounds", async () => {
  const app = await buildApp();
  try {
    seedRichIssue();
    seedSimpleIssue();

    const first = await app.inject({ method: "GET", url: `/api/execution-analysis?${WINDOW}&limit=1&offset=0` });
    assert.equal(first.statusCode, 200);
    const firstBody = first.json() as { issueIds: string[]; pagination: { totalIssues: number } };
    assert.equal(firstBody.issueIds.length, 1);
    assert.equal(firstBody.pagination.totalIssues, 2);

    const second = await app.inject({ method: "GET", url: `/api/execution-analysis?${WINDOW}&limit=1&offset=1` });
    const secondBody = second.json() as { issueIds: string[] };
    assert.equal(secondBody.issueIds.length, 1);
    assert.notDeepEqual(secondBody.issueIds, firstBody.issueIds);

    // Repeat pages are stable.
    const repeat = await app.inject({ method: "GET", url: `/api/execution-analysis?${WINDOW}&limit=1&offset=0` });
    assert.deepEqual((repeat.json() as { issueIds: string[] }).issueIds, firstBody.issueIds);

    for (const url of [
      `/api/execution-analysis?from=not-a-date`,
      `/api/execution-analysis?to=${encodeURIComponent(iso(T0))}&from=${encodeURIComponent(iso(T0 + MIN))}`,
      `/api/execution-analysis?limit=0`,
      `/api/execution-analysis?limit=201`,
    ]) {
      const bad = await app.inject({ method: "GET", url });
      assert.equal(bad.statusCode, 400, url);
    }
  } finally {
    await app.close();
  }
});

test("cohort query count is constant per chunk, not per issue/session", async () => {
  const app = await buildApp();
  try {
    seedRichIssue();
    seedSimpleIssue();
    const db = getDb() as unknown as { prepare: (...args: unknown[]) => unknown };
    const original = db.prepare.bind(db);
    let prepares = 0;
    (db as { prepare: unknown }).prepare = (...args: unknown[]) => {
      prepares += 1;
      return (original as (...a: unknown[]) => unknown)(...args);
    };
    try {
      const first = await app.inject({ method: "GET", url: `/api/execution-analysis?${WINDOW}` });
      assert.equal(first.statusCode, 200);
      const countForTwo = prepares;

      // Double the issues and sessions; the query count must not move.
      seedRichIssue();
      seedSimpleIssue();
      prepares = 0;
      const second = await app.inject({ method: "GET", url: `/api/execution-analysis?${WINDOW}` });
      assert.equal(second.statusCode, 200);
      assert.equal(prepares, countForTwo);
      assert.ok(countForTwo <= 20, `expected a constant handful of queries, saw ${countForTwo}`);
    } finally {
      (db as { prepare: unknown }).prepare = original;
    }
  } finally {
    await app.close();
  }
});

test("read-model loaders use indexes (EXPLAIN QUERY PLAN)", async () => {
  await buildApp();
  const db = getDb();
  const statements = [
    "SELECT issue_id FROM workflow_events WHERE issue_id IN ('a','b') ORDER BY ts ASC, rowid ASC",
    "SELECT id FROM worker_sessions WHERE issue_id IN ('a','b') ORDER BY created_at ASC, id ASC",
    "SELECT id FROM usage_events WHERE issue_id IN ('a','b') ORDER BY ts ASC",
    "SELECT id FROM human_actions WHERE issue_id IN ('a','b') ORDER BY requested_at ASC",
    "SELECT id FROM failure_causes WHERE issue_id IN ('a','b')",
    "SELECT id FROM session_activity_events WHERE issue_id IN ('a','b') ORDER BY observed_at ASC",
    "SELECT id FROM queue_entries WHERE issue_id IN ('a','b') ORDER BY enqueued_at ASC",
    "SELECT id FROM workflow_instances WHERE issue_id IN ('a','b') ORDER BY started_at ASC",
  ];
  for (const sql of statements) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>;
    assert.ok(plan.length > 0, sql);
    for (const row of plan) {
      assert.doesNotMatch(row.detail, /\bSCAN\b/, `${sql} → ${row.detail}`);
    }
  }
  // The new analysis indexes exist alongside the old ones.
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>;
  for (const name of ["idx_workflow_events_issue_type", "idx_workflow_events_session", "idx_usage_events_session", "idx_queue_entries_issue"]) {
    assert.ok(indexes.some((i) => i.name === name), `missing index ${name}`);
  }
});

test("cohort aggregates cover the whole cohort, not the page", async () => {
  const app = await buildApp();
  try {
    seedRichIssue();
    seedSimpleIssue();

    const strip = (body: Record<string, unknown>) => {
      const { issueIds: _ids, pagination: _page, ...aggregates } = body;
      return aggregates;
    };
    const get = async (qs: string) => {
      const res = await app.inject({ method: "GET", url: `/api/execution-analysis?${WINDOW}&${qs}` });
      assert.equal(res.statusCode, 200);
      return res.json() as Record<string, unknown>;
    };

    const full = await get("");
    const first = await get("limit=1&offset=0");
    const second = await get("limit=1&offset=1");

    // Pagination windows the issue ids only.
    assert.equal((full.issueIds as string[]).length, 2);
    assert.equal((first.issueIds as string[]).length, 1);
    assert.equal((second.issueIds as string[]).length, 1);
    assert.notDeepEqual(first.issueIds, second.issueIds);
    assert.deepEqual(
      [...(first.issueIds as string[]), ...(second.issueIds as string[])].sort(),
      ((full.issueIds as string[]) ?? []).slice().sort(),
    );
    assert.equal((first.pagination as { totalIssues: number }).totalIssues, 2);

    // Every page reports the aggregates for the whole filtered cohort.
    assert.deepEqual(strip(first), strip(second));
    assert.deepEqual(strip(first), strip(full));
  } finally {
    await app.close();
  }
});

test("cohort waste and retry counts follow the runtime filter", async () => {
  const app = await buildApp();
  try {
    seedMixedRuntimeIssue();

    const get = async (qs: string) => {
      const url = qs ? `/api/execution-analysis?${WINDOW}&${qs}` : `/api/execution-analysis?${WINDOW}`;
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 200);
      const parsed = CohortExecutionReport.safeParse(res.json());
      assert.ok(parsed.success, `schema mismatch: ${JSON.stringify(parsed.error?.issues.slice(0, 3))}`);
      return parsed.data;
    };

    const full = await get("");
    assert.equal(full.waste.failedAttempts, 2);
    assert.equal(full.waste.tokensIn.value, 400);
    assert.equal(full.waste.costUsd.value, 4);
    assert.deepEqual([full.retryReuse.numerator, full.retryReuse.denominator, full.retryReuse.rate], [2, 2, 1]);
    assert.deepEqual(full.primaryFailures, [{ code: "unknown", count: 1, rate: 1 }]);

    // The cursor_local failed attempt alone contributes waste, retries, and
    // the primary failure — the claude_code failure must not leak in.
    const cursor = await get("runtime=cursor_local");
    assert.equal(cursor.waste.failedAttempts, 1);
    assert.equal(cursor.waste.tokensIn.value, 300);
    assert.equal(cursor.waste.tokensOut.value, 150);
    assert.equal(cursor.waste.costUsd.value, 3);
    assert.deepEqual([cursor.retryReuse.numerator, cursor.retryReuse.denominator, cursor.retryReuse.rate], [1, 1, 1]);
    assert.deepEqual(cursor.primaryFailures, [{ code: "agent_cli_crash", count: 1, rate: 1 }]);
    assert.equal(cursor.reviewer.rounds, 0);

    const claude = await get("runtime=claude_code");
    assert.equal(claude.waste.failedAttempts, 1);
    assert.equal(claude.waste.tokensIn.value, 100);
    assert.equal(claude.waste.costUsd.value, 1);
    assert.deepEqual([claude.retryReuse.numerator, claude.retryReuse.denominator, claude.retryReuse.rate], [0, 0, null]);
    assert.deepEqual(claude.primaryFailures, [{ code: "unknown", count: 1, rate: 1 }]);
  } finally {
    await app.close();
  }
});

/** A second, simple issue for cohort filters/pagination/rates. */
function seedSimpleIssue(): { id: string; repo: string } {
  const issue = createIssue({
    title: "Simple analysis issue",
    repo: "acme/other",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
  });
  const issueId = issue.id;
  const instanceId = makeInstance(issueId, iso(T0 + 2 * MIN), iso(T0 + 30 * MIN), "done");
  const s = makeSession(issueId, { status: "done" });
  insertEvent({ issueId, instanceId, sessionId: s, type: "worker.started", ts: iso(T0 + 2 * MIN) });
  insertEvent({ issueId, instanceId, sessionId: s, type: "agent.started", ts: iso(T0 + 3 * MIN) });
  insertEvent({ issueId, instanceId, sessionId: s, type: "agent.completed", ts: iso(T0 + 28 * MIN) });
  insertEvent({ issueId, instanceId, sessionId: s, type: "worker.completed", ts: iso(T0 + 30 * MIN) });
  recordUsageEvent({
    issueId, workerSessionId: s, role: "developer", runtime: "claude_code",
    tokensIn: 10, tokensOut: 5, costUsd: 2.0, durationMs: 25 * MIN, model: "model-a",
  });
  return { id: issueId, repo: issue.repo };
}

/** One issue with failed developer attempts on two runtimes and a later
 * successful cursor_local retry — proves runtime filters scope waste, retry
 * reuse, and primary failures instead of mixing both runtimes. */
function seedMixedRuntimeIssue(): string {
  const issue = createIssue({
    title: "Mixed runtime issue",
    repo: "acme/app",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
  });
  const issueId = issue.id;
  const instanceId = makeInstance(issueId, iso(T0), iso(T0 + 60 * MIN), "done");

  // A: failed on claude_code with exact agent bounds and provider metadata.
  const a = makeSession(issueId, { runtime: "claude_code", status: "failed" });
  insertEvent({ issueId, instanceId, sessionId: a, type: "worker.started", ts: iso(T0) });
  insertEvent({ issueId, instanceId, sessionId: a, type: "agent.started", ts: iso(T0 + MIN) });
  insertEvent({ issueId, instanceId, sessionId: a, type: "agent.completed", ts: iso(T0 + 11 * MIN) });
  const aFailed = insertEvent({ issueId, instanceId, sessionId: a, type: "worker.failed", ts: iso(T0 + 12 * MIN) });
  recordUsageEvent({
    issueId, workerSessionId: a, role: "developer", runtime: "claude_code",
    tokensIn: 100, tokensOut: 50, costUsd: 1.0, durationMs: 10 * MIN, model: "model-a",
  });
  recordFailureCauses([{
    issueId,
    workflowInstanceId: instanceId,
    cause: makeCause({ sessionId: a, occurredAt: iso(T0 + 12 * MIN), eventCursor: aFailed }) as never,
  }]);

  // B: failed on cursor_local, reusing the prior commit.
  const b = makeSession(issueId, { runtime: "cursor_local", status: "failed" });
  insertEvent({ issueId, instanceId, sessionId: b, type: "worker.started", ts: iso(T0 + 15 * MIN) });
  insertEvent({ issueId, instanceId, sessionId: b, type: "agent.started", ts: iso(T0 + 16 * MIN) });
  insertEvent({ issueId, instanceId, sessionId: b, type: "agent.completed", ts: iso(T0 + 26 * MIN) });
  const bFailed = insertEvent({ issueId, instanceId, sessionId: b, type: "worker.failed", ts: iso(T0 + 27 * MIN) });
  insertEvent({
    issueId, instanceId, sessionId: b, type: "retry.reused", ts: iso(T0 + 16 * MIN),
    payload: { kinds: ["commit"], retryReason: "infra retry" },
  });
  recordUsageEvent({
    issueId, workerSessionId: b, role: "developer", runtime: "cursor_local",
    tokensIn: 300, tokensOut: 150, costUsd: 3.0, durationMs: 10 * MIN, model: "model-a",
  });
  recordFailureCauses([{
    issueId,
    workflowInstanceId: instanceId,
    cause: makeCause({
      code: "agent_cli_crash", domain: "infrastructure", sessionId: b,
      occurredAt: iso(T0 + 27 * MIN), eventCursor: bFailed,
    }) as never,
  }]);

  // C: successful cursor_local retry, also reusing the commit.
  const c = makeSession(issueId, { runtime: "cursor_local", status: "done" });
  insertEvent({ issueId, instanceId, sessionId: c, type: "worker.started", ts: iso(T0 + 30 * MIN) });
  insertEvent({ issueId, instanceId, sessionId: c, type: "agent.started", ts: iso(T0 + 31 * MIN) });
  insertEvent({ issueId, instanceId, sessionId: c, type: "agent.completed", ts: iso(T0 + 41 * MIN) });
  insertEvent({ issueId, instanceId, sessionId: c, type: "worker.completed", ts: iso(T0 + 42 * MIN) });
  insertEvent({
    issueId, instanceId, sessionId: c, type: "retry.reused", ts: iso(T0 + 31 * MIN),
    payload: { kinds: ["commit"], retryReason: "infra retry" },
  });
  recordUsageEvent({
    issueId, workerSessionId: c, role: "developer", runtime: "cursor_local",
    tokensIn: 400, tokensOut: 200, costUsd: 4.0, durationMs: 10 * MIN, model: "model-a",
  });
  // Stagger creation times: retry order follows (created_at, id), and ties
  // would break on random uuids.
  getDb().prepare("UPDATE worker_sessions SET created_at = ? WHERE id = ?").run(iso(T0), a);
  getDb().prepare("UPDATE worker_sessions SET created_at = ? WHERE id = ?").run(iso(T0 + 15 * MIN), b);
  getDb().prepare("UPDATE worker_sessions SET created_at = ? WHERE id = ?").run(iso(T0 + 30 * MIN), c);
  return issueId;
}
