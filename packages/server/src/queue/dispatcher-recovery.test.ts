import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-recovery-"));
process.env.MAX_CONCURRENT_RUNS = "2";
process.env.MAX_PLAN_ATTEMPTS = "3";

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID } = await import("@agent-dealer/shared");
const { updateAgent } = await import("../repository/agents.js");
const {
  addArtifact,
  createRun,
  getRun,
  transitionRun,
} = await import("../repository/runs.js");
const {
  recoverOrphanedRuns,
  cancelActiveRun,
} = await import("./dispatcher.js");

before(() => {
  migrate();
  updateAgent(BUILTIN_AGENT_CLAUDE_ID, { workspaceRoot: process.env.AGENT_DEALER_HOME! });
});

test("recoverOrphanedRuns fails stuck running rows", () => {
  const run = createRun({
    title: "Orphan",
    taskCategory: "other",
    status: "plan_pending",
    agentId: BUILTIN_AGENT_CLAUDE_ID,
  });
  transitionRun(run.id, "plan_approved");
  transitionRun(run.id, "running");
  assert.equal(getRun(run.id)!.status, "running");

  const n = recoverOrphanedRuns();
  assert.equal(n, 1);
  assert.equal(getRun(run.id)!.status, "failed");
});

test("recoverOrphanedRuns is a no-op when queue is clean", () => {
  assert.equal(recoverOrphanedRuns(), 0);
});

test("cancelActiveRun delegates to process registry without throwing", () => {
  assert.doesNotThrow(() => cancelActiveRun("missing-run-id"));
});