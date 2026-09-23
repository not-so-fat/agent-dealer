// NOT-251: Linear repository intake without a confirmation gate — one
// ordinary repository input, silent auto-fill from exactly one valid
// `repo:` label, preservation otherwise, ordinary required-field gating.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LinearCandidate } from "@agent-dealer/shared";
import { resolveLinearRepoWithMappings } from "@agent-dealer/shared";
import {
  canonicalRepoIdentity,
  canSubmitNewIssue,
  nextRepoForLinearCandidate,
  repoHintFor,
  repoLabelWarning,
} from "./linearRepoIntake.js";

const REPO = "github.com/not-so-fat/agent-dealer";

function candidate(over: Partial<LinearCandidate> = {}): LinearCandidate {
  return {
    id: "uuid-1",
    identifier: "NOT-251",
    title: "t",
    url: "https://linear.app/not-so-fat/issue/NOT-251/t",
    labels: ["repo:github.com/not-so-fat/agent-dealer"],
    ...over,
  };
}

test("canonicalRepoIdentity normalizes every accepted entry shape", () => {
  assert.equal(canonicalRepoIdentity("github.com/not-so-fat/agent-dealer"), REPO);
  assert.equal(
    canonicalRepoIdentity("https://github.com/not-so-fat/agent-dealer"),
    REPO
  );
  assert.equal(canonicalRepoIdentity("not-so-fat/agent-dealer"), REPO);
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
  assert.equal(fallback?.repository, REPO);
});

test("exactly one valid label auto-fills its normalized identity", () => {
  // Already-empty input gets the label value.
  assert.equal(nextRepoForLinearCandidate("", candidate()), REPO);
  // A stale value is intentionally replaced — the new ticket's label wins.
  assert.equal(
    nextRepoForLinearCandidate("github.com/not-so-fat/other", candidate()),
    REPO
  );
  // Short label form is normalized on the way in.
  assert.equal(
    nextRepoForLinearCandidate("", candidate({ labels: ["repo:not-so-fat/agent-dealer"] })),
    REPO
  );
  // Server resolution takes precedence over raw labels.
  assert.equal(
    nextRepoForLinearCandidate(
      "",
      candidate({
        labels: [],
        repoResolution: { status: "resolved", repository: "github.com/x/y", sourceLabel: "repo:github.com/x/y" },
      })
    ),
    "github.com/x/y"
  );
});

test("no usable label preserves the existing repository value", () => {
  const current = "github.com/not-so-fat/agent-dealer";
  assert.equal(nextRepoForLinearCandidate(current, candidate({ labels: [] })), current);
  assert.equal(
    nextRepoForLinearCandidate(current, candidate({ labels: ["backend", "agent-dealer"] })),
    current
  );
  // Empty input stays empty — the operator types or picks a recent repository.
  assert.equal(nextRepoForLinearCandidate("", candidate({ labels: [] })), "");
  // Null candidate (e.g. selection cleared) preserves too.
  assert.equal(nextRepoForLinearCandidate(current, null), current);
});

test("conflicting or invalid labels preserve the input and warn", () => {
  const current = "github.com/not-so-fat/agent-dealer";
  const conflict = candidate({ labels: ["repo:github.com/a/one", "repo:github.com/b/two"] });
  assert.equal(nextRepoForLinearCandidate(current, conflict), current);
  assert.equal(nextRepoForLinearCandidate("", conflict), "");
  const invalid = candidate({ labels: ["repo:https://gitlab.com/acme/app"] });
  assert.equal(nextRepoForLinearCandidate(current, invalid), current);

  const conflictWarning = repoLabelWarning("linear", conflict);
  assert.ok(conflictWarning?.includes("Conflicting"), "conflict warned");
  assert.ok(conflictWarning?.includes("repo:github.com/a/one"), "first label named");
  assert.ok(conflictWarning?.includes("repo:github.com/b/two"), "second label named");
  const invalidWarning = repoLabelWarning("linear", invalid);
  assert.ok(invalidWarning?.includes("Invalid repository label"), "invalid warned");
  assert.ok(invalidWarning?.includes("repo:https://gitlab.com/acme/app"), "bad label named");
});

test("resolved and no-label states render no warning", () => {
  assert.equal(repoLabelWarning("linear", candidate()), null);
  assert.equal(repoLabelWarning("linear", candidate({ labels: [] })), null);
  assert.equal(repoLabelWarning("manual", candidate()), null);
  assert.equal(repoLabelWarning("linear", null), null);
});

