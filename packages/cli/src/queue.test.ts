import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQueueArgs, runQueueCommand } from "./queue.js";
import { stubFetch } from "./test-fetch-stub.js";

test("parseQueueArgs: add/remove require an issue id", () => {
  assert.deepEqual(parseQueueArgs(["add", "issue-1"]), { subcommand: "add", issueId: "issue-1" });
  assert.deepEqual(parseQueueArgs(["remove", "issue-1"]), {
    subcommand: "remove",
    issueId: "issue-1",
  });
  assert.throws(() => parseQueueArgs(["add"]));
  assert.throws(() => parseQueueArgs(["remove"]));
});

test("parseQueueArgs: list has no args", () => {
  assert.deepEqual(parseQueueArgs(["list"]), { subcommand: "list" });
});

test("queue list calls GET /api/queue", async () => {
  const stub = stubFetch("/api/queue", "GET", []);
  try {
    assert.equal(await runQueueCommand(["list"]), 0);
    stub.assertCalled();
  } finally {
    stub.restore();
  }
});

test("queue add calls POST /api/queue", async () => {
  const stub = stubFetch("/api/queue", "POST", { issueId: "issue-1", state: "queued" });
  try {
    assert.equal(await runQueueCommand(["add", "issue-1"]), 0);
    stub.assertCalled();
  } finally {
    stub.restore();
  }
});

test("queue remove calls DELETE /api/queue/:id", async () => {
  const stub = stubFetch(/\/api\/queue\/issue-1$/, "DELETE", { issueId: "issue-1", state: "removed" });
  try {
    assert.equal(await runQueueCommand(["remove", "issue-1"]), 0);
    stub.assertCalled();
  } finally {
    stub.restore();
  }
});

test("parseQueueArgs: move requires exactly one destination flag", () => {
  assert.deepEqual(parseQueueArgs(["move", "issue-1", "--top"]), {
    subcommand: "move",
    issueId: "issue-1",
    to: "top",
  });
  assert.deepEqual(parseQueueArgs(["move", "issue-1", "--bottom"]), {
    subcommand: "move",
    issueId: "issue-1",
    to: "bottom",
  });
  assert.deepEqual(parseQueueArgs(["move", "issue-1", "--before", "issue-2"]), {
    subcommand: "move",
    issueId: "issue-1",
    to: { before: "issue-2" },
  });
  assert.deepEqual(parseQueueArgs(["move", "issue-1", "--after", "issue-2"]), {
    subcommand: "move",
    issueId: "issue-1",
    to: { after: "issue-2" },
  });
  assert.throws(() => parseQueueArgs(["move", "issue-1"]));
  assert.throws(() => parseQueueArgs(["move", "issue-1", "--top", "--bottom"]));
  assert.throws(() => parseQueueArgs(["move", "issue-1", "--before"]));
});

test("queue move calls POST /api/queue/:id/move", async () => {
  const stub = stubFetch(/\/api\/queue\/issue-1\/move$/, "POST", {
    issueId: "issue-1",
    position: 1,
    state: "queued",
  });
  try {
    assert.equal(await runQueueCommand(["move", "issue-1", "--top"]), 0);
    assert.deepEqual(stub.assertCalled(), { to: "top" });
  } finally {
    stub.restore();
  }
});
