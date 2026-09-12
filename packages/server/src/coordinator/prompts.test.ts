// packages/server/src/coordinator/prompts.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeveloperPrompt, buildReviewerPrompt } from "./prompts.js";

const taskSnapshot = {
  title: "Add widget",
  description: "Build the widget.",
  acceptanceCriteria: "Widget renders.",
  repo: "/repo",
  baseBranch: "main",
};

test("round 1 prompt instructs a fresh branch off base and never mentions push/PR", () => {
  const prompt = buildDeveloperPrompt({ taskSnapshot, round: 1 });
  assert.match(prompt, /fresh branch off main/);
  assert.match(prompt, /do NOT push and do NOT open a pull request/);
  assert.doesNotMatch(prompt, /gh pr create/);
});

test("repair round includes findings and references the round number", () => {
  const prompt = buildDeveloperPrompt({
    taskSnapshot,
    round: 2,
    findings: [{ fingerprint: "f1", severity: "blocking", title: "Bug", rationale: "It breaks", file: "a.ts", line: 10, status: "open", firstRound: 1, lastRound: 1, issueId: "i" } as never],
  });
  assert.match(prompt, /repair round 2/);
  assert.match(prompt, /\[blocking\] Bug \(a\.ts:10\): It breaks/);
});

test("a round-1 infra retry never claims a fresh branch — it says the branch may already carry partial work", () => {
  const prompt = buildDeveloperPrompt({ taskSnapshot, round: 1, retryReason: "Developer session failed or crashed." });
  assert.doesNotMatch(prompt, /fresh branch/);
  assert.match(prompt, /retry of round 1 after the previous attempt failed: Developer session failed or crashed\./);
  assert.match(prompt, /may already carry partial work/);
});

test("an infra retry on a repair round still surfaces the failure reason, not the generic repair framing", () => {
  const prompt = buildDeveloperPrompt({ taskSnapshot, round: 2, retryReason: "Developer's PR checks failed." });
  assert.match(prompt, /retry of round 2 after the previous attempt failed: Developer's PR checks failed\./);
  assert.doesNotMatch(prompt, /^This is repair round 2\./m);
});

test("deck section lists every playbook id, not just the first", () => {
  const prompt = buildDeveloperPrompt({
    taskSnapshot,
    round: 1,
    worktreePath: "/wt",
    deckId: "deck-1",
    playbookIds: ["pb-a", "pb-b"],
  });
  assert.match(prompt, /bind_workspace\(\{ deckId: "deck-1", workspaceRoot: "\/wt" \}\)/);
  assert.match(prompt, /get_playbook\("pb-a"\)/);
  assert.match(prompt, /get_playbook\("pb-b"\)/);
});

test("no deck section when the profile has no deckId", () => {
  const prompt = buildDeveloperPrompt({ taskSnapshot, round: 1, worktreePath: "/wt", deckId: null });
  assert.doesNotMatch(prompt, /bind_workspace/);
});

test("guidance since the last session is surfaced in the developer prompt", () => {
  const prompt = buildDeveloperPrompt({ taskSnapshot, round: 2, guidance: ["Use the new logging util instead."] });
  assert.match(prompt, /## Guidance from the team/);
  assert.match(prompt, /Use the new logging util instead\./);
});

test("no guidance section when there is none", () => {
  const prompt = buildDeveloperPrompt({ taskSnapshot, round: 1 });
  assert.doesNotMatch(prompt, /## Guidance from the team/);
});

test("guidance since the last session is surfaced in the reviewer prompt", () => {
  const prompt = buildReviewerPrompt({
    taskSnapshot,
    round: 1,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    diff: "diff --git a/x b/x\n",
    guidance: ["Pay extra attention to the auth module."],
  });
  assert.match(prompt, /## Guidance from the team/);
  assert.match(prompt, /Pay extra attention to the auth module\./);
});

const reviewerBase = {
  taskSnapshot,
  round: 1,
  baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  diff: "diff --git a/x b/x\n+added line\n",
};

test("reviewer prompt embeds the diff, echoes the exact SHAs to report, and forbids editing", () => {
  const prompt = buildReviewerPrompt(reviewerBase);
  assert.match(prompt, /\+added line/);
  assert.match(prompt, /"baseSha" to exactly "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"/);
  assert.match(prompt, /"headSha" to exactly "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"/);
  assert.match(prompt, /You cannot edit files, push, or publish anything/);
});

test("reviewer prompt includes the developer's conclusion, checks summary, and prior findings when given", () => {
  const prompt = buildReviewerPrompt({
    ...reviewerBase,
    implementationConclusion: "Added the widget per spec.",
    checksSummary: "success (at deadbeef)",
    findings: [
      { id: "f1", issueId: "i", fingerprint: "fp1", severity: "blocking", title: "Bug", rationale: "It breaks", evidenceRef: null, file: "a.ts", line: 10, status: "recurring", firstRound: 1, lastRound: 1 },
    ],
  });
  assert.match(prompt, /Added the widget per spec\./);
  assert.match(prompt, /success \(at deadbeef\)/);
  assert.match(prompt, /\[recurring\/blocking\] Bug \(a\.ts:10\): It breaks/);
});

test("reviewer prompt omits optional sections when absent", () => {
  const prompt = buildReviewerPrompt(reviewerBase);
  assert.doesNotMatch(prompt, /Developer's implementation conclusion/);
  assert.doesNotMatch(prompt, /## CI checks/);
  assert.doesNotMatch(prompt, /Findings from prior rounds/);
  assert.doesNotMatch(prompt, /bind_workspace/);
});

test("reviewer prompt deck section lists every playbook id, matching the developer prompt's pattern", () => {
  const prompt = buildReviewerPrompt({ ...reviewerBase, worktreePath: "/wt", deckId: "deck-1", playbookIds: ["pb-a", "pb-b"] });
  assert.match(prompt, /bind_workspace\(\{ deckId: "deck-1", workspaceRoot: "\/wt" \}\)/);
  assert.match(prompt, /get_playbook\("pb-a"\)/);
  assert.match(prompt, /get_playbook\("pb-b"\)/);
});
