import { test } from "node:test";
import assert from "node:assert/strict";
import { runActionCommand } from "./action.js";
import { stubFetch } from "./test-fetch-stub.js";

test("action list calls GET /api/human-actions and surfaces parsed choices", async () => {
  const stub = stubFetch("/api/human-actions", "GET", [
    {
      id: "a1",
      issueId: "i1",
      workflowInstanceId: null,
      actionType: "final_review",
      reason: "done",
      question: "Accept?",
      evidenceJson: null,
      responseOptionsJson: JSON.stringify([{ choice: "complete", label: "Accept — mark done" }]),
      continuationPreviewJson: null,
      status: "open",
      resolutionJson: null,
      resolvedBy: null,
      requestedAt: "2026-01-01T00:00:00.000Z",
      resolvedAt: null,
    },
  ]);
  const originalLog = console.log;
  let printed = "";
  console.log = (msg: string) => {
    printed = msg;
  };
  try {
    const code = await runActionCommand(["list"]);
    assert.equal(code, 0);
    stub.assertCalled();
    const [action] = JSON.parse(printed);
    assert.deepEqual(action.choices, [{ choice: "complete", label: "Accept — mark done" }]);
  } finally {
    console.log = originalLog;
    stub.restore();
  }
});

test("action resolve requires an id, --choice, and --by", async () => {
  const code = await runActionCommand(["resolve", "a1", "--choice", "complete"]);
  assert.equal(code, 1);
});

test("action resolve calls POST /api/human-actions/:id/resolve with resolvedBy and choice", async () => {
  const stub = stubFetch("/api/human-actions/a1/resolve", "POST", { issueStatus: "closed" });
  try {
    const code = await runActionCommand(["resolve", "a1", "--choice", "complete", "--by", "alice"]);
    assert.equal(code, 0);
    const body = stub.assertCalled();
    assert.deepEqual(body, { choice: "complete", resolvedBy: "alice" });
  } finally {
    stub.restore();
  }
});

test("action resolve returns nonzero on API failure", async () => {
  const stub = stubFetch("/api/human-actions/a1/resolve", "POST", { error: "bad choice" }, 400);
  try {
    const code = await runActionCommand(["resolve", "a1", "--choice", "bogus", "--by", "alice"]);
    assert.equal(code, 1);
  } finally {
    stub.restore();
  }
});

test("unknown action subcommand returns nonzero", async () => {
  const code = await runActionCommand(["bogus"]);
  assert.equal(code, 1);
});
