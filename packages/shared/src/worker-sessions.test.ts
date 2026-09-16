import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkerSession, WorkerSessionRole, WorkerSessionStatus } from "./worker-sessions.js";

test("WorkerSession schema parses a queued developer session", () => {
  const session: WorkerSession = {
    id: "44444444-4444-4444-4444-444444444444",
    issueId: "11111111-1111-1111-1111-111111111111",
    role: "developer",
    round: 1,
    agentId: "22222222-2222-2222-2222-222222222222",
    runtime: "claude_code",
    model: null,
    budgetJson: null,
    worktreePath: null,
    inputSha: null,
    status: "queued",
    sessionRef: null,
    logPath: null,
    exitCode: null,
    errorJson: null,
    metadataJson: null,
    profileSnapshotJson: null,
    processPid: null,
    processOwner: null,
    processStartedAt: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    heartbeatAt: null,
    completedAt: null,
    updatedAt: new Date().toISOString(),
  };
  assert.deepStrictEqual(WorkerSession.parse(session), session);
});

test("WorkerSessionRole accepts the legacy migration-only role", () => {
  assert.equal(WorkerSessionRole.parse("legacy"), "legacy");
});

test("WorkerSessionStatus rejects an invalid status", () => {
  assert.throws(() => WorkerSessionStatus.parse("bogus"));
});
