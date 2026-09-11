// packages/server/src/coordinator/prompts.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeveloperPrompt } from "./prompts.js";

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
