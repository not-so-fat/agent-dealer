// packages/server/src/coordinator/abort.integration.test.ts
//
// NOT-83 acceptance scenario that needs the real worker loop wired up: abort while a
// developer effect handler is actually in flight (leased, session running), then let that
// zombie attempt's late completion arrive — it must be fenced (a no-op) and must never
// reopen or mutate the now-closed issue. Mirrors execution-env.integration.test.ts's
// fake-effect-handler + runCoordinatorTick/drainCoordinator pump pattern.
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-abort-"));

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, getIssue } = await import("../repository/issues.js");
const { getWorkItem, listWorkItemsForIssue } = await import("../repository/work-items.js");
const { getWorkerSession } = await import("../repository/worker-sessions.js");
const { startWorkflow, abortIssue } = await import("./commands.js");
const { registerEffectHandler, resetEffectHandlers } = await import("./effect-registry.js");
const { runCoordinatorTick, drainCoordinator } = await import("./worker-loop.js");

before(() => migrate());
beforeEach(() => getDb().exec("DELETE FROM work_items"));
afterEach(() => resetEffectHandlers());

function newIssue(): string {
  return createIssue({
    title: "Abort mid-flight",
    description: "d",
    acceptanceCriteria: "It works",
    repo: "/repo",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
  }).id;
}

test("abortIssue fences a developer effect that completes after the abort already committed", async () => {
  const issueId = newIssue();
  startWorkflow(issueId);

  // A deferred the test controls: the fake developer effect blocks here until the test
  // lets it resolve, simulating a session still genuinely running when the abort lands.
  let releaseEffect!: () => void;
  const blocked = new Promise<void>((resolve) => {
    releaseEffect = resolve;
  });
  registerEffectHandler("developer", async () => {
    await blocked;
    return { kind: "clean_handoff", branch: "issue-x", headSha: "deadbeef", baseSha: "base1", prNumber: 1, prUrl: "https://gh/pr/1" };
  });

  // Synchronous up to the handler's own first await (session create/bind/start all run
  // inside one non-async transaction before the handler is ever invoked) — by the time
  // this resolves, the work item is already `leased` and its session `running`.
  const started = await runCoordinatorTick({ leaseOwner: "test" });
  assert.equal(started, 1);

  const item = listWorkItemsForIssue(issueId)[0];
  assert.equal(item.status, "leased");
  const sessionId = item.workerSessionId!;
  assert.ok(sessionId, "expected the session to already be bound before the handler blocks");
  assert.equal(getWorkerSession(sessionId)!.status, "running");

  const killed: string[] = [];
  const result = abortIssue(issueId, "tester", { killProcess: (id) => (killed.push(id), true) });
  assert.deepEqual(result, { ok: true, issueStatus: "closed", alreadyClosed: false });
  assert.deepEqual(killed, [sessionId], "the running session's registered child process must be terminated");
  assert.equal(getWorkItem(item.id)!.status, "cancelled");
  assert.equal(getWorkerSession(sessionId)!.status, "cancelled");

  // The zombie attempt now finishes and tries to hand off its (otherwise valid) outcome.
  releaseEffect();
  await drainCoordinator();

  assert.equal(getWorkItem(item.id)!.status, "cancelled", "a late completion must never re-advance a cancelled work item");
  assert.equal(getIssue(issueId)!.status, "closed", "a late completion must never reopen or mutate a closed issue");
  assert.equal(getIssue(issueId)!.prNumber, null, "the late clean_handoff must never be projected onto the issue");
});