test("manual override is just the new input value — no follow-up step", () => {
  // Typing or picking a recent repository replaces the auto-filled value,
  // and the result is submittable without confirmation.
  const edited = "github.com/not-so-fat/other";
  assert.equal(
    canSubmitNewIssue({ title: "NOT-251: x", repo: edited, developerAgentId: "dev", reviewerAgentId: "rev" }),
    true
  );
  // Switching tickets afterwards with no usable label keeps the override.
  assert.equal(nextRepoForLinearCandidate(edited, candidate({ labels: [] })), edited);
  // Switching source mode never clears the repository (mode carries no repo).
  assert.equal(nextRepoForLinearCandidate(edited, null), edited);
});

// NOT-260: a server-resolved mapping prefills the normal Repository picker
// during list selection and direct lookup, and stays editable afterward.
function mappedCandidate(): LinearCandidate {
  const labels = ["agent-dealer"];
  return {
    id: "uuid-9",
    identifier: "NOT-260",
    title: "t",
    url: "https://linear.app/not-so-fat/issue/NOT-260/t",
    labels,
    repoResolution: resolveLinearRepoWithMappings(labels, [
      { label: "agent-dealer", repository: "github.com/not-so-fat/agent-dealer" },
    ]),
  };
}

test("a mapped Linear label prefills the normal Repository picker", () => {
  const c = mappedCandidate();
  assert.equal(c.repoResolution?.status, "resolved");
  assert.equal(nextRepoForLinearCandidate("", c), REPO);
  // A stale value is replaced — the mapped default wins on selection.
  assert.equal(nextRepoForLinearCandidate("github.com/not-so-fat/other", c), REPO);
  assert.equal(repoLabelWarning("linear", c), null);
});

test("after prefill, picking a recent repository or typing replaces the default", () => {
  const c = mappedCandidate();
  const prefilled = nextRepoForLinearCandidate("", c);
  assert.equal(prefilled, REPO);
  // Selecting a recent repository replaces the mapped default immediately.
  const picked = "github.com/not-so-fat/other";
  assert.equal(
    canSubmitNewIssue({ title: "NOT-260: x", repo: picked, developerAgentId: "dev", reviewerAgentId: "rev" }),
    true,
    "picked recent repository is submittable"
  );
  // Typing a different repository replaces it too, and that value is submitted.
  const typed = "https://github.com/not-so-fat/typed";
  assert.equal(canonicalRepoIdentity(typed), "github.com/not-so-fat/typed");
  assert.equal(
    canSubmitNewIssue({ title: "NOT-260: x", repo: typed, developerAgentId: "dev", reviewerAgentId: "rev" }),
    true,
    "typed repository is submittable"
  );
});

test("unmapped and ambiguous mapped candidates preserve the current value", () => {
  const current = "github.com/not-so-fat/agent-dealer";
  const mappings = [
    { label: "agent-dealer", repository: "github.com/not-so-fat/agent-dealer" },
    { label: "dealer", repository: "github.com/not-so-fat/other" },
  ];
  const labels = ["agent-dealer", "dealer"];
  const ambiguous: LinearCandidate = {
    id: "uuid-9",
    identifier: "NOT-260",
    title: "t",
    url: "https://linear.app/not-so-fat/issue/NOT-260/t",
    labels,
    repoResolution: resolveLinearRepoWithMappings(labels, mappings),
  };
  assert.equal(ambiguous.repoResolution?.status, "conflict");
  assert.equal(nextRepoForLinearCandidate(current, ambiguous), current);
  assert.ok(repoLabelWarning("linear", ambiguous)?.includes("Conflicting"));
  // No configured match keeps the repo: fallback behavior unchanged.
  const fallback: LinearCandidate = {
    ...ambiguous,
    labels: ["repo:github.com/a/one"],
    repoResolution: resolveLinearRepoWithMappings(["repo:github.com/a/one"], mappings),
  };
  assert.equal(nextRepoForLinearCandidate("", fallback), "github.com/a/one");
});

test("submit needs title, a valid repository, developer, and reviewer", () => {
  const base = { title: "NOT-251: x", repo: REPO, developerAgentId: "dev", reviewerAgentId: "rev" };
  assert.equal(canSubmitNewIssue(base), true);
  // Manual URL and short forms validate through the same parser.
  assert.equal(canSubmitNewIssue({ ...base, repo: "https://github.com/not-so-fat/agent-dealer" }), true);
  assert.equal(canSubmitNewIssue({ ...base, repo: "other/repo" }), true);
  // Empty or invalid repository blocks submission.
  assert.equal(canSubmitNewIssue({ ...base, repo: "" }), false);
  assert.equal(canSubmitNewIssue({ ...base, repo: "   " }), false);
  assert.equal(canSubmitNewIssue({ ...base, repo: "not a repo!!" }), false);
  assert.equal(canSubmitNewIssue({ ...base, title: " " }), false);
  assert.equal(canSubmitNewIssue({ ...base, developerAgentId: "" }), false);
  assert.equal(canSubmitNewIssue({ ...base, reviewerAgentId: "" }), false);
});
