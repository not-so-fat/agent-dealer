import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-prompts-"));
process.env.MAX_CONCURRENT_RUNS = "0";

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID } = await import("@agent-dealer/shared");
const { updateAgent } = await import("../repository/agents.js");
const { addArtifact, createRun } = await import("../repository/runs.js");
const { buildExecutionPrompt, buildPlanPrompt, buildPlanRevisePrompt } = await import("./prompts.js");

const QUESTIONS = [
  {
    id: "q1",
    question: "Which storage backend?",
    options: [{ label: "SQLite" }, { label: "Postgres" }],
  },
];

before(() => {
  migrate();
  updateAgent(BUILTIN_AGENT_CLAUDE_ID, { workspaceRoot: process.env.AGENT_DEALER_HOME! });
});

function makeRun() {
  return createRun({
    title: "Prompt test task",
    taskCategory: "other",
    status: "plan_pending",
    agentId: BUILTIN_AGENT_CLAUDE_ID,
  });
}

test("plan prompt includes the triage contract", () => {
  const prompt = buildPlanPrompt(makeRun());
  assert.match(prompt, /"verdict"/);
  assert.match(prompt, /needs_review/);
  assert.match(prompt, /at most 3 questions/i);
});

test("communication plan prompt favors trivial triage and defers send details to send gate", () => {
  const run = createRun({
    title: "Send a test message to Yusuke",
    description: "Say hello from agent-dealer",
    taskCategory: "communication",
    status: "plan_pending",
    agentId: BUILTIN_AGENT_CLAUDE_ID,
  });
  const prompt = buildPlanPrompt(run);
  assert.match(prompt, /Outbound send gate/);
  assert.match(prompt, /send gate reviews the exact payload/i);
  assert.match(prompt, /Do not ask plan questions about recipient/i);
  assert.doesNotMatch(prompt, /When in doubt, use "needs_review"/);
  assert.match(prompt, /brief bullet plan/i);
  assert.doesNotMatch(prompt, /step-by-step plan with risks/);
});

test("other category plan prompt keeps conservative when-in-doubt rule", () => {
  const prompt = buildPlanPrompt(makeRun());
  assert.match(prompt, /When in doubt, use "needs_review"/);
  assert.match(prompt, /step-by-step plan with risks/);
});

test("execution prompt renders human answers as Q→A pairs", () => {
  const run = makeRun();
  addArtifact(run.id, "draft_plan", { markdown: "# Plan" }, "agent");
  addArtifact(
    run.id,
    "plan_triage",
    { verdict: "needs_review", rationale: "r", questions: QUESTIONS, parseFallback: false, consumed: false },
    "agent"
  );
  addArtifact(run.id, "approved_plan", { markdown: "# Plan" }, "human");
  addArtifact(
    run.id,
    "plan_answers",
    {
      answers: [{ questionId: "q1", selectedLabel: "SQLite" }],
      outcome: "approved",
      answeredAt: new Date().toISOString(),
    },
    "human"
  );
  const prompt = buildExecutionPrompt(run);
  assert.match(prompt, /## Human answers to plan questions/);
  assert.match(prompt, /Which storage backend\?.*SQLite/s);
});

test("execution prompt omits answers section when none exist", () => {
  const run = makeRun();
  addArtifact(run.id, "approved_plan", { markdown: "# Plan" }, "human");
  assert.doesNotMatch(buildExecutionPrompt(run), /Human answers to plan questions/);
});

test("revise prompt pairs each answer with its question and re-states the contract", () => {
  const run = makeRun();
  const prompt = buildPlanRevisePrompt(run, QUESTIONS, [{ questionId: "q1", freeText: "Use flat files instead" }]);
  assert.match(prompt, /Which storage backend\?/);
  assert.match(prompt, /Use flat files instead/);
  assert.match(prompt, /"verdict"/);
});

test("execution prompt includes outbound draft contract", () => {
  const run = makeRun();
  addArtifact(run.id, "approved_plan", { markdown: "# Plan" }, "human");
  const prompt = buildExecutionPrompt(run);
  assert.match(prompt, /Outbound actions/);
  assert.match(prompt, /call_service_tool is blocked/);
  assert.match(prompt, /"actionType"/);
});
