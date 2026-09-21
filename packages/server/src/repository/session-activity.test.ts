// packages/server/src/repository/session-activity.test.ts
//
// NOT-170: repository tests — append-only inserts, idempotent re-insert on
// (session, source_offset), durable resume cursors, and the silence read model
// assembled from rows + agent_process bounds + host-sleep evidence.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-activity-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("./issues.js");
const { createWorkerSession } = await import("./worker-sessions.js");
const { appendWorkflowEvent } = await import("./workflow-events.js");
const {
  getSessionActivityMaxCursor,
  getSessionActivityMaxOffset,
  getSessionSilenceIntervals,
  insertSessionActivityEvent,
  listSessionActivityEvents,
} = await import("./session-activity.js");

let issueId: string;

before(() => {
  migrate();
  issueId = createIssue({
    title: "Activity host issue",
    repo: "acme/app",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
  }).id;
});

function makeSession(): string {
  return createWorkerSession({
    issueId,
    role: "developer",
    round: 1,
    agentId: BUILTIN_AGENT_CLAUDE_ID,
    runtime: "claude_code",
  }).id;
}

test("inserts list in observation order with short summaries and pointers only", () => {
  const sessionId = makeSession();
  insertSessionActivityEvent({
    issueId,
    workerSessionId: sessionId,
    observedAt: "2026-09-01T10:00:01.000Z",
    sourceCursor: 0,
    sourceOffset: 100,
    activityKind: "tool_started",
    state: "started",
    callId: "tu_1",
    summary: "Running: npm test",
    rawEvidence: "/tmp/session.ndjson#offset=0",
  });
  const rows = listSessionActivityEvents(sessionId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.activityKind, "tool_started");
  assert.equal(rows[0]!.callId, "tu_1");
  assert.equal(rows[0]!.summary, "Running: npm test");
  assert.match(rows[0]!.rawEvidence!, /#offset=/);
});

test("re-inserting the same source offset is a no-op (sampler idempotency)", () => {
  const sessionId = makeSession();
  const first = insertSessionActivityEvent({
    issueId,
    workerSessionId: sessionId,
    sourceCursor: 3,
    sourceOffset: 400,
    activityKind: "assistant_output",
    state: "observed",
    summary: "Working on it",
  });
  const second = insertSessionActivityEvent({
    issueId,
    workerSessionId: sessionId,
    sourceCursor: 3,
    sourceOffset: 400,
    activityKind: "assistant_output",
    state: "observed",
    summary: "Working on it",
  });
  assert.equal(first.id, second.id);
  assert.equal(listSessionActivityEvents(sessionId).length, 1);
});

test("durable resume cursors track the farthest persisted offset", () => {
  const sessionId = makeSession();
  assert.equal(getSessionActivityMaxOffset(sessionId), null);
  insertSessionActivityEvent({
    issueId, workerSessionId: sessionId, sourceCursor: 0, sourceOffset: 50,
    activityKind: "tool_started", state: "started",
  });
  insertSessionActivityEvent({
    issueId, workerSessionId: sessionId, sourceCursor: 2, sourceOffset: 180,
    activityKind: "tool_completed", state: "completed",
  });
  assert.equal(getSessionActivityMaxOffset(sessionId), 180);
  assert.equal(getSessionActivityMaxCursor(sessionId), 2);
});

test("read model is unavailable without agent_process bounds (never fabricated)", () => {
  const sessionId = makeSession();
  insertSessionActivityEvent({
    issueId,
    workerSessionId: sessionId,
    observedAt: new Date().toISOString(),
    sourceCursor: 0,
    sourceOffset: 10,
    activityKind: "assistant_output",
    state: "observed",
  });
  const model = getSessionSilenceIntervals(sessionId, { thresholdMs: 1 });
  assert.equal(model.processStartMs, null);
  assert.equal(model.processEndMs, null);
  assert.deepEqual(model.intervals, []);
  assert.equal(model.quality, "unavailable");
  assert.ok(model.reasons.includes("no_defensible_boundary"));
});

test("read model nests a tool flight inside agent bounds with inferred quality", async () => {
  const sessionId = makeSession();
  const started = appendWorkflowEvent({
    issueId, workerSessionId: sessionId, type: "agent.started",
    actorType: "developer", stage: "develop", round: 1,
  });
  const t0 = Date.parse(started.ts);
  insertSessionActivityEvent({
    issueId, workerSessionId: sessionId,
    observedAt: new Date(t0 + 5).toISOString(), sourceCursor: 0, sourceOffset: 60,
    activityKind: "tool_started", state: "started", callId: "tu_9", summary: "Running tests",
  });
  insertSessionActivityEvent({
    issueId, workerSessionId: sessionId,
    observedAt: new Date(t0 + 50).toISOString(), sourceCursor: 1, sourceOffset: 160,
    activityKind: "tool_completed", state: "completed", callId: "tu_9", summary: "Running tests",
  });
  // Close the bounds after the last activity so the flight sits inside them.
  await new Promise((r) => setTimeout(r, 80));
  appendWorkflowEvent({
    issueId, workerSessionId: sessionId, type: "agent.completed",
    actorType: "developer", stage: "develop", round: 1,
  });
  const model = getSessionSilenceIntervals(sessionId, { thresholdMs: 1 });
  assert.ok(model.processStartMs !== null && model.processEndMs !== null);
  const flight = model.intervals.filter((iv) => iv.category === "tool_or_subprocess_in_flight");
  assert.equal(flight.length, 1);
  assert.ok(flight[0]!.startMs >= model.processStartMs! && flight[0]!.endMs <= model.processEndMs!);
  for (const iv of model.intervals) {
    assert.equal(iv.quality, "inferred");
    assert.ok(iv.reasons.includes("sampler_observed_time"));
  }
});

test("read model applies host.suspended as an override without double-counting", async () => {
  const sessionId = makeSession();
  const started = appendWorkflowEvent({
    issueId, workerSessionId: sessionId, type: "agent.started",
    actorType: "developer", stage: "develop", round: 1,
  });
  const t0 = Date.parse(started.ts);
  insertSessionActivityEvent({
    issueId, workerSessionId: sessionId,
    observedAt: new Date(t0 + 5).toISOString(), sourceCursor: 0, sourceOffset: 60,
    activityKind: "assistant_output", state: "observed",
  });
  // Sleep covers [t0+10, t0+90); the silence gap after the activity overlaps it.
  appendWorkflowEvent({
    issueId, workerSessionId: sessionId, type: "host.suspended",
    actorType: "developer", stage: "develop", round: 1,
    payload: {
      sessionId,
      detectedAt: new Date(t0 + 90).toISOString(),
      wallGapMs: 80,
      unelapsedMs: 80,
      unobservedMs: 80,
    },
  });
  // Close the bounds after the sleep window so the override sits inside them.
  await new Promise((r) => setTimeout(r, 120));
  appendWorkflowEvent({
    issueId, workerSessionId: sessionId, type: "agent.completed",
    actorType: "developer", stage: "develop", round: 1,
  });
  const model = getSessionSilenceIntervals(sessionId, { thresholdMs: 1 });
  assert.ok(model.intervals.length > 0);
  assert.ok(model.intervals.some((iv) => iv.category === "host_suspended"));
  const total = model.intervals.reduce((a, iv) => a + iv.durationMs, 0);
  assert.ok(total <= model.processEndMs! - model.processStartMs!);
});
