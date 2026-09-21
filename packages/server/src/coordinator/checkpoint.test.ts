// packages/server/src/coordinator/checkpoint.test.ts
//
// NOT-172: checkpoint/reuse evidence is append-only and idempotent — duplicate
// sampler/recovery ticks and coordinator restarts never duplicate rows, and a
// cold retry is recorded (empty kinds) rather than omitted.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-checkpoint-"));

const { migrate } = await import("../db/index.js");
const { createAgent } = await import("../repository/agents.js");
const { createIssue } = await import("../repository/issues.js");
const { createWorkerSession, startSession } = await import("../repository/worker-sessions.js");
const { startWorkflowInstance, listWorkflowEventsForIssue } = await import("../repository/workflow-events.js");
const { emitCheckpointObserved, emitRetryReuse } = await import("./checkpoint.js");
const { listCheckpointsForIssue, getRetryReuseForSession } = await import("./attempt-waste.js");

before(() => migrate());

const COMMIT_SHA = "a".repeat(40);
const INPUT_SHA = "b".repeat(40);

async function setup() {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", deckId: "00000000-0000-4000-a000-000000000099" });
  const rev = createAgent({ name: `rev-${Math.random()}`, runtime: "claude_code", deckId: "00000000-0000-4000-a000-000000000099" });
  const issueId = createIssue({
    title: "t",
    description: "d",
    acceptanceCriteria: "a",
    repo: "/tmp/dealer-checkpoint-repo",
    baseBranch: "main",
    developerAgentId: dev.id,
    reviewerAgentId: rev.id,
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
  }).id;
  const instance = startWorkflowInstance(issueId, "dev_reviewer_v1");
  const session = createWorkerSession({ issueId, role: "developer", round: 1, agentId: dev.id, runtime: "claude_code" });
  startSession(session.id);
  return { issueId, instanceId: instance.id, sessionId: session.id };
}

function checkpointsOf(issueId: string, kind: string): Array<{ payload: Record<string, unknown>; ts: string }> {
  return listWorkflowEventsForIssue(issueId)
    .filter((e) => e.type === "checkpoint.observed")
    .map((e) => ({ payload: JSON.parse(e.payloadJson!) as Record<string, unknown>, ts: e.ts }))
    .filter((e) => e.payload.kind === kind);
}

test("commit checkpoint carries observed SHA, observation time, and sampling precision", async () => {
  const { issueId, instanceId, sessionId } = await setup();
  emitCheckpointObserved({
    issueId,
    workflowInstanceId: instanceId,
    workerSessionId: sessionId,
    role: "developer",
    stage: "developing",
    round: 1,
    kind: "commit",
    observedSha: COMMIT_SHA,
    origin: "sampler",
    inputSha: INPUT_SHA,
    samplingPrecisionMs: 10_000,
  });
  const rows = checkpointsOf(issueId, "commit");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.payload.observedSha, COMMIT_SHA);
  assert.equal(rows[0]!.payload.origin, "sampler");
  assert.equal(rows[0]!.payload.inputSha, INPUT_SHA);
  assert.equal(rows[0]!.payload.samplingPrecisionMs, 10_000);
  assert.ok(Date.parse(String(rows[0]!.payload.observedAt)) > 0, "observation timestamp is a real time");
});

