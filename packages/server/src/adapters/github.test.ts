// packages/server/src/adapters/github.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrView, summarizeChecks, pollPrChecks, type GithubAdapter, type ChecksSnapshot } from "./github.js";

test("parsePrView extracts the ground-truth handoff fields", () => {
  const view = parsePrView(
    JSON.stringify({
      number: 7,
      url: "https://github.com/o/r/pull/7",
      baseRefName: "main",
      headRefName: "issue-1",
      headRefOid: "abc123",
    })
  );
  assert.deepEqual(view, {
    number: 7,
    url: "https://github.com/o/r/pull/7",
    baseRefName: "main",
    headRefName: "issue-1",
    headRefOid: "abc123",
  });
});

test("summarizeChecks: empty rollup is none, any failure wins over pending, pending beats success", () => {
  assert.equal(summarizeChecks([]), "none");
  assert.equal(summarizeChecks([{ state: "success" }, { state: "success" }]), "success");
  assert.equal(summarizeChecks([{ state: "success" }, { status: "in_progress" }]), "pending");
  assert.equal(summarizeChecks([{ conclusion: "failure" }, { status: "in_progress" }]), "failure");
  assert.equal(summarizeChecks([{ conclusion: "cancelled" }]), "failure");
});

function fakeAdapter(sequence: ChecksSnapshot[]): GithubAdapter {
  const queue = [...sequence];
  return {
    viewPr: async () => null,
    createDraftPr: async () => ({ ok: false, reason: "unused", noCommits: false }),
    checksSnapshot: async () => queue.shift() ?? queue[queue.length - 1] ?? "pending",
  };
}

test("pollPrChecks returns immediately on success/none/failure without polling again", async () => {
  assert.equal(await pollPrChecks(fakeAdapter(["success"]), { cwd: "/x", timeoutMs: 1000, intervalMs: 5 }), "success");
  assert.equal(await pollPrChecks(fakeAdapter(["none"]), { cwd: "/x", timeoutMs: 1000, intervalMs: 5 }), "none");
  assert.equal(await pollPrChecks(fakeAdapter(["failure"]), { cwd: "/x", timeoutMs: 1000, intervalMs: 5 }), "failure");
});

test("pollPrChecks keeps polling through pending until a terminal state resolves", async () => {
  const result = await pollPrChecks(fakeAdapter(["pending", "pending", "success"]), {
    cwd: "/x",
    timeoutMs: 1000,
    intervalMs: 5,
  });
  assert.equal(result, "success");
});

test("pollPrChecks gives up as timeout when checks stay pending past the deadline", async () => {
  const result = await pollPrChecks(fakeAdapter(["pending", "pending", "pending", "pending"]), {
    cwd: "/x",
    timeoutMs: 20,
    intervalMs: 10,
  });
  assert.equal(result, "timeout");
});

test("pollPrChecks bails out as timeout immediately when the lease signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await pollPrChecks(fakeAdapter(["pending"]), {
    cwd: "/x",
    timeoutMs: 1000,
    intervalMs: 5,
    signal: controller.signal,
  });
  assert.equal(result, "timeout");
});
