// NOT-242: repository confirmation gating for the New issue form.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LinearCandidate } from "@agent-dealer/shared";
import {
  canonicalRepoIdentity,
  canSubmitNewIssue,
  isRepoConfirmed,
  repoHintFor,
} from "./linearRepoIntake.js";

function candidate(over: Partial<LinearCandidate> = {}): LinearCandidate {
  return {
    id: "uuid-1",
    identifier: "NOT-242",
    title: "t",
    url: "https://linear.app/not-so-fat/issue/NOT-242/t",
    labels: ["repo:github.com/not-so-fat/agent-dealer"],
    ...over,
  };
}

test("canonicalRepoIdentity normalizes every accepted entry shape", () => {
  assert.equal(canonicalRepoIdentity("github.com/not-so-fat/agent-dealer"), "github.com/not-so-fat/agent-dealer");
  assert.equal(
    canonicalRepoIdentity("https://github.com/not-so-fat/agent-dealer"),
    "github.com/not-so-fat/agent-dealer"
  );
  assert.equal(canonicalRepoIdentity("not-so-fat/agent-dealer"), "github.com/not-so-fat/agent-dealer");
  assert.equal(canonicalRepoIdentity(""), null);
  assert.equal(canonicalRepoIdentity("not a repo!!"), null);
});

test("repoHintFor prefers the server hint and recomputes when absent", () => {
  // Manual mode has no Linear provenance.
  assert.equal(repoHintFor("manual", candidate()), null);
  assert.equal(repoHintFor("linear", null), null);
  const server = repoHintFor("linear", candidate({
    repoResolution: { status: "resolved", repository: "github.com/x/y", sourceLabel: "repo:github.com/x/y" },
  }));
  assert.equal(server?.repository, "github.com/x/y");
  const fallback = repoHintFor("linear", candidate({ repoResolution: undefined }));
  assert.equal(fallback?.status, "resolved");
  assert.equal(fallback?.repository, "github.com/not-so-fat/agent-dealer");
});

test("confirmation only holds while it equals the current canonical identity", () => {
  const canonical = "github.com/not-so-fat/agent-dealer";
  assert.equal(isRepoConfirmed(canonical, canonical), true);
  // A manual URL override is accepted once its canonical identity is confirmed.
  assert.equal(isRepoConfirmed("https://github.com/not-so-fat/agent-dealer", canonical), true);
  // A stale confirmation never covers a different repository.
  assert.equal(isRepoConfirmed("github.com/not-so-fat/other", canonical), false);
  assert.equal(isRepoConfirmed(canonical, null), false);
  assert.equal(isRepoConfirmed("", null), false);
  assert.equal(isRepoConfirmed("garbage", "garbage"), false);
});

test("submit stays disabled until the exact repository is confirmed", () => {
  const base = {
    title: "NOT-242: x",
    repo: "github.com/not-so-fat/agent-dealer",
    developerAgentId: "dev",
    reviewerAgentId: "rev",
  };
  assert.equal(canSubmitNewIssue({ ...base, confirmedRepo: null }), false);
  assert.equal(
    canSubmitNewIssue({ ...base, confirmedRepo: "github.com/not-so-fat/agent-dealer" }),
    true
  );
  // Stale confirmation after a repository edit blocks submit.
  assert.equal(
    canSubmitNewIssue({ ...base, repo: "github.com/not-so-fat/other", confirmedRepo: "github.com/not-so-fat/agent-dealer" }),
    false
  );
  // Manual creation follows the same rule: override confirmed under its own identity.
  assert.equal(
    canSubmitNewIssue({ ...base, repo: "other/repo", confirmedRepo: "github.com/other/repo" }),
    true
  );
  assert.equal(canSubmitNewIssue({ ...base, title: " ", confirmedRepo: base.repo }), false);
  assert.equal(canSubmitNewIssue({ ...base, developerAgentId: "", confirmedRepo: base.repo }), false);
  assert.equal(canSubmitNewIssue({ ...base, reviewerAgentId: "", confirmedRepo: base.repo }), false);
});
