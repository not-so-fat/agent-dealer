import { test } from "node:test";
import assert from "node:assert/strict";
import { ResultQaContent, ResultQaInput, QA_PHASE_BUDGET, latestQaExchanges } from "./result-qa.js";

const base = {
  exchangeId: "x1",
  question: "Why did you pick SQLite?",
  status: "pending" as const,
  sessionResumed: true,
  askedAt: "2026-07-08T00:00:00.000Z",
};

test("pending exchange parses without an answer", () => {
  const parsed = ResultQaContent.parse(base);
  assert.equal(parsed.status, "pending");
  assert.equal(parsed.answer, undefined);
});

test("answered exchange keeps answer and answeredAt", () => {
  const parsed = ResultQaContent.parse({
    ...base,
    status: "answered",
    answer: "Because the run is single-process.",
    answeredAt: "2026-07-08T00:01:00.000Z",
  });
  assert.equal(parsed.answer, "Because the run is single-process.");
});

test("failed exchange carries an error", () => {
  const parsed = ResultQaContent.parse({ ...base, status: "failed", error: "exit 1" });
  assert.equal(parsed.error, "exit 1");
});

test("empty question is rejected", () => {
  assert.throws(() => ResultQaInput.parse({ question: "" }));
});

test("question over 2000 chars is rejected", () => {
  assert.throws(() => ResultQaInput.parse({ question: "x".repeat(2001) }));
});

test("QA budget is the fixed v1 cap", () => {
  assert.deepEqual(QA_PHASE_BUDGET, { maxTurns: 6, maxBudgetUsd: 0.25 });
});

test("latestQaExchanges keeps the newest artifact per exchangeId, ordered by askedAt", () => {
  const pending = ResultQaContent.parse({ ...base, exchangeId: "x2", askedAt: "2026-07-08T00:05:00.000Z" });
  const first = ResultQaContent.parse(base);
  const firstAnswered = ResultQaContent.parse({
    ...base,
    status: "answered",
    answer: "A",
    answeredAt: "2026-07-08T00:02:00.000Z",
  });
  // artifacts arrive oldest-first; the second x1 supersedes the first
  const out = latestQaExchanges([first, firstAnswered, pending]);
  assert.equal(out.length, 2);
  assert.equal(out[0].exchangeId, "x1");
  assert.equal(out[0].status, "answered");
  assert.equal(out[1].exchangeId, "x2");
});
