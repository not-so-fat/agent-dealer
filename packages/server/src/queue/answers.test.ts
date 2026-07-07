import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-answers-"));
process.env.MAX_CONCURRENT_RUNS = "0";

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID } = await import("@agent-dealer/shared");
const { updateAgent } = await import("../repository/agents.js");
const { addArtifact, createRun, getLatestArtifact, getRun, markPlanTriageConsumed } =
  await import("../repository/runs.js");
const { submitPlanAnswers } = await import("./dispatcher.js");

const QUESTIONS = [
  { id: "q1", question: "Which approach?", options: [{ label: "A" }, { label: "B" }] },
  { id: "q2", question: "Ship docs too?", options: [{ label: "Yes" }, { label: "No" }] },
];

before(() => {
  migrate();
  updateAgent(BUILTIN_AGENT_CLAUDE_ID, { workspaceRoot: process.env.AGENT_DEALER_HOME! });
});

function seedQuestionRun() {
  const run = createRun({
    title: "Answers test",
    taskCategory: "other",
    status: "plan_pending",
    agentId: BUILTIN_AGENT_CLAUDE_ID,
  });
  addArtifact(run.id, "draft_plan", { markdown: "# Plan", sessionId: "sess-1" }, "agent");
  addArtifact(
    run.id,
    "plan_triage",
    { verdict: "needs_review", rationale: "r", questions: QUESTIONS, sessionId: "sess-1", parseFallback: false, consumed: false },
    "agent"
  );
  return getRun(run.id)!;
}

test("all-structured answers approve and mark plan_answers approved", () => {
  const run = seedQuestionRun();
  const res = submitPlanAnswers(run.id, {
    answers: [
      { questionId: "q1", selectedLabel: "A" },
      { questionId: "q2", selectedLabel: "No" },
    ],
  });
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.outcome, "approved");
  assert.equal(getRun(run.id)!.status, "plan_approved");
  const ans = getLatestArtifact(run.id, "plan_answers");
  assert.match(ans!.contentJson!, /"outcome":"approved"/);
  assert.equal(getLatestArtifact(run.id, "approved_plan")!.author, "human");
});

test("free-form answer schedules a redraft instead of approving", () => {
  const run = seedQuestionRun();
  let redrafted = false;
  const res = submitPlanAnswers(
    run.id,
    {
      answers: [
        { questionId: "q1", freeText: "Do it a third way" },
        { questionId: "q2", selectedLabel: "Yes" },
      ],
    },
    { onRedraft: () => { redrafted = true; } }
  );
  assert.equal(res.ok && res.outcome, "redraft");
  assert.equal(redrafted, true);
  assert.equal(getRun(run.id)!.status, "plan_pending");
});

test("answers must cover every open question exactly once", () => {
  const run = seedQuestionRun();
  const res = submitPlanAnswers(run.id, { answers: [{ questionId: "q1", selectedLabel: "A" }] });
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.code, 400);
});

test("double submit returns 409", () => {
  const run = seedQuestionRun();
  submitPlanAnswers(run.id, {
    answers: [
      { questionId: "q1", selectedLabel: "A" },
      { questionId: "q2", selectedLabel: "Yes" },
    ],
  });
  const again = submitPlanAnswers(run.id, {
    answers: [
      { questionId: "q1", selectedLabel: "B" },
      { questionId: "q2", selectedLabel: "No" },
    ],
  });
  assert.equal(!again.ok && again.code, 409);
});

test("run without open questions returns 409", () => {
  const run = createRun({
    title: "No questions",
    taskCategory: "other",
    status: "plan_pending",
    agentId: BUILTIN_AGENT_CLAUDE_ID,
  });
  const res = submitPlanAnswers(run.id, { answers: [{ questionId: "q1", selectedLabel: "A" }] });
  assert.equal(!res.ok && res.code, 409);
});

test("consumed triage rejects answers", () => {
  const run = seedQuestionRun();
  markPlanTriageConsumed(run.id);
  const res = submitPlanAnswers(run.id, {
    answers: [
      { questionId: "q1", selectedLabel: "A" },
      { questionId: "q2", selectedLabel: "Yes" },
    ],
  });
  assert.equal(!res.ok && res.code, 409);
});
