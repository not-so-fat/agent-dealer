import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIssueFilter, nodeToCandidate, parseLinearIssueRef } from "./linear-inbox.js";

test("parseLinearIssueRef accepts identifier, URL, and UUID", () => {
  assert.equal(parseLinearIssueRef("NOT-103"), "NOT-103");
  assert.equal(parseLinearIssueRef("  not-90  "), "NOT-90");
  assert.equal(
    parseLinearIssueRef("https://linear.app/not-so-fat/issue/NOT-103/sequential-issue-queue"),
    "NOT-103"
  );
  assert.equal(
    parseLinearIssueRef("7a2e7533-65f8-4752-a903-d419f47b2093"),
    "7a2e7533-65f8-4752-a903-d419f47b2093"
  );
  assert.equal(parseLinearIssueRef(""), null);
  assert.equal(parseLinearIssueRef("not a ticket"), null);
});

test("buildIssueFilter omits assignee when assigneeMe is false", () => {
  const filter = buildIssueFilter(
    {
      stateFilter: ["Backlog", "Todo", "In Progress", "In Review"],
      teamId: "team-1",
      assigneeMe: false,
      syncEnabled: true,
    },
    "viewer-1"
  );
  assert.deepEqual(filter, {
    state: { name: { in: ["Backlog", "Todo", "In Progress", "In Review"] } },
    team: { id: { eq: "team-1" } },
  });
});

test("nodeToCandidate resolves exactly one repo: label to the canonical identity", () => {
  const c = nodeToCandidate({
    id: "uuid-1",
    identifier: "NOT-242",
    title: "t",
    url: "https://linear.app/not-so-fat/issue/NOT-242/t",
    labels: { nodes: [{ name: "agent-dealer" }, { name: "repo:github.com/not-so-fat/agent-dealer" }] },
  });
  // Raw labels stay available alongside the resolved hint.
  assert.deepEqual(c.labels, ["agent-dealer", "repo:github.com/not-so-fat/agent-dealer"]);
  assert.equal(c.repoResolution?.status, "resolved");
  assert.equal(c.repoResolution?.repository, "github.com/not-so-fat/agent-dealer");
  assert.equal(c.repoResolution?.sourceLabel, "repo:github.com/not-so-fat/agent-dealer");
});

test("nodeToCandidate leaves zero repo: labels unresolved and conflicts several", () => {
  const none = nodeToCandidate({
    id: "uuid-1",
    identifier: "NOT-1",
    title: "t",
    url: "https://linear.app/x/issue/NOT-1/t",
    labels: { nodes: [{ name: "agent-dealer" }] },
  });
  assert.equal(none.repoResolution?.status, "unresolved");
  assert.equal(none.repoResolution?.repository, undefined);

  const conflict = nodeToCandidate({
    id: "uuid-2",
    identifier: "NOT-2",
    title: "t",
    url: "https://linear.app/x/issue/NOT-2/t",
    labels: { nodes: [{ name: "repo:github.com/a/one" }, { name: "repo:github.com/b/two" }] },
  });
  assert.equal(conflict.repoResolution?.status, "conflict");
  assert.equal(conflict.repoResolution?.repository, undefined);
  assert.deepEqual(conflict.repoResolution?.labels, ["repo:github.com/a/one", "repo:github.com/b/two"]);
});

test("nodeToCandidate marks a non-GitHub repo: value invalid", () => {
  const c = nodeToCandidate({
    id: "uuid-3",
    identifier: "NOT-3",
    title: "t",
    url: "https://linear.app/x/issue/NOT-3/t",
    labels: { nodes: [{ name: "repo:https://gitlab.com/acme/app" }] },
  });
  assert.equal(c.repoResolution?.status, "invalid");
  assert.equal(c.repoResolution?.repository, undefined);
  assert.deepEqual(c.repoResolution?.labels, ["repo:https://gitlab.com/acme/app"]);
  assert.ok(c.repoResolution?.error);
});

test("buildIssueFilter includes assignee when assigneeMe is true", () => {
  const filter = buildIssueFilter(
    {
      stateFilter: ["Todo"],
      teamId: null,
      assigneeMe: true,
      syncEnabled: true,
    },
    "viewer-1"
  );
  assert.deepEqual(filter, {
    state: { name: { in: ["Todo"] } },
    assignee: { id: { eq: "viewer-1" } },
  });
});
