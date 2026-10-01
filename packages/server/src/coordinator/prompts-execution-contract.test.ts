// NOT-306: developer and reviewer prompts render the frozen execution contract
// as dedicated sections — mode, non-goals, exit predicate, one-PR boundary,
// per-criterion evidence — without telling the worker to rediscover them.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExecutionContractV1 } from "@agent-dealer/shared";
import { buildDeveloperPrompt, buildReviewerPrompt } from "./prompts.js";
import { parseReviewerResult } from "./reviewer-result.js";

const CONTRACT: ExecutionContractV1 = {
  version: "v1",
  executionMode: "bug fix",
  nonGoals: ["Rewriting the Linear ticket from Dealer", "Changing product scope after start"],
  exitPredicate: "The login retry succeeds observably on the second attempt.",
  onePrStoppingPoint: "Stop after the retry fix lands with its regression test.",
  acceptanceCriteria: [
    { text: "Retry succeeds on the second attempt", evidence: "auth tests | npm run test:unit | green" },
    { text: "No new warnings in the log", evidence: null },
  ],
};

const LEGACY_SNAPSHOT = {
  title: "Add widget",
  description: "Build the widget.",
  acceptanceCriteria: "Widget renders.",
  repo: "acme/app",
  baseBranch: "main",
};

const CONTRACT_SNAPSHOT = { ...LEGACY_SNAPSHOT, executionContract: CONTRACT };

test("developer prompt renders every contract section verbatim, never as pointers", () => {
  const prompt = buildDeveloperPrompt({ taskSnapshot: CONTRACT_SNAPSHOT, round: 1 });
  assert.match(prompt, /## Execution contract \(frozen v1/);
  assert.match(prompt, /### Execution mode/);
  assert.ok(prompt.includes("bug fix"), "mode value must appear verbatim");
  assert.match(prompt, /### Non-goals/);
  assert.ok(prompt.includes("Rewriting the Linear ticket from Dealer"));
  assert.ok(prompt.includes("Changing product scope after start"));
  assert.match(prompt, /### Exit predicate/);
  assert.ok(prompt.includes("The login retry succeeds observably on the second attempt."));
  assert.match(prompt, /### One-PR stopping point/);
  assert.ok(prompt.includes("Stop after the retry fix lands with its regression test."));
  assert.match(prompt, /### Per-criterion evidence/);
  assert.ok(prompt.includes("Retry succeeds on the second attempt"));
  assert.ok(prompt.includes("Evidence: auth tests | npm run test:unit | green"));
  assert.ok(prompt.includes("No new warnings in the log"));
  assert.match(prompt, /do not rediscover/i);
});

test("reviewer prompt renders the contract and demands exit-predicate plus per-criterion evidence verdicts", () => {
  const prompt = buildReviewerPrompt({
    taskSnapshot: CONTRACT_SNAPSHOT,
    round: 1,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    diff: "diff --git a/x b/x\n+added line\n",
  });
  assert.match(prompt, /## Execution contract \(frozen v1/);
  assert.ok(prompt.includes("The login retry succeeds observably on the second attempt."));
  assert.ok(prompt.includes("Evidence: auth tests | npm run test:unit | green"));
  // The verdict contract assesses the exit predicate and each evidence line —
  // not just the prose acceptance criteria.
  assert.match(prompt, /"exitPredicateAssessment"/);
  assert.match(prompt, /EACH criterion's stated evidence/i);
  assert.match(prompt, /never a blanket "evidence looks good"/);
  assert.match(prompt, /"approved" additionally requires the exit predicate to hold/);
});

test("legacy snapshots without a contract omit the contract section but keep the shared verdict shape", () => {
  const developer = buildDeveloperPrompt({ taskSnapshot: LEGACY_SNAPSHOT, round: 1 });
  assert.doesNotMatch(developer, /## Execution contract/);
  assert.match(developer, /## Acceptance criteria/);
  const reviewer = buildReviewerPrompt({
    taskSnapshot: LEGACY_SNAPSHOT,
    round: 1,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    diff: "diff --git a/x b/x\n+added line\n",
  });
  assert.doesNotMatch(reviewer, /## Execution contract/);
  // The exit-predicate/evidence verdict rules apply to every review, so the
  // reviewer shape always carries the optional assessment field.
  assert.match(reviewer, /"exitPredicateAssessment"/);
  assert.match(reviewer, /Tasks without a contract omit "exitPredicateAssessment"/);
});

test("a null contract is identical to an absent one", () => {
  const absent = buildDeveloperPrompt({ taskSnapshot: LEGACY_SNAPSHOT, round: 1 });
  assert.equal(
    buildDeveloperPrompt({ taskSnapshot: { ...LEGACY_SNAPSHOT, executionContract: null }, round: 1 }),
    absent
  );
});

test("reviewer output parses an exit-predicate assessment; legacy outputs still parse", () => {
  const withPredicate = {
    verdict: "approved",
    baseSha: "aaaa",
    headSha: "bbbb",
    acceptanceCriteriaAssessment: "All criteria met.",
    evidenceAssessment: "Criterion 1 verified via auth tests (green); criterion 2 has no stated evidence.",
    exitPredicateAssessment: "The retry succeeds observably on the second attempt — holds at this tip.",
    findings: [],
    risks: [],
  };
  const parsed = parseReviewerResult(`\`\`\`json\n${JSON.stringify(withPredicate)}\n\`\`\``);
  assert.deepEqual(parsed, withPredicate);
  const legacy = {
    verdict: "approved",
    baseSha: "aaaa",
    headSha: "bbbb",
    acceptanceCriteriaAssessment: "Meets criteria.",
    evidenceAssessment: "Tests pass.",
    findings: [],
    risks: [],
  };
  assert.deepEqual(parseReviewerResult(JSON.stringify(legacy)), legacy);
});
