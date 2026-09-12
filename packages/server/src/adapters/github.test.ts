// packages/server/src/adapters/github.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePrView,
  summarizeChecks,
  pollPrChecks,
  createGithubAdapter,
  PR_VIEW_FIELDS,
  type GithubAdapter,
  type ChecksSnapshot,
  type GhExec,
} from "./github.js";

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

/** Records every `gh` invocation and returns responses off a queue — never calls real `gh`. */
function queuedExec(responses: Array<{ stdout?: string; error?: string }>): { exec: GhExec; calls: string[][] } {
  const calls: string[][] = [];
  const queue = [...responses];
  const exec: GhExec = async (args) => {
    calls.push(args);
    const next = queue.shift() ?? { stdout: "" };
    if (next.error != null) throw Object.assign(new Error(next.error), { stderr: next.error });
    return { stdout: next.stdout ?? "" };
  };
  return { exec, calls };
}

test("viewPr looks up the PR explicitly by branch, never a bare `gh pr view`", async () => {
  const { exec, calls } = queuedExec([
    { stdout: JSON.stringify({ number: 5, url: "u", baseRefName: "main", headRefName: "issue-x", headRefOid: "abc", isDraft: true }) },
  ]);
  const view = await createGithubAdapter(exec).viewPr({ cwd: "/repo", branch: "issue-x" });
  assert.deepEqual(calls[0], ["pr", "view", "issue-x", "--json", PR_VIEW_FIELDS]);
  assert.equal(view?.number, 5);
});

test("viewPr prefers an explicit PR number over branch when both are given", async () => {
  const { exec, calls } = queuedExec([
    { stdout: JSON.stringify({ number: 5, url: "u", baseRefName: "main", headRefName: "issue-x", headRefOid: "abc", isDraft: true }) },
  ]);
  await createGithubAdapter(exec).viewPr({ cwd: "/repo", number: 5, branch: "issue-x" });
  assert.deepEqual(calls[0], ["pr", "view", "5", "--json", PR_VIEW_FIELDS]);
});

test("createDraftPr passes --head explicitly and re-verifies by that same branch, not a bare `gh pr view`", async () => {
  const { exec, calls } = queuedExec([
    { stdout: "https://github.com/o/r/pull/9\n" },
    { stdout: JSON.stringify({ number: 9, url: "https://github.com/o/r/pull/9" }) },
  ]);
  const result = await createGithubAdapter(exec).createDraftPr({
    cwd: "/repo",
    base: "main",
    head: "issue-x",
    title: "Add widget",
    bodyFilePath: "/tmp/body.md",
  });
  assert.deepEqual(calls[0], ["pr", "create", "--draft", "--base", "main", "--head", "issue-x", "--title", "Add widget", "--body-file", "/tmp/body.md"]);
  assert.deepEqual(calls[1], ["pr", "view", "issue-x", "--json", "number,url"]);
  assert.deepEqual(result, { ok: true, number: 9, url: "https://github.com/o/r/pull/9" });
});

// NOT-82 dogfood repro: a real Dev-review run pushed its generated branch to origin, but
// the local worktree had no configured upstream — `gh pr create` (bare, no `--head`)
// refused with exactly this error, and the coordinator must never hit it.
const NO_UPSTREAM_ERROR = "aborted: you must first push the current branch to a remote, or use the --head flag";

test("createDraftPr: a branch pushed to origin with no local upstream still opens a draft PR when --head is explicit", async () => {
  const exec: GhExec = async (args) => {
    if (args[0] === "pr" && args[1] === "create") {
      if (!args.includes("--head")) throw Object.assign(new Error(NO_UPSTREAM_ERROR), { stderr: NO_UPSTREAM_ERROR });
      return { stdout: "https://github.com/o/r/pull/42\n" };
    }
    if (args[0] === "pr" && args[1] === "view" && args[2] === "issue-4e5eb611") {
      return { stdout: JSON.stringify({ number: 42, url: "https://github.com/o/r/pull/42" }) };
    }
    throw new Error(`unexpected gh invocation: ${args.join(" ")}`);
  };
  const result = await createGithubAdapter(exec).createDraftPr({
    cwd: "/repo",
    base: "main",
    head: "issue-4e5eb611",
    title: "Complete CLI surface",
    bodyFilePath: "/tmp/body.md",
  });
  assert.deepEqual(result, { ok: true, number: 42, url: "https://github.com/o/r/pull/42" });
});

test("viewPr: a retry can find the already-created PR by explicit branch even with no local upstream", async () => {
  const exec: GhExec = async (args) => {
    // Bare `gh pr view` (no selector) can't resolve the current branch without upstream
    // tracking — simulates the real failure mode this adapter must never hit.
    if (args[1] === "view" && args[2] === "--json") {
      throw Object.assign(new Error(), { stderr: 'no pull requests found for branch "HEAD"' });
    }
    return { stdout: JSON.stringify({ number: 42, url: "u", baseRefName: "main", headRefName: args[2], headRefOid: "abc", isDraft: true }) };
  };
  const view = await createGithubAdapter(exec).viewPr({ cwd: "/repo", branch: "issue-4e5eb611" });
  assert.equal(view?.number, 42);
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
