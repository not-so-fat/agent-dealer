// packages/server/src/coordinator/execution-env.integration.test.ts
//
// NOT-60 acceptance scenarios that need more than one module wired together:
// the immutable profile snapshot flowing through the real work loop, and the
// reviewer's read-only contract from snapshot → permission policy → generated args.
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-execenv-"));
process.env.MAX_COORDINATOR_CONCURRENCY = "4";
process.env.COORDINATOR_HEARTBEAT_MS = "20";
process.env.COORDINATOR_FAIL_BACKOFF_MS = "0";

const { migrate, getDb } = await import("../db/index.js");
const { parseProfileSnapshot } = await import("@agent-dealer/shared");
const { createAgent, updateAgent } = await import("../repository/agents.js");
const { createIssue } = await import("../repository/issues.js");
const { listWorkerSessionsForIssue } = await import("../repository/worker-sessions.js");
const { startWorkflow } = await import("./commands.js");
const { registerEffectHandler, resetEffectHandlers } = await import("./effect-registry.js");
const { runCoordinatorTick, drainCoordinator } = await import("./worker-loop.js");
const { ReviewerResult } = await import("./reviewer-result.js");
const { buildWorkerArgs } = await import("./args.js");
const { assertReviewerReadOnly } = await import("./permissions.js");

before(() => migrate());
beforeEach(() => getDb().exec("DELETE FROM work_items"));
afterEach(() => resetEffectHandlers());

async function pump(max = 20): Promise<void> {
  for (let i = 0; i < max; i++) {
    const started = await runCoordinatorTick({ leaseOwner: "pump" });
    await drainCoordinator();
    if (started === 0) return;
  }
}

const approvedVerdict = {
  kind: "verdict" as const,
  result: ReviewerResult.parse({
    verdict: "approved",
    baseSha: "base1",
    headSha: "head1",
    acceptanceCriteriaAssessment: "ok",
    evidenceAssessment: "ok",
    findings: [],
    risks: [],
  }),
};

function issueWith(developerAgentId: string, reviewerAgentId: string): string {
  return createIssue({
    title: "Exec env",
    acceptanceCriteria: "works",
    repo: "/repo",
    developerAgentId,
    reviewerAgentId,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
  }).id;
}

test("editing the profile after the work is queued does not change the eventual session", async () => {
  const dev = createAgent({
    name: "dev-freeze",
    runtime: "claude_code",
    workspaceRoot: "/repo",
    defaultModel: "model-when-queued",
  });
  const rev = createAgent({ name: "rev-freeze", runtime: "claude_code", workspaceRoot: "/repo" });
  const issueId = issueWith(dev.id, rev.id);

  registerEffectHandler("developer", async () => ({
    kind: "clean_handoff" as const,
    branch: "issue-1",
    headSha: "head1",
    baseSha: "base1",
    prNumber: 7,
    prUrl: "u",
  }));
  registerEffectHandler("reviewer", async () => approvedVerdict);

  // Queue the work, THEN edit the profile before any dispatcher tick runs — the
  // reviewer's boundary repro for NOT-60's "later profile edits do not change a
  // queued/running session" criterion.
  startWorkflow(issueId);
  updateAgent(dev.id, { defaultModel: "model-after-queue" });
  await pump();

  const devSession = listWorkerSessionsForIssue(issueId).find((s) => s.role === "developer")!;
  const snap = parseProfileSnapshot(devSession.profileSnapshotJson);
  assert.ok(snap, "developer session carries a profile snapshot");
  assert.equal(snap!.model, "model-when-queued", "snapshot frozen when the item was queued");
  assert.equal(devSession.model, "model-when-queued", "denormalized session model also frozen");
  assert.equal(updateAgent(dev.id, {})!.defaultModel, "model-after-queue", "the live profile moved on");
});

test("the reviewer session snapshot yields a read-only permission policy and read-only args", async () => {
  const dev = createAgent({ name: "dev-ro", runtime: "claude_code", workspaceRoot: "/repo" });
  const rev = createAgent({ name: "rev-ro", runtime: "codex_local", workspaceRoot: "/repo" });
  const issueId = issueWith(dev.id, rev.id);

  registerEffectHandler("developer", async () => ({
    kind: "clean_handoff" as const,
    branch: "issue-1",
    headSha: "head1",
    baseSha: "base1",
    prNumber: 7,
    prUrl: "u",
  }));
  registerEffectHandler("reviewer", async () => approvedVerdict);

  startWorkflow(issueId);
  await pump();

  const revSession = listWorkerSessionsForIssue(issueId).find((s) => s.role === "reviewer")!;
  const snap = parseProfileSnapshot(revSession.profileSnapshotJson)!;
  assert.equal(snap.permissionPolicy.worktreeWrite, false);
  assert.equal(snap.permissionPolicy.publishReview, false);

  const args = buildWorkerArgs({
    runtime: snap.runtime ?? "claude_code",
    role: "reviewer",
    prompt: "review the diff",
    model: snap.model ?? undefined,
    policy: snap.permissionPolicy,
  });
  assert.doesNotThrow(() => assertReviewerReadOnly(args));
});
