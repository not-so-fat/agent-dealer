// NOT-288: the shared presentation layer keeps worktree/policy escalations
// concise by default while preserving every technical fact under Details.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  summarizeHumanAction,
  type ActionPresentationInput,
} from "./action-presentation.js";

const LOCAL_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REMOTE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const WORKTREE_PATH = "/Users/friend/.agent-dealer-dev/worktrees/310f25af-developer";

function baseAction(extra: Partial<ActionPresentationInput> = {}): ActionPresentationInput {
  return {
    actionType: "policy_escalation",
    question: "reason Resume development, or close the issue?",
    reason: "reason",
    evidenceJson: null,
    responseOptionsJson: JSON.stringify([
      { choice: "resume", label: "Resume development" },
      { choice: "close", label: "Close" },
    ]),
    continuationPreviewJson: null,
    ...extra,
  };
}

function worktreeConflictAction(): ActionPresentationInput {
  const reason =
    `issue branch is already used by worktree at ${WORKTREE_PATH}. ` +
    `Recovery:\n` +
    `git -C ${WORKTREE_PATH} status\n` +
    `git worktree remove --force ${WORKTREE_PATH}`;
  return baseAction({
    reason,
    question: `${reason} Resume development, or close the issue?`,
    evidenceJson: JSON.stringify({ worktreeBlocker: { fingerprint: "abc123" } }),
  });
}

test("worktree conflict shows a short question with paths and commands under Details", () => {
  const summary = summarizeHumanAction(worktreeConflictAction());
  assert.equal(summary.kind, "worktree-conflict");
  assert.ok(!summary.title.includes(WORKTREE_PATH), "default question hides the path");
  assert.ok(!summary.title.includes("git "), "default question hides git commands");
  assert.ok(summary.context && summary.context.length > 0, "one-sentence next step present");
  assert.equal(summary.safeResume, false);
  // Labels stay server-accurate: no promise of safety on preserved work.
  assert.deepEqual(
    summary.displayOptions.map((o) => o.label),
    ["Resume development", "Close"]
  );
  assert.ok(!summary.displayOptions.some((o) => /safely/i.test(o.label)));
  // Details preserve everything without truncation.
  assert.equal(summary.details.reason, worktreeConflictAction().reason);
  assert.equal(summary.details.question, worktreeConflictAction().question);
  assert.deepEqual(summary.details.commands, [
    `git -C ${WORKTREE_PATH} status`,
    `git worktree remove --force ${WORKTREE_PATH}`,
  ]);
  assert.ok(summary.details.paths.includes(WORKTREE_PATH));
});

test("dirty worktree shows a short question and never promises a safe resume", () => {
  const reason =
    "Developer worktree has uncommitted changes after the session ended. " +
    `Recovery:\ngit -C ${WORKTREE_PATH} status\ngit -C ${WORKTREE_PATH} stash list`;
  const summary = summarizeHumanAction(
    baseAction({ reason, question: `${reason} Resume development, or close the issue?` })
  );
  assert.equal(summary.kind, "dirty-worktree");
  assert.ok(!summary.title.includes(WORKTREE_PATH));
  assert.ok(!summary.title.includes("git "));
  assert.ok(summary.context);
  assert.equal(summary.safeResume, false);
  assert.ok(!summary.displayOptions.some((o) => /safely/i.test(o.label)));
  assert.deepEqual(summary.details.commands, [
    `git -C ${WORKTREE_PATH} status`,
    `git -C ${WORKTREE_PATH} stash list`,
  ]);
  assert.ok(summary.details.paths.includes(WORKTREE_PATH));
});

test("ordinary escalation shows a short question plus one-sentence context, Details keep the reason", () => {
  const reason = "Git/GitHub verification failed: gh pr checks timed out. (infra-attempt limit reached).";
  const summary = summarizeHumanAction(
    baseAction({ reason, question: `${reason} Resume development, or close the issue?` })
  );
  assert.equal(summary.kind, "ordinary-escalation");
  assert.equal(summary.title, "Development is parked — resume or close?");
  assert.ok(summary.context && summary.context.includes("Git/GitHub verification failed"));
  assert.ok(!summary.title.includes("gh "), "no command block as the first question");
  assert.equal(summary.safeResume, true);
  assert.deepEqual(
    summary.displayOptions.map((o) => o.label),
    ["Resume safely", "Close"]
  );
  assert.equal(summary.primaryChoice, "resume");
  assert.equal(summary.details.reason, reason);
  assert.deepEqual(summary.details.commands, []);
});

