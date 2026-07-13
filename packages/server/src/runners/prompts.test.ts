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
const { buildExecutionPrompt, buildPlanPrompt, buildPlanEditedReplanPrompt, buildPlanFeedbackPrompt, buildPlanRevisePrompt, buildQaPrompt } =
  await import("./prompts.js");

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

test("feedback replan prompt includes human comments and contract", () => {
  const run = makeRun();
  const prompt = buildPlanFeedbackPrompt(run, "Add integration tests and skip the migration step.");
  assert.match(prompt, /Add integration tests/);
  assert.match(prompt, /"verdict"/);
});

test("edited replan prompt includes human-edited markdown", () => {
  const run = makeRun();
  const prompt = buildPlanEditedReplanPrompt(run, "# Revised plan\n\n1. Ship feature");
  assert.match(prompt, /Revised plan/);
  assert.match(prompt, /Ship feature/);
});

test("revise prompt pairs each answer with its question and re-states the contract", () => {
  const run = makeRun();
  const prompt = buildPlanRevisePrompt(run, QUESTIONS, [{ questionId: "q1", freeText: "Use flat files instead" }]);
  assert.match(prompt, /Which storage backend\?/);
  assert.match(prompt, /Use flat files instead/);
  assert.match(prompt, /"verdict"/);
});

test("delegated plan answers surface the unanswered questions to the executor", () => {
  const run = makeRun();
  addArtifact(run.id, "draft_plan", { markdown: "# Plan" }, "agent");
  addArtifact(run.id, "plan_triage", {
    verdict: "needs_review", rationale: "r", questions: QUESTIONS, parseFallback: false, consumed: true,
  }, "agent");
  addArtifact(run.id, "approved_plan", { markdown: "# Plan" }, "human");
  addArtifact(run.id, "plan_answers", { answers: [], outcome: "delegated", answeredAt: new Date().toISOString() }, "human");

  const prompt = buildExecutionPrompt(run);
  assert.match(prompt, /## Unanswered plan questions/);
  assert.match(prompt, /Which storage backend\?/);
  assert.match(prompt, /SQLite/);
  assert.match(prompt, /best judgment/i);
  assert.doesNotMatch(prompt, /## Human answers to plan questions/);
});

test("execution prompt renders answered review Q&A from the lineage parent", () => {
  const parent = makeRun();
  addArtifact(parent.id, "approved_plan", { markdown: "# Plan" }, "human");
  addArtifact(parent.id, "result_qa", {
    exchangeId: "x1",
    question: "Did you run the tests?",
    answer: "Yes, all 12 pass.",
    status: "answered",
    sessionResumed: true,
    askedAt: "2026-07-08T00:00:00.000Z",
    answeredAt: "2026-07-08T00:01:00.000Z",
  }, "agent");
  addArtifact(parent.id, "result_qa", {
    exchangeId: "x2",
    question: "Pending one",
    status: "pending",
    sessionResumed: true,
    askedAt: "2026-07-08T00:02:00.000Z",
  }, "human");

  const retry = createRun(
    {
      title: "Prompt test task",
      taskCategory: "other",
      status: "plan_approved",
      agentId: BUILTIN_AGENT_CLAUDE_ID,
    },
    { lineageId: parent.lineageId ?? parent.id }
  );
  addArtifact(retry.id, "approved_plan", { markdown: "# Plan" }, "human");
  addArtifact(retry.id, "feedback", { markdown: "Tighten the summary" }, "human");

  const prompt = buildExecutionPrompt(retry);
  assert.match(prompt, /## Review Q&A/);
  assert.match(prompt, /Did you run the tests\?/);
  assert.match(prompt, /Yes, all 12 pass\./);
  assert.doesNotMatch(prompt, /Pending one/);
});

test("execution prompt omits the Q&A section when there are no answered exchanges", () => {
  const run = makeRun();
  addArtifact(run.id, "approved_plan", { markdown: "# Plan" }, "human");
  assert.doesNotMatch(buildExecutionPrompt(run), /## Review Q&A/);
});

test("grounded qa prompt asks the question without re-stating artifacts", () => {
  const run = makeRun();
  addArtifact(run.id, "approved_plan", { markdown: "# Plan\n1. Use SQLite" }, "human");
  const prompt = buildQaPrompt(run, "Why SQLite?", { grounded: true });
  assert.match(prompt, /Why SQLite\?/);
  assert.match(prompt, /Do NOT modify anything/i);
  assert.doesNotMatch(prompt, /## Approved plan/);
});

test("ungrounded qa prompt rebuilds context from artifacts", () => {
  const run = makeRun();
  addArtifact(run.id, "approved_plan", { markdown: "# Plan\n1. Use SQLite" }, "human");
  addArtifact(run.id, "execution_result", { phase: "execute", exitCode: 0, resultText: "Wrote the doc", isError: false }, "agent");
  addArtifact(run.id, "document", { path: "/tmp/x.md", title: "x", markdown: "# Deliverable body" }, "agent");
  const prompt = buildQaPrompt(run, "Why SQLite?", { grounded: false });
  assert.match(prompt, /## Approved plan/);
  assert.match(prompt, /## Execution outcome/);
  assert.match(prompt, /## Deliverable/);
  assert.match(prompt, /# Deliverable body/);
  assert.match(prompt, /Why SQLite\?/);
});

test("qa prompt never asks for a json block or an outbound draft", () => {
  const run = makeRun();
  const prompt = buildQaPrompt(run, "What did you check?", { grounded: true });
  assert.doesNotMatch(prompt, /Outbound actions/);
  assert.doesNotMatch(prompt, /"verdict"/);
});

test("execution prompt includes outbound draft contract", () => {
  const run = makeRun();
  addArtifact(run.id, "approved_plan", { markdown: "# Plan" }, "human");
  const prompt = buildExecutionPrompt(run);
  assert.match(prompt, /Outbound actions/);
  assert.match(prompt, /call_service_tool IS available/);
  assert.doesNotMatch(prompt, /call_service_tool is blocked/);
  assert.match(prompt, /service_tool_call/);
  assert.match(prompt, /"actionType"/);
});
