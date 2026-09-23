// NOT-242: explicit `repo:` label resolution over Linear candidate labels.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LinearCandidate } from "./index.js";
import {
  LinearRepoResolution,
  extractRepoLabels,
  normalizeMappingLabel,
  normalizeRepositoryMappings,
  resolveLinearRepoLabels,
  resolveLinearRepoWithMappings,
} from "./linear-intake.js";

test("one valid repo: label resolves to the canonical identity", () => {
  const r = resolveLinearRepoLabels(["agent-dealer", "repo:github.com/not-so-fat/agent-dealer"]);
  assert.equal(r.status, "resolved");
  assert.equal(r.repository, "github.com/not-so-fat/agent-dealer");
  assert.equal(r.sourceLabel, "repo:github.com/not-so-fat/agent-dealer");
  assert.deepEqual(r.labels, ["repo:github.com/not-so-fat/agent-dealer"]);
});

test("no repo: label leaves the repository unresolved with no default", () => {
  const r = resolveLinearRepoLabels(["agent-dealer", "backend"]);
  assert.equal(r.status, "unresolved");
  assert.equal(r.repository, undefined);
  // Ordinary product labels must never resolve — even one naming the repo.
  assert.equal(resolveLinearRepoLabels(["agent-dealer"]).status, "unresolved");
  assert.equal(resolveLinearRepoLabels([]).status, "unresolved");
  assert.equal(resolveLinearRepoLabels(undefined).status, "unresolved");
});

test("multiple repo: labels conflict and list every label", () => {
  const r = resolveLinearRepoLabels([
    "repo:github.com/not-so-fat/agent-dealer",
    "repo:github.com/not-so-fat/other",
  ]);
  assert.equal(r.status, "conflict");
  assert.equal(r.repository, undefined);
  assert.deepEqual(r.labels, [
    "repo:github.com/not-so-fat/agent-dealer",
    "repo:github.com/not-so-fat/other",
  ]);
});

test("invalid repo: value surfaces the label and the parser reason", () => {
  const r = resolveLinearRepoLabels(["repo:not-a-repo!!"]);
  assert.equal(r.status, "invalid");
  assert.equal(r.repository, undefined);
  assert.deepEqual(r.labels, ["repo:not-a-repo!!"]);
  assert.ok(r.error && r.error.length > 0);
});

test("non-GitHub host is invalid, never normalized", () => {
  const r = resolveLinearRepoLabels(["repo:https://gitlab.com/acme/app"]);
  assert.equal(r.status, "invalid");
  assert.deepEqual(r.labels, ["repo:https://gitlab.com/acme/app"]);
});

test("prefix match is case-insensitive; value uses the shared parser contract", () => {
  const upper = resolveLinearRepoLabels(["REPO:github.com/not-so-fat/agent-dealer"]);
  assert.equal(upper.status, "resolved");
  assert.equal(upper.repository, "github.com/not-so-fat/agent-dealer");
  assert.equal(upper.sourceLabel, "REPO:github.com/not-so-fat/agent-dealer");
  // owner/repo shorthand normalizes through the same parser as manual entry.
  const short = resolveLinearRepoLabels(["repo:not-so-fat/agent-dealer"]);
  assert.equal(short.status, "resolved");
  assert.equal(short.repository, "github.com/not-so-fat/agent-dealer");
});

test("extractRepoLabels ignores ordinary labels", () => {
  assert.deepEqual(extractRepoLabels(["repo:a/b", "repository", "my-repo:x"]), ["repo:a/b"]);
});

test("LinearCandidate keeps raw labels and accepts the resolved hint", () => {
  const c = LinearCandidate.parse({
    id: "uuid-1",
    identifier: "NOT-242",
    title: "t",
    url: "https://linear.app/x/issue/NOT-242/t",
    labels: ["repo:github.com/not-so-fat/agent-dealer"],
    repoResolution: resolveLinearRepoLabels(["repo:github.com/not-so-fat/agent-dealer"]),
  });
  assert.deepEqual(c.labels, ["repo:github.com/not-so-fat/agent-dealer"]);
  assert.equal(c.repoResolution?.status, "resolved");
  assert.equal(c.repoResolution?.repository, "github.com/not-so-fat/agent-dealer");
  // Hint is optional — older readers and hand-built candidates still parse.
  const bare = LinearCandidate.parse({
    id: "uuid-1",
    identifier: "NOT-242",
    title: "t",
    url: "https://linear.app/x/issue/NOT-242/t",
  });
  assert.equal(bare.repoResolution, undefined);
});

