// packages/server/src/adapters/github.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrView, summarizeChecks, pollPrChecks, type GithubAdapter, type ChecksSnapshot } from "./github.js";

test("parsePrView extracts the ground-truth handoff fields, including draft status", () => {
  const view = parsePrView(
    JSON.stringify({
      number: 7,
      url: "https://github.com/o/r/pull/7",
      baseRefName: "main",
      headRefName: "issue-1",
      headRefOid: "abc123",
      isDraft: true,
    })
  );
  assert.deepEqual(view, {
    number: 7,
    url: "https://github.com/o/r/pull/7",
    baseRefName: "main",
    headRefName: "issue-1",
    headRefOid: "abc123",
    isDraft: true,
  });
});

test("summarizeChecks: empty rollup is none, any failure wins over pending, pending beats success", () => {
  assert.equal(summarizeChecks([]), "none");
  assert.equal(summarizeChecks([{ state: "success" }, { state: "success" }]), "success");
  assert.equal(summarizeChecks([{ state: "success" }, { status: "in_progress" }]), "pending");
  assert.equal(summarizeChecks([{ conclusion: "failure" }, { status: "in_progress" }]), "failure");
  assert.equal(summarizeChecks([{ conclusion: "cancelled" }]), "failure");
});

test("summarizeChecks accepts neutral/skipped as success but fails closed on an unrecognized conclusion", () => {
  assert.equal(summarizeChecks([{ conclusion: "neutral" }, { conclusion: "skipped" }]), "success");
  assert.equal(summarizeChecks([{ conclusion: "some_new_gh_conclusion_this_code_does_not_know" }]), "failure");
});

function fakeAdapter(sequence: ChecksSnapshot[]): GithubAdapter {
  const queue = [...sequence];
  let last: ChecksSnapshot = "pending";
  return {
    viewPr: async () => null,
    createDraftPr: async () => ({ ok: false, reason: "unused", noCommits: false }),
    checksSnapshot: async () => {
      if (queue.length) last = queue.shift()!;
      return last;
    },
    publishReview: async () => ({ ok: false, reason: "unused" }),
  };
}

test("pollPrChecks returns immediately on success/failure without polling again", async () => {
  assert.equal(await pollPrChecks(fakeAdapter(["success"]), { cwd: "/x", timeoutMs: 1000, intervalMs: 5 }), "success");
  assert.equal(await pollPrChecks(fakeAdapter(["failure"]), { cwd: "/x", timeoutMs: 1000, intervalMs: 5 }), "failure");
});

test("pollPrChecks requires none to be read twice in a row before concluding no checks are configured", async () => {
  // A single "none" read (Actions hasn't created its check runs yet) must NOT resolve.
  const result = await pollPrChecks(fakeAdapter(["none", "pending", "none", "none"]), {
    cwd: "/x",
    timeoutMs: 1000,
    intervalMs: 5,
  });
  assert.equal(result, "none");
});

test("pollPrChecks fails closed as timeout if the none-streak never completes in time", async () => {
  // timeoutMs: 0 — the deadline is already passed after the very first read, before a
  // second "none" can confirm the streak, so this must NOT resolve as "none".
  const result = await pollPrChecks(fakeAdapter(["none"]), { cwd: "/x", timeoutMs: 0, intervalMs: 10 });
  assert.equal(result, "timeout");
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
