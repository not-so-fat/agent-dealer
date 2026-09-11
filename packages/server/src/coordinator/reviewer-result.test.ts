// packages/server/src/coordinator/reviewer-result.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReviewerResult } from "./reviewer-result.js";

const valid = {
  verdict: "approved",
  baseSha: "aaaa",
  headSha: "bbbb",
  acceptanceCriteriaAssessment: "Meets criteria.",
  evidenceAssessment: "Tests pass.",
  findings: [],
  risks: [],
};

test("parses a fenced json block, ignoring surrounding prose", () => {
  const result = parseReviewerResult(`Some reasoning here.\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`\n`);
  assert.deepEqual(result, valid);
});

test("parses a bare JSON object with no fence", () => {
  const result = parseReviewerResult(JSON.stringify(valid));
  assert.deepEqual(result, valid);
});

test("returns null for prose with no valid JSON at all", () => {
  assert.equal(parseReviewerResult("I approve this PR."), null);
});

test("returns null when the fenced block doesn't match the schema (missing required field)", () => {
  const bad = { ...valid, verdict: undefined };
  assert.equal(parseReviewerResult(`\`\`\`json\n${JSON.stringify(bad)}\n\`\`\``), null);
});

test("rejects an unrecognized verdict", () => {
  const bad = { ...valid, verdict: "looks_good_to_me" };
  assert.equal(parseReviewerResult(`\`\`\`json\n${JSON.stringify(bad)}\n\`\`\``), null);
});

test("accepts an escalated verdict carrying a productScopeQuestion", () => {
  const escalated = { ...valid, verdict: "escalated", productScopeQuestion: "Should this support X?" };
  const result = parseReviewerResult(`\`\`\`json\n${JSON.stringify(escalated)}\n\`\`\``);
  assert.deepEqual(result, escalated);
});

test("findings carry file/line and severity through unchanged", () => {
  const withFindings = {
    ...valid,
    findings: [{ fingerprint: "f1", severity: "blocking", title: "Bug", rationale: "It breaks", file: "a.ts", line: 10 }],
  };
  const result = parseReviewerResult(`\`\`\`json\n${JSON.stringify(withFindings)}\n\`\`\``);
  assert.deepEqual(result, withFindings);
});