test("mapping labels are unique after trim + lowercase normalization", () => {
  assert.equal(normalizeMappingLabel("  Agent-Dealer "), "agent-dealer");
  assert.throws(
    () =>
      normalizeRepositoryMappings({
        mappings: [
          { label: "agent-dealer", repository: "not-so-fat/agent-dealer" },
          { label: "  AGENT-DEALER ", repository: "not-so-fat/other" },
        ],
      }),
    /Duplicate repository mapping/
  );
  // Different labels may point at the same repository.
  const same = normalizeRepositoryMappings({
    mappings: [
      { label: "agent-dealer", repository: "not-so-fat/agent-dealer" },
      { label: "dealer", repository: "not-so-fat/agent-dealer" },
    ],
  });
  assert.equal(same.length, 2);
});

test("mapping normalization trims labels and canonicalizes repositories", () => {
  const [row] = normalizeRepositoryMappings({
    mappings: [{ label: "  agent-dealer ", repository: "not-so-fat/agent-dealer" }],
  })!;
  assert.equal(row!.label, "agent-dealer");
  assert.equal(row!.repository, "github.com/not-so-fat/agent-dealer");
  // Full URL and .git forms land on the same identity.
  const [url] = normalizeRepositoryMappings({
    mappings: [{ label: "x", repository: "https://github.com/not-so-fat/agent-dealer.git" }],
  })!;
  assert.equal(url!.repository, "github.com/not-so-fat/agent-dealer");
});

test("mapping validation rejects empty labels, bad repos, and 101 rows", () => {
  assert.throws(() => normalizeRepositoryMappings({ mappings: [{ label: "  ", repository: "a/b" }] }), /must not be empty/);
  assert.throws(() => normalizeRepositoryMappings({ mappings: [{ label: "x".repeat(101), repository: "a/b" }] }), /1–100/);
  assert.throws(
    () => normalizeRepositoryMappings({ mappings: [{ label: "ok", repository: "not a repo!!" }] }),
    /Invalid repository/
  );
  const many = Array.from({ length: 101 }, (_, i) => ({ label: `l${i}`, repository: "a/b" }));
  assert.throws(() => normalizeRepositoryMappings({ mappings: many }), /At most 100/);
  // Exactly 100 rows pass.
  const hundred = Array.from({ length: 100 }, (_, i) => ({ label: `l${i}`, repository: "a/b" }));
  assert.equal(normalizeRepositoryMappings({ mappings: hundred }).length, 100);
});

test("a mapped label resolves with the matched Linear label as sourceLabel", () => {
  const r = resolveLinearRepoWithMappings(["backend", "Agent-Dealer"], [
    { label: "agent-dealer", repository: "github.com/not-so-fat/agent-dealer" },
  ]);
  assert.equal(r.status, "resolved");
  assert.equal(r.repository, "github.com/not-so-fat/agent-dealer");
  assert.equal(r.sourceLabel, "Agent-Dealer");
});

test("multiple matched labels on the same repository resolve", () => {
  const r = resolveLinearRepoWithMappings(["agent-dealer", "dealer"], [
    { label: "agent-dealer", repository: "github.com/not-so-fat/agent-dealer" },
    { label: "dealer", repository: "github.com/not-so-fat/agent-dealer" },
  ]);
  assert.equal(r.status, "resolved");
  assert.equal(r.repository, "github.com/not-so-fat/agent-dealer");
});

test("multiple matched labels on different repositories conflict — never first", () => {
  const r = resolveLinearRepoWithMappings(["agent-dealer", "dealer"], [
    { label: "agent-dealer", repository: "github.com/not-so-fat/agent-dealer" },
    { label: "dealer", repository: "github.com/not-so-fat/other" },
  ]);
  assert.equal(r.status, "conflict");
  assert.equal(r.repository, undefined);
  assert.deepEqual(r.labels, ["agent-dealer", "dealer"]);
});

test("no configured match falls back to the legacy repo: resolver", () => {
  const mappings = [{ label: "agent-dealer", repository: "github.com/not-so-fat/agent-dealer" }];
  const legacy = resolveLinearRepoWithMappings(["repo:github.com/a/one"], mappings);
  assert.equal(legacy.status, "resolved");
  assert.equal(legacy.repository, "github.com/a/one");
  assert.equal(legacy.sourceLabel, "repo:github.com/a/one");
  const none = resolveLinearRepoWithMappings(["backend"], mappings);
  assert.equal(none.status, "unresolved");
  const bare = resolveLinearRepoWithMappings(["backend"], []);
  assert.equal(bare.status, "unresolved");
  // Mapping wins over a repo: label when both are present.
  const both = resolveLinearRepoWithMappings(["agent-dealer", "repo:github.com/a/one"], mappings);
  assert.equal(both.status, "resolved");
  assert.equal(both.repository, "github.com/not-so-fat/agent-dealer");
});

test("LinearRepoResolution schema round-trips every state", () => {
  for (const status of ["resolved", "unresolved", "conflict", "invalid"] as const) {
    const parsed = LinearRepoResolution.parse({ status });
    assert.equal(parsed.status, status);
  }
});
