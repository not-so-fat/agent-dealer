import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeveloperPrompt, buildReviewerPrompt } from "./prompts.js";

test("buildDeveloperPrompt includes the task snapshot and round number", () => {
  const prompt = buildDeveloperPrompt({
    taskSnapshot: { title: "Fix login bug", description: "Users get logged out", acceptanceCriteria: "Login persists across refresh", repo: "/repo", baseBranch: "main" },
    round: 1,
  });
  assert.ok(prompt.includes("Fix login bug"));
  assert.ok(prompt.includes("Login persists across refresh"));
  assert.ok(prompt.includes("implementation conclusion"));
});

test("buildDeveloperPrompt includes prior findings on a repair round", () => {
  const prompt = buildDeveloperPrompt({
    taskSnapshot: { title: "T", description: "D", acceptanceCriteria: "A", repo: "/repo", baseBranch: "main" },
    round: 2,
    findings: [{ id: "f1", issueId: "i1", fingerprint: "fp1", severity: "blocking", title: "Missing null check", rationale: "user can be undefined", evidenceRef: null, file: "src/auth.ts", line: 42, status: "open", firstRound: 1, lastRound: 1 }],
  });
  assert.ok(prompt.includes("Missing null check"));
  assert.ok(prompt.includes("src/auth.ts"));
});

test("buildReviewerPrompt includes base/head SHA and the JSON-fence contract", () => {
  const prompt = buildReviewerPrompt({
    taskSnapshot: { title: "T", description: "D", acceptanceCriteria: "A", repo: "/repo", baseBranch: "main" },
    baseSha: "abc123",
    headSha: "def456",
  });
  assert.ok(prompt.includes("abc123"));
  assert.ok(prompt.includes("def456"));
  assert.ok(prompt.includes("```json"));
  assert.ok(prompt.includes("verdict"));
});
