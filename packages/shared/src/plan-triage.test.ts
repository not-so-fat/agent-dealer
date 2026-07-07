import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PlanTriageBlock,
  PlanAnswersInput,
  planGateDecision,
} from "./plan-triage.js";

const QUESTION = {
  id: "q1",
  question: "Reuse parent budget?",
  options: [
    { label: "Reuse parent", description: "Same caps as parent run" },
    { label: "Fresh default", description: "Reset to defaults" },
  ],
};

test("PlanTriageBlock accepts needs_review with questions", () => {
  const parsed = PlanTriageBlock.parse({
    verdict: "needs_review",
    rationale: "Budget handling is ambiguous",
    questions: [QUESTION],
  });
  assert.equal(parsed.questions.length, 1);
});

test("PlanTriageBlock rejects trivial verdict carrying questions", () => {
  assert.throws(() =>
    PlanTriageBlock.parse({
      verdict: "trivial",
      rationale: "simple",
      questions: [QUESTION],
    })
  );
});

test("PlanTriageBlock defaults questions to empty array", () => {
  const parsed = PlanTriageBlock.parse({ verdict: "trivial", rationale: "one-file doc edit" });
  assert.deepEqual(parsed.questions, []);
});

test("PlanAnswersInput rejects an answer with both selectedLabel and freeText", () => {
  assert.throws(() =>
    PlanAnswersInput.parse({
      answers: [{ questionId: "q1", selectedLabel: "A", freeText: "also this" }],
    })
  );
});

test("PlanAnswersInput rejects an answer with neither field", () => {
  assert.throws(() => PlanAnswersInput.parse({ answers: [{ questionId: "q1" }] }));
});

const cleanTrivial = { verdict: "trivial" as const, questions: [], consumed: false, parseFallback: false };

test("gate: trivial clean triage auto-approves", () => {
  assert.equal(planGateDecision({ triage: cleanTrivial, priorQuestionRounds: 0 }), "auto_approve");
});

test("gate: parseFallback never auto-approves", () => {
  assert.equal(
    planGateDecision({ triage: { ...cleanTrivial, parseFallback: true }, priorQuestionRounds: 0 }),
    "await_review"
  );
});

test("gate: consumed triage never auto-approves", () => {
  assert.equal(
    planGateDecision({ triage: { ...cleanTrivial, consumed: true }, priorQuestionRounds: 0 }),
    "await_review"
  );
});

test("gate: questions present awaits answers", () => {
  assert.equal(
    planGateDecision({
      triage: { verdict: "needs_review", questions: [QUESTION], consumed: false, parseFallback: false },
      priorQuestionRounds: 0,
    }),
    "await_answers"
  );
});

test("gate: after 2 question rounds, questions go to manual review", () => {
  assert.equal(
    planGateDecision({
      triage: { verdict: "needs_review", questions: [QUESTION], consumed: false, parseFallback: false },
      priorQuestionRounds: 2,
    }),
    "await_review"
  );
});

test("gate: needs_review with no questions goes to manual review", () => {
  assert.equal(
    planGateDecision({
      triage: { verdict: "needs_review", questions: [], consumed: false, parseFallback: false },
      priorQuestionRounds: 0,
    }),
    "await_review"
  );
});