test("reviewer retry keeps its specific label and reads as safe", () => {
  const summary = summarizeHumanAction(
    baseAction({
      reason: "Reviewer session failed: timeout.",
      question: "Reviewer session failed: timeout. Retry the review, or close the issue?",
      continuationPreviewJson: JSON.stringify({ resumeRole: "reviewer", resumeHeadSha: "deadbeef" }),
      responseOptionsJson: JSON.stringify([
        { choice: "resume", label: "Retry review" },
        { choice: "close", label: "Close" },
      ]),
    })
  );
  assert.equal(summary.kind, "reviewer-retry");
  assert.equal(summary.safeResume, true);
  assert.deepEqual(
    summary.displayOptions.map((o) => o.label),
    ["Retry review", "Close"]
  );
});

test("diverged push keeps push_with_lease with full SHAs visible in Details", () => {
  const summary = summarizeHumanAction(
    baseAction({
      reason: "Developer's commits could not be pushed: rejected: non-fast-forward",
      question: "Developer's commits could not be pushed: rejected. Push local, resume, or close?",
      evidenceJson: JSON.stringify({
        pushDivergence: {
          branch: "issue-1",
          localSha: LOCAL_SHA,
          remoteSha: REMOTE_SHA,
          ahead: 2,
          behind: 1,
          relationship: "diverged",
          worktreePath: WORKTREE_PATH,
        },
      }),
      responseOptionsJson: JSON.stringify([
        { choice: "push_with_lease", label: "Push with lease" },
        { choice: "resume", label: "Resume development" },
        { choice: "close", label: "Close" },
      ]),
    })
  );
  assert.equal(summary.kind, "diverged-push");
  assert.equal(summary.safeResume, false);
  assert.deepEqual(
    summary.displayOptions.map((o) => o.choice),
    ["push_with_lease", "resume", "close"]
  );
  assert.equal(summary.primaryChoice, "push_with_lease");
  assert.ok(!summary.displayOptions.some((o) => /safely/i.test(o.label)));
  const facts = summary.details.factLines.join("\n");
  assert.ok(facts.includes(LOCAL_SHA), "full local SHA, not truncated");
  assert.ok(facts.includes(REMOTE_SHA), "full remote SHA, not truncated");
  assert.ok(facts.includes("origin/issue-1"));
  assert.ok(summary.details.paths.includes(WORKTREE_PATH));
  assert.ok(summary.details.evidencePretty?.includes(LOCAL_SHA));
});

test("behind-only push evidence never offers push_with_lease", () => {
  const summary = summarizeHumanAction(
    baseAction({
      reason: "Developer's commits could not be pushed: rejected: non-fast-forward",
      question: "Developer's commits could not be pushed. Resume development, or close the issue?",
      evidenceJson: JSON.stringify({
        pushDivergence: {
          branch: "issue-1",
          localSha: LOCAL_SHA,
          remoteSha: REMOTE_SHA,
          ahead: 0,
          behind: 2,
          relationship: "behind",
        },
      }),
    })
  );
  assert.equal(summary.kind, "unpushed");
  assert.deepEqual(
    summary.displayOptions.map((o) => o.choice),
    ["resume", "close"]
  );
  assert.equal(summary.safeResume, false);
});

test("legacy actions without evidence render sensibly and lose nothing", () => {
  const reason =
    `issue branch is already used by worktree at ${WORKTREE_PATH}. ` +
    `Recovery:\ngit worktree list\ngit worktree remove --force ${WORKTREE_PATH}`;
  const question = `${reason} Resume development, or close the issue?`;
  const summary = summarizeHumanAction(baseAction({ reason, question }));
  assert.equal(summary.kind, "worktree-conflict");
  assert.ok(!summary.title.includes(WORKTREE_PATH));
  assert.equal(summary.safeResume, false);
  assert.equal(summary.details.reason, reason);
  assert.equal(summary.details.question, question);
  assert.deepEqual(summary.details.commands, [
    "git worktree list",
    `git worktree remove --force ${WORKTREE_PATH}`,
  ]);
  assert.deepEqual(
    summary.displayOptions.map((o) => o.choice),
    ["resume", "close"]
  );
});

test("non-policy actions pass through with their own question and options", () => {
  const summary = summarizeHumanAction(
    baseAction({
      actionType: "final_review",
      reason: "Reviewer approved the PR",
      question: "Merge this work, send it back for another repair round, or close it?",
      responseOptionsJson: JSON.stringify([
        { choice: "merge", label: "Merge" },
        { choice: "repair", label: "Another repair round" },
        { choice: "close", label: "Close" },
      ]),
    })
  );
  assert.equal(summary.kind, "other");
  assert.equal(summary.title, "Merge this work, send it back for another repair round, or close it?");
  assert.equal(summary.safeResume, false);
  assert.deepEqual(
    summary.displayOptions.map((o) => o.label),
    ["Merge", "Another repair round", "Close"]
  );
  assert.equal(summary.primaryChoice, "merge");
});
