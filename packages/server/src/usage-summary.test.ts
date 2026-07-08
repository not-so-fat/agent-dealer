import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-usage-"));
process.env.MAX_CONCURRENT_RUNS = "0";

const { migrate } = await import("./db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID } = await import("@agent-dealer/shared");
const { updateAgent } = await import("./repository/agents.js");
const { addArtifact, createRun, getRun, transitionRun } = await import("./repository/runs.js");
const { buildLineageUsageSummary } = await import("./usage-summary.js");

before(() => {
  migrate();
  updateAgent(BUILTIN_AGENT_CLAUDE_ID, { workspaceRoot: process.env.AGENT_DEALER_HOME! });
});

test("qa usage artifacts get their own label and do not inflate the execute count", () => {
  const run = createRun({
    title: "Usage test",
    taskCategory: "other",
    status: "plan_approved",
    agentId: BUILTIN_AGENT_CLAUDE_ID,
  });
  transitionRun(run.id, "running");
  transitionRun(run.id, "review");
  addArtifact(run.id, "usage", { phase: "execute", runtime: "claude_code", totalCostUsd: 1 }, "agent");
  addArtifact(run.id, "usage", { phase: "qa", runtime: "claude_code", totalCostUsd: 0.1 }, "agent");
  addArtifact(run.id, "usage", { phase: "qa", runtime: "claude_code", totalCostUsd: 0.1 }, "agent");

  const summary = buildLineageUsageSummary(getRun(run.id)!);
  const labels = summary.lines.map((l) => l.label);
  assert.deepEqual(labels, ["execute", "Q&A", "Q&A 2"]);
  assert.equal(Math.round(summary.total.totalCostUsd * 100) / 100, 1.2);
});
