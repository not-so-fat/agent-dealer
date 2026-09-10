import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIssueArgs } from "./issue.js";

test("parseIssueArgs: create requires --title and --repo", () => {
  const parsed = parseIssueArgs(["create", "--title", "Fix bug", "--repo", "/repo", "--developer-agent", "a1", "--reviewer-agent", "a2"]);
  assert.equal(parsed.subcommand, "create");
  assert.equal((parsed as { title: string }).title, "Fix bug");
});

test("parseIssueArgs: show requires an id", () => {
  const parsed = parseIssueArgs(["show", "issue-123"]);
  assert.equal(parsed.subcommand, "show");
  assert.equal((parsed as { id: string }).id, "issue-123");
});

test("parseIssueArgs: unknown subcommand throws", () => {
  assert.throws(() => parseIssueArgs(["bogus"]));
});

test("parseIssueArgs: guide requires an id and --message", () => {
  const parsed = parseIssueArgs(["guide", "issue-123", "--message", "prioritize this"]);
  assert.equal(parsed.subcommand, "guide");
  assert.equal((parsed as { id: string; message: string }).message, "prioritize this");
});