test("duplicate ticks and restarts do not duplicate checkpoint evidence; the first observation wins", async () => {
  const { issueId, instanceId, sessionId } = await setup();
  const base = {
    issueId,
    workflowInstanceId: instanceId,
    workerSessionId: sessionId,
    role: "developer" as const,
    stage: "developing",
    round: 1,
  };
  emitCheckpointObserved({ ...base, kind: "commit", observedSha: COMMIT_SHA, origin: "sampler", inputSha: INPUT_SHA, samplingPrecisionMs: 10_000 });
  const firstTs = checkpointsOf(issueId, "commit")[0]!.ts;
  // A duplicate sampler tick, a salvage emit, and a post-restart re-emit all no-op.
  emitCheckpointObserved({ ...base, kind: "commit", observedSha: COMMIT_SHA, origin: "sampler", inputSha: INPUT_SHA, samplingPrecisionMs: 10_000 });
  emitCheckpointObserved({ ...base, kind: "commit", observedSha: "c".repeat(40), origin: "salvage", branch: `issue-${issueId}` });
  emitCheckpointObserved({ ...base, kind: "commit", observedSha: COMMIT_SHA, origin: "session_end", inputSha: INPUT_SHA });
  const rows = checkpointsOf(issueId, "commit");
  assert.equal(rows.length, 1, "one commit checkpoint per session across origins and restarts");
  assert.equal(rows[0]!.ts, firstTs, "the first coordinator observation is preserved");

  // Other kinds are independent evidence, not duplicates.
  emitCheckpointObserved({ ...base, kind: "verification_receipt", observedSha: COMMIT_SHA });
  emitCheckpointObserved({ ...base, kind: "branch_pushed", observedSha: COMMIT_SHA, branch: `issue-${issueId}` });
  assert.equal(checkpointsOf(issueId, "verification_receipt").length, 1);
  assert.equal(checkpointsOf(issueId, "branch_pushed").length, 1);
  assert.equal(listCheckpointsForIssue(issueId).length, 3);
});

test("retry reuse records reused kinds, and a cold retry as empty kinds", async () => {
  const { issueId, instanceId, sessionId } = await setup();
  emitRetryReuse({
    issueId,
    workflowInstanceId: instanceId,
    workerSessionId: sessionId,
    role: "developer",
    stage: "developing",
    round: 1,
    kinds: ["worktree", "commit"],
    retryReason: "presumed dead; republishing",
  });
  const reused = getRetryReuseForSession(sessionId)!;
  assert.deepEqual(reused.kinds, ["worktree", "commit"]);
  assert.equal(reused.retryReason, "presumed dead; republishing");

  // A duplicate recovery tick is a no-op.
  emitRetryReuse({
    issueId,
    workflowInstanceId: instanceId,
    workerSessionId: sessionId,
    role: "developer",
    stage: "developing",
    round: 1,
    kinds: ["worktree", "commit"],
    retryReason: "presumed dead; republishing",
  });
  assert.equal(
    listWorkflowEventsForIssue(issueId).filter((e) => e.type === "retry.reused").length,
    1
  );

  // A cold retry is explicit evidence — distinguishable from "no record".
  const cold = createWorkerSession({ issueId, role: "developer", round: 1, agentId: null, runtime: "claude_code" });
  startSession(cold.id);
  emitRetryReuse({
    issueId,
    workflowInstanceId: instanceId,
    workerSessionId: cold.id,
    role: "developer",
    stage: "developing",
    round: 1,
    kinds: [],
    retryReason: "Developer session produced no PR.",
  });
  assert.deepEqual(getRetryReuseForSession(cold.id)!.kinds, []);
});

test("checkpoints attribute per session across attempts of one issue", async () => {
  const { createWorkerSession: createSession } = await import("../repository/worker-sessions.js");
  const { issueId, instanceId, sessionId } = await setup();
  const second = createSession({ issueId, role: "developer", round: 1, agentId: null, runtime: "claude_code" });
  const base = {
    issueId,
    workflowInstanceId: instanceId,
    role: "developer" as const,
    stage: "developing",
    round: 1,
  };
  emitCheckpointObserved({ ...base, workerSessionId: sessionId, kind: "commit", observedSha: COMMIT_SHA, origin: "session_end" });
  emitCheckpointObserved({ ...base, workerSessionId: second.id, kind: "commit", observedSha: "c".repeat(40), origin: "sampler" });
  const records = listCheckpointsForIssue(issueId);
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((r) => r.sessionId).sort(),
    [sessionId, second.id].sort()
  );
  assert.deepEqual(
    records.map((r) => r.observedSha).sort(),
    [COMMIT_SHA, "c".repeat(40)].sort()
  );
});
