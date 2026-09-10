import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReviewerResult } from "./reviewer-result.js";

const VALID_BLOCK = `
Reviewed the diff against the task snapshot.

\`\`\`json
{
  "verdict": "changes_requested",
  "baseSha": "abc123",
  "headSha": "def456",
  "acceptanceCriteriaAssessment": "Partially met — missing null check",
  "evidenceAssessment": "42 tests pass, Lens passed",
  "findings": [
    {"fingerprint": "auth-null-check", "severity": "blocking", "title": "Missing null check", "rationale": "user can be undefined", "file": "src/auth.ts", "line": 42}
  ],
  "risks": ["No test covers the logout race condition"]
}
\`\`\`
`;

test("parseReviewerResult extracts a valid JSON fence", () => {
  const result = parseReviewerResult(VALID_BLOCK);
  assert.equal(result?.verdict, "changes_requested");
  assert.equal(result?.findings.length, 1);
  assert.equal(result?.findings[0].fingerprint, "auth-null-check");
});

test("parseReviewerResult returns null for prose with no JSON fence", () => {
  assert.equal(parseReviewerResult("Looks good to me, approved."), null);
});

test("parseReviewerResult returns null when the fence doesn't match the schema", () => {
  assert.equal(parseReviewerResult("```json\n{\"verdict\": \"maybe\"}\n```"), null);
});
