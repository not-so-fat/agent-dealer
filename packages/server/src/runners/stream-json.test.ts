import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPlanTriage } from "./stream-json.js";

const PLAN = "# Plan\n1. Do the thing\n2. Verify";

const VALID_BLOCK = [
  "```json",
  JSON.stringify({
    verdict: "needs_review",
    rationale: "Two viable approaches",
    questions: [
      {
        id: "q1",
        question: "Which approach?",
        options: [{ label: "A" }, { label: "B", description: "slower but safer" }],
      },
    ],
  }),
  "```",
].join("\n");

test("parses trailing triage block and strips it from the markdown", () => {
  const r = extractPlanTriage(`${PLAN}\n\n${VALID_BLOCK}`);
  assert.equal(r.parseFallback, false);
  assert.equal(r.verdict, "needs_review");
  assert.equal(r.questions.length, 1);
  assert.equal(r.markdown, PLAN);
});

test("trivial block with no questions parses", () => {
  const block = '```json\n{"verdict":"trivial","rationale":"one-line change"}\n```';
  const r = extractPlanTriage(`${PLAN}\n\n${block}`);
  assert.equal(r.verdict, "trivial");
  assert.equal(r.parseFallback, false);
  assert.deepEqual(r.questions, []);
});

test("missing block falls back to needs_review with full markdown kept", () => {
  const r = extractPlanTriage(PLAN);
  assert.equal(r.parseFallback, true);
  assert.equal(r.verdict, "needs_review");
  assert.equal(r.markdown, PLAN);
});

test("malformed JSON falls back", () => {
  const r = extractPlanTriage(`${PLAN}\n\n\`\`\`json\n{not json}\n\`\`\``);
  assert.equal(r.parseFallback, true);
  assert.equal(r.markdown.includes("# Plan"), true);
});

test("last json block wins; earlier json-in-prose is ignored", () => {
  const early = '```json\n{"some":"config"}\n```';
  const r = extractPlanTriage(`${PLAN}\n\n${early}\n\nMore prose\n\n${VALID_BLOCK}`);
  assert.equal(r.parseFallback, false);
  assert.equal(r.markdown.includes('{"some":"config"}'), true);
  assert.equal(r.markdown.includes('"verdict"'), false);
});

test("valid json block that is not a triage shape falls back", () => {
  const r = extractPlanTriage(`${PLAN}\n\n\`\`\`json\n{"foo":"bar"}\n\`\`\``);
  assert.equal(r.parseFallback, true);
});
