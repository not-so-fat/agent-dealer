import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIssueFilter, parseLinearIssueRef } from "./linear-inbox.js";

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
      defaultAgentId: null,
      syncEnabled: true,
      routingRules: [],
    },
    "viewer-1"
  );
  assert.deepEqual(filter, {
    state: { name: { in: ["Backlog", "Todo", "In Progress", "In Review"] } },
    team: { id: { eq: "team-1" } },
  });
});

test("buildIssueFilter includes assignee when assigneeMe is true", () => {
  const filter = buildIssueFilter(
    {
      stateFilter: ["Todo"],
      teamId: null,
      assigneeMe: true,
      defaultAgentId: null,
      syncEnabled: true,
      routingRules: [],
    },
    "viewer-1"
  );
  assert.deepEqual(filter, {
    state: { name: { in: ["Todo"] } },
    assignee: { id: { eq: "viewer-1" } },
  });
});
