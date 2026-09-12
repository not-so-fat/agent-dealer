import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIssueArgs, runIssueCommand } from "./issue.js";
import { stubFetch } from "./test-fetch-stub.js";

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

test("parseIssueArgs: list accepts an optional --status", () => {
  assert.deepEqual(parseIssueArgs(["list"]), { subcommand: "list", status: undefined });
  assert.deepEqual(parseIssueArgs(["list", "--status", "ready,needs_human"]), {
    subcommand: "list",
    status: "ready,needs_human",
  });
});

test("parseIssueArgs: start requires an id", () => {
  const parsed = parseIssueArgs(["start", "issue-123"]);
  assert.equal(parsed.subcommand, "start");
  assert.equal((parsed as { id: string }).id, "issue-123");
  assert.throws(() => parseIssueArgs(["start"]));
});

test("issue list calls GET /api/issues and exits 0", async () => {
  const stub = stubFetch("/api/issues", "GET", [{ id: "i1", status: "ready" }]);
  try {
    const code = await runIssueCommand(["list"]);
    assert.equal(code, 0);
    stub.assertCalled();
  } finally {
    stub.restore();
  }
});

test("issue list forwards --status as a query param", async () => {
  const stub = stubFetch(/\/api\/issues\?status=ready%2Cneeds_human$/, "GET", []);
  try {
    await runIssueCommand(["list", "--status", "ready,needs_human"]);
    stub.assertCalled();
  } finally {
    stub.restore();
  }
});

test("issue start calls POST /api/issues/:id/start and exits 0", async () => {
  const stub = stubFetch("/api/issues/issue-123/start", "POST", { instance: {}, workItem: {} });
  try {
    const code = await runIssueCommand(["start", "issue-123"]);
    assert.equal(code, 0);
    stub.assertCalled();
  } finally {
    stub.restore();
  }
});

test("issue start returns nonzero on API failure", async () => {
  const stub = stubFetch("/api/issues/issue-123/start", "POST", { error: "not ready" }, 400);
  try {
    const code = await runIssueCommand(["start", "issue-123"]);
    assert.equal(code, 1);
  } finally {
    stub.restore();
  }
});
