import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-delegate-"));
process.env.MAX_CONCURRENT_RUNS = "0";

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID } = await import("@agent-dealer/shared");
const { updateAgent } = await import("../repository/agents.js");
const { addArtifact, createRun, getLatestArtifact, markPlanTriageConsumed } =
  await import("../repository/runs.js");
const { recordPlanDelegation } = await import("./plan-delegation.js");

const QUESTIONS = [{ id: "q1", question: "Which backend?", options: [{ label: "SQLite" }, { label: "Postgres" }] }];

before(() => {
  migrate();
  updateAgent(BUILTIN_AGENT_CLAUDE_ID, { workspaceRoot: process.env.AGENT_DEALER_HOME! });
});

function seedRun(triage?: Record<string, unknown>) {
  const run = createRun({
    title: "Delegate test",
    taskCategory: "other",
    status: "plan_pending",
    agentId: BUILTIN_AGENT_CLAUDE_ID,
  });
  addArtifact(run.id, "draft_plan", { markdown: "# Plan" }, "agent");
  if (triage) addArtifact(run.id, "plan_triage", triage, "agent");
  return run;
}

test("open questions produce a delegated plan_answers record", () => {
  const run = seedRun({ verdict: "needs_review", rationale: "r", questions: QUESTIONS, parseFallback: false, consumed: false });
  assert.equal(recordPlanDelegation(run.id), true);
  const art = getLatestArtifact(run.id, "plan_answers")!;
  const content = JSON.parse(art.contentJson!) as { outcome: string; answers: unknown[] };
  assert.equal(content.outcome, "delegated");
  assert.deepEqual(content.answers, []);
  assert.equal(art.author, "human");
});

test("no triage means nothing to delegate", () => {
  const run = seedRun();
  assert.equal(recordPlanDelegation(run.id), false);
  assert.equal(getLatestArtifact(run.id, "plan_answers"), null);
});

test("triage without questions means nothing to delegate", () => {
  const run = seedRun({ verdict: "trivial", rationale: "r", questions: [], parseFallback: false, consumed: false });
  assert.equal(recordPlanDelegation(run.id), false);
});

test("consumed triage means nothing to delegate", () => {
  const run = seedRun({ verdict: "needs_review", rationale: "r", questions: QUESTIONS, parseFallback: false, consumed: false });
  markPlanTriageConsumed(run.id);
  assert.equal(recordPlanDelegation(run.id), false);
});

test("already-answered questions are not delegated", () => {
  const run = seedRun({ verdict: "needs_review", rationale: "r", questions: QUESTIONS, parseFallback: false, consumed: false });
  addArtifact(run.id, "plan_answers", {
    answers: [{ questionId: "q1", selectedLabel: "SQLite" }],
    outcome: "approved",
    answeredAt: new Date().toISOString(),
  }, "human");
  assert.equal(recordPlanDelegation(run.id), false);
});
