// packages/server/src/coordinator/usage-cap.integration.test.ts
//
// NOT-111 acceptance: cap detection → deferral without spending attempt/infra budgets.

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DeveloperOutcome } from "./routing.js";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-cap-int-"));
process.env.MAX_COORDINATOR_CONCURRENCY = "1";
process.env.COORDINATOR_HEARTBEAT_MS = "20";
process.env.COORDINATOR_FAIL_BACKOFF_MS = "0";
process.env.COORDINATOR_POLL_INTERVAL_MS = "50";
process.env.USAGE_CAP_FALLBACK_COOLDOWN_MS = "60000";

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../runners/fixtures/claude-rate-limit-rejected.ndjson"
);

const { migrate, getDb } = await import("../db/index.js");
const { createAgent } = await import("../repository/agents.js");
const { createIssue, getIssue } = await import("../repository/issues.js");
const { listWorkItemsForIssue } = await import("../repository/work-items.js");
const { listWorkflowEventsForIssue } = await import("../repository/workflow-events.js");
const { recordRuntimeAvailability } = await import("../repository/runtime-availability.js");
const { startWorkflow } = await import("./commands.js");
const { registerEffectHandler, resetEffectHandlers } = await import("./effect-registry.js");
const { runCoordinatorTick, drainCoordinator } = await import("./worker-loop.js");
const { recordUsageCapFromLog } = await import("../runners/usage-cap.js");

before(() => migrate());
beforeEach(() => {
  getDb().exec(`
    DELETE FROM review_publications;
    DELETE FROM work_items;
    DELETE FROM human_actions;
    DELETE FROM workflow_events;
    DELETE FROM findings;
    DELETE FROM worker_sessions;
    DELETE FROM artifacts;
    DELETE FROM usage_events;
    DELETE FROM workflow_instances;
    DELETE FROM issues;
    DELETE FROM runtime_availability;
  `);
});
after(() => resetEffectHandlers());

async function pump(max = 10): Promise<void> {
  for (let i = 0; i < max; i++) {
    await runCoordinatorTick();
    await drainCoordinator();
    await new Promise((r) => setTimeout(r, 30));
  }
}

test("in-flight cap defers work item without incrementing attempt_count or infra_attempts", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-cap-repo-"));
  const dev = createAgent({ name: "dev-cap", runtime: "claude_code", workspaceRoot: repo });
  const rev = createAgent({ name: "rev-cap", runtime: "claude_code", workspaceRoot: repo });
  const issueId = createIssue({
    title: "Cap test",
    description: "d",
    acceptanceCriteria: "ac",
    repo,
    baseBranch: "main",
    developerAgentId: dev.id,
    reviewerAgentId: rev.id,
    maxReviewRounds: 2,
    maxInfraAttempts: 1,
    source: "manual",
  }).id;

  registerEffectHandler("developer", async () => {
    const until = new Date(Date.now() + 120_000).toISOString();
    recordRuntimeAvailability({
      runtime: "claude_code",
      unavailableUntil: until,
      reason: "claude_code usage capped — five_hour limit rejected",
      evidence: { test: true },
    });
    return {
      kind: "usage_capped",
      until,
      reason: "claude_code usage capped — five_hour limit rejected",
    } satisfies DeveloperOutcome;
  });

  const started = startWorkflow(issueId);
  assert.equal(started.ok, true);
  if (started.ok !== true) return;

  const before = listWorkItemsForIssue(issueId)[0]!;
  assert.equal(before.attemptCount, 0);

  await pump();

  const issue = getIssue(issueId)!;
  assert.equal(issue.infraAttempts, 0);

  const items = listWorkItemsForIssue(issueId);
  assert.equal(items.length, 1);
  const item = items[0]!;
  assert.equal(item.status, "pending");
  assert.equal(item.attemptCount, 0);
  assert.ok(Date.parse(item.availableAt) > Date.now());

  const events = listWorkflowEventsForIssue(issueId);
  assert.ok(events.some((e) => e.type === "worker.deferred"));
});

test("pending item on capped runtime is not spawned before until (pre-spawn deferral)", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-cap-repo2-"));
  const dev = createAgent({ name: "dev-cap2", runtime: "claude_code", workspaceRoot: repo });
  const rev = createAgent({ name: "rev-cap2", runtime: "claude_code", workspaceRoot: repo });
  const until = new Date(Date.now() + 300_000).toISOString();
  recordRuntimeAvailability({
    runtime: "claude_code",
    unavailableUntil: until,
    reason: "claude_code usage capped — test",
  });

  let spawnCalls = 0;
  registerEffectHandler("developer", async () => {
    spawnCalls++;
    return { kind: "no_pr" };
  });

  const issueId = createIssue({
    title: "Pre-spawn cap",
    description: "d",
    acceptanceCriteria: "ac",
    repo,
    baseBranch: "main",
    developerAgentId: dev.id,
    reviewerAgentId: rev.id,
    maxReviewRounds: 2,
    maxInfraAttempts: 3,
    source: "manual",
  }).id;

  startWorkflow(issueId);
  await pump(3);

  assert.equal(spawnCalls, 0);
  const item = listWorkItemsForIssue(issueId)[0]!;
  assert.equal(item.status, "pending");
  assert.equal(item.attemptCount, 0);
  assert.ok(Date.parse(item.availableAt) > Date.now());
  assert.ok(listWorkflowEventsForIssue(issueId).some((e) => e.type === "worker.deferred"));
});

test("fixture log records runtime_availability with resetsAt", () => {
  const cap = recordUsageCapFromLog(fixturePath, "claude_code", Date.parse("2026-01-01T00:00:00.000Z"));
  assert.ok(cap);
  assert.equal(cap!.unavailableUntil, new Date(1784283600 * 1000).toISOString());
});
