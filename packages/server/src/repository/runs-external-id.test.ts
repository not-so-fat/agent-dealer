import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-extid-"));
process.env.MAX_CONCURRENT_RUNS = "0";

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID } = await import("@agent-dealer/shared");
const { updateAgent } = await import("./agents.js");
const { createRun } = await import("./runs.js");

before(() => {
  migrate();
  updateAgent(BUILTIN_AGENT_CLAUDE_ID, { workspaceRoot: process.env.AGENT_DEALER_HOME! });
});

test("manual create mints external_id = run.id and leaves external_label null", () => {
  const run = createRun({
    title: "Manual task",
    taskCategory: "other",
    status: "plan_pending",
    agentId: BUILTIN_AGENT_CLAUDE_ID,
  });
  assert.equal(run.externalId, run.id);
  assert.equal(run.externalLabel, null);
  assert.equal(run.source, "manual");
});

test("manual retry copies parent external_id", () => {
  const parent = createRun({
    title: "Manual task",
    taskCategory: "other",
    status: "plan_pending",
    agentId: BUILTIN_AGENT_CLAUDE_ID,
  });
  const child = createRun(
    {
      title: parent.title,
      taskCategory: parent.taskCategory,
      status: "plan_approved",
      agentId: BUILTIN_AGENT_CLAUDE_ID,
    },
    {
      source: parent.source,
      externalId: parent.externalId ?? undefined,
      externalLabel: parent.externalLabel ?? undefined,
      lineageId: parent.lineageId ?? parent.id,
    }
  );
  assert.equal(child.externalId, parent.externalId);
  assert.equal(child.externalId, parent.id);
  assert.equal(child.externalLabel, null);
  assert.notEqual(child.id, parent.id);
});

test("explicit linear externalId is not replaced by run.id", () => {
  const issueId = "11111111-1111-4111-8111-111111111111";
  const run = createRun(
    {
      title: "LIN-1: Linear task",
      taskCategory: "code",
      status: "plan_pending",
      agentId: BUILTIN_AGENT_CLAUDE_ID,
    },
    { source: "linear", externalId: issueId, externalLabel: "LIN-1" }
  );
  assert.equal(run.externalId, issueId);
  assert.equal(run.externalLabel, "LIN-1");
  assert.notEqual(run.externalId, run.id);
});
