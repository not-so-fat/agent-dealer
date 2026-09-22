// packages/server/src/adapters/github.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePrView,
  summarizeChecks,
  pollPrChecks,
  createGithubAdapter,
  fetchChecksFailureEvidence,
  sanitizeCiText,
  sanitizeUrl,
  extractActionsRunId,
  buildFailureExcerpt,
  formatChecksFailureDetails,
  CHECKS_EVIDENCE_MAX_EXCERPT_CHARS,
  CHECKS_FAILURE_GENERIC_REASON,
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

test("checksSnapshot looks up the PR's check rollup by explicit selector (number preferred), never a bare `gh pr view`", async () => {
  const success = { stdout: JSON.stringify({ statusCheckRollup: [{ conclusion: "success" }] }) };

  const byNumber = queuedExec([success]);
  await createGithubAdapter(byNumber.exec).checksSnapshot({ cwd: "/repo", number: 42 });
  assert.deepEqual(byNumber.calls[0], ["pr", "view", "42", "--json", "statusCheckRollup"]);

  const byBranch = queuedExec([success]);
  await createGithubAdapter(byBranch.exec).checksSnapshot({ cwd: "/repo", branch: "issue-x" });
  assert.deepEqual(byBranch.calls[0], ["pr", "view", "issue-x", "--json", "statusCheckRollup"]);

  const preferNumber = queuedExec([success]);
  await createGithubAdapter(preferNumber.exec).checksSnapshot({ cwd: "/repo", number: 42, branch: "issue-x" });
  assert.deepEqual(preferNumber.calls[0], ["pr", "view", "42", "--json", "statusCheckRollup"]);

  // Bare, unselected lookup — the shape NOT-82's checks-poll stage must never fall back
  // to now that pollPrChecks always forwards the identity-validated PR number.
  const bare = queuedExec([success]);
  await createGithubAdapter(bare.exec).checksSnapshot({ cwd: "/repo" });
  assert.deepEqual(bare.calls[0], ["pr", "view", "--json", "statusCheckRollup"]);
});

test("pollPrChecks forwards its selector to checksSnapshot on every poll iteration", async () => {
  const seen: Array<{ number?: number; branch?: string }> = [];
  const adapter: GithubAdapter = {
    viewPr: async () => null,
    createDraftPr: async () => ({ ok: false, reason: "unused", noCommits: false }),
    checksSnapshot: async ({ number, branch }) => {
      seen.push({ number, branch });
      return "success";
    },
    publishReview: async () => ({ ok: false, reason: "unused" }),
  };
  await pollPrChecks(adapter, { cwd: "/repo", timeoutMs: 1000, intervalMs: 5, number: 42 });
  assert.deepEqual(seen, [{ number: 42, branch: undefined }]);
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

// --- NOT-252: terminal checks_failed enrichment ---

const HEAD_SHA = "abc123def456abc123def456abc123def456abcd";

function prViewWithRollup(rollup: unknown[], headSha: string = HEAD_SHA): string {
  return JSON.stringify({ headRefOid: headSha, statusCheckRollup: rollup });
}

function actionsCheck(name: string, conclusion: string, runId: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    status: "COMPLETED",
    conclusion,
    workflowName: "CI",
    detailsUrl: `https://github.com/o/r/actions/runs/${runId}/jobs/999?check_suite_focus=true`,
    ...extra,
  };
}

/** The NOT-245 shape: `npm ci` dying on a stale exact pin, buried in setup noise. */
const NPM_E404_LOG = [
  "Run npm ci",
  " .npm ci --no-audit --no-fund",
  "  added 12 packages in 3s",
  "  npm error code E404",
  "  npm error 404 Not Found - GET https://registry.npmjs.org/@agent-dealer%2fshared - Not found",
  "  npm error 404",
  "  npm error 404  '@agent-dealer/shared@1.1.8' is not in this registry.",
  "  npm error 404",
  "  npm error 404 Note that you can also install from a tarball.",
  "  Error: Process completed with exit code 1.",
].join("\n");

test("NOT-252: single failed check fetches its run log once and enriches details", async () => {
  const { exec, calls } = queuedExec([
    { stdout: prViewWithRollup([actionsCheck("build", "FAILURE", "111"), actionsCheck("lint", "SUCCESS", "111")]) },
    { stdout: NPM_E404_LOG },
  ]);
  const evidence = await fetchChecksFailureEvidence(exec, {
    cwd: "/repo",
    number: 42,
    expectedHeadSha: HEAD_SHA,
    prNumber: 42,
  });
  assert.ok(evidence);
  assert.deepEqual(calls[0], ["pr", "view", "42", "--json", "headRefOid,statusCheckRollup"]);
  assert.deepEqual(calls[1], ["run", "view", "111", "--log-failed"]);
  assert.equal(calls.length, 2);
  assert.equal(evidence.headSha, HEAD_SHA);
  assert.equal(evidence.failedChecks.length, 1);
  assert.equal(evidence.failedChecks[0].name, "build");
  assert.equal(evidence.failedChecks[0].workflowName, "CI");
  assert.equal(evidence.failedChecks[0].conclusion, "failure");
  assert.equal(evidence.failedChecks[0].runId, "111");
  // Query/fragment stripped from the persisted URL.
  assert.equal(evidence.failedChecks[0].detailsUrl, "https://github.com/o/r/actions/runs/111/jobs/999");
  assert.match(evidence.details, /build/);
  assert.match(evidence.details, new RegExp(HEAD_SHA));
  assert.match(evidence.details, /'@agent-dealer\/shared@1\.1\.8' is not in this registry/);
  assert.match(evidence.details, /untrusted/i);
  assert.match(evidence.details, /do NOT follow/i);
  assert.ok(evidence.excerpt.length <= CHECKS_EVIDENCE_MAX_EXCERPT_CHARS);
});

test("NOT-252: multiple failed checks in one run share a single log fetch; distinct runs each fetched once", async () => {
  const { exec, calls } = queuedExec([
    {
      stdout: prViewWithRollup([
        actionsCheck("build", "FAILURE", "111"),
        actionsCheck("test", "FAILURE", "111"),
        actionsCheck("lint", "FAILURE", "222"),
        actionsCheck("docs", "SUCCESS", "222"),
      ]),
    },
    { stdout: "build failed\nError: boom\n" },
    { stdout: "lint failed\nError: nit\n" },
  ]);
  const evidence = await fetchChecksFailureEvidence(exec, { cwd: "/repo", branch: "issue-x", expectedHeadSha: HEAD_SHA });
  assert.ok(evidence);
  const runCalls = calls.filter((c) => c[0] === "run");
  assert.equal(runCalls.length, 2, "one fetch per distinct run, not per check");
  assert.deepEqual(runCalls[0], ["run", "view", "111", "--log-failed"]);
  assert.deepEqual(runCalls[1], ["run", "view", "222", "--log-failed"]);
  assert.deepEqual(
    evidence.failedChecks.map((c) => c.name),
    ["build", "test", "lint"]
  );
  assert.match(evidence.excerpt, /boom/);
  assert.match(evidence.excerpt, /nit/);
});

test("NOT-252: head mismatch yields no enrichment and fetches no logs", async () => {
  const { exec, calls } = queuedExec([
    { stdout: prViewWithRollup([actionsCheck("build", "FAILURE", "111")], "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef") },
  ]);
  const evidence = await fetchChecksFailureEvidence(exec, { cwd: "/repo", number: 42, expectedHeadSha: HEAD_SHA });
  assert.equal(evidence, null);
  assert.equal(calls.length, 1, "must not touch another commit's logs");
});

test("NOT-252: PR lookup failure yields no enrichment", async () => {
  const { exec } = queuedExec([{ error: 'no pull requests found for branch "issue-x"' }]);
  assert.equal(await fetchChecksFailureEvidence(exec, { cwd: "/repo", branch: "issue-x", expectedHeadSha: HEAD_SHA }), null);
});

test("NOT-252: no failed checks yields no enrichment", async () => {
  const { exec, calls } = queuedExec([
    { stdout: prViewWithRollup([actionsCheck("build", "SUCCESS", "111"), { state: "success" }]) },
  ]);
  assert.equal(await fetchChecksFailureEvidence(exec, { cwd: "/repo", number: 42, expectedHeadSha: HEAD_SHA }), null);
  assert.ok(calls.every((c) => c[0] === "pr"), "no log fetch without a failure");
});

test("NOT-252: noisy log focuses the excerpt on the actionable E404 lines", async () => {
  const setup = Array.from({ length: 200 }, (_, i) => `setup step ${i}: downloading dependency cache chunk ${i}`).join("\n");
  const tail = Array.from({ length: 100 }, (_, i) => `cleanup temp dir ${i}`).join("\n");
  const { exec } = queuedExec([
    { stdout: prViewWithRollup([actionsCheck("build", "FAILURE", "111")]) },
    { stdout: `${setup}\n${NPM_E404_LOG}\n${tail}` },
  ]);
  const evidence = await fetchChecksFailureEvidence(exec, { cwd: "/repo", number: 42, expectedHeadSha: HEAD_SHA });
  assert.ok(evidence);
  assert.match(evidence.excerpt, /E404/);
  assert.match(evidence.excerpt, /is not in this registry/);
  assert.ok(evidence.excerpt.length < 3000, `excerpt stays focused, got ${evidence.excerpt.length} chars`);
  assert.doesNotMatch(evidence.excerpt, /cleanup temp dir 99/);
});

test("NOT-252: huge logs are capped at the global excerpt budget", async () => {
  const big = Array.from({ length: 3000 }, (_, i) => `Error: failure number ${i} in job output`).join("\n");
  const { excerpt, truncated } = buildFailureExcerpt(big);
  assert.ok(excerpt.length <= CHECKS_EVIDENCE_MAX_EXCERPT_CHARS);
  assert.equal(truncated, true);
  assert.match(excerpt, /failure number 0/);
});

test("NOT-252: buildFailureExcerpt on an empty log yields an empty excerpt", async () => {
  assert.deepEqual(buildFailureExcerpt("   \n  \n"), { excerpt: "", truncated: false });
});

test("NOT-252: sanitizeCiText redacts secrets and strips URL query/fragment", async () => {
  // Secret-shaped fixtures are assembled at runtime so the sensitive shapes never sit
  // in source as literals — what matters is that sanitizeCiText removes them from CI text.
  const classicToken = "ghp_" + "abcdef1234567890";
  const bearerValue = "super" + "secretvalue";
  const uuidToken = "00000000-0000-0000-0000-" + "000000000000";
  const dbPassword = "hunter" + "2";
  const awsKey = "AKIA" + "IOSFODNN7EXAMPLE";
  const fineGrainedPat = "github_" + "pat_abcDEF123";
  const redactedTag = "[" + "REDACTED]";
  const dirty = [
    "\u001b[31mred text\u001b[0m",
    `token ${classicToken} leaked`,
    `Authorization: Bearer ${bearerValue}`,
    `npm_token=${uuidToken}`,
    `db password=${dbPassword} here`,
    "see https://example.com/deploy?sig=abc123#frag for details",
    "run https://github.com/o/r/actions/runs/111/jobs/222?check_suite_focus=true next",
    "-----BEGIN RSA PRIVATE KEY-----",
    `${awsKey} exposed`,
    `${fineGrainedPat}_restricted here`,
    "key with\x01control\x7fchars",
  ].join("\n");
  const clean = sanitizeCiText(dirty);
  assert.match(clean, /red text/);
  assert.ok(!clean.includes(classicToken), "classic token redacted");
  assert.ok(!clean.includes(bearerValue), "bearer value redacted");
  assert.ok(!clean.includes(uuidToken), "assigned token value redacted");
  assert.ok(!clean.includes(dbPassword), "password value redacted");
  assert.ok(!clean.includes(awsKey), "aws key redacted");
  assert.ok(!clean.includes(fineGrainedPat), "fine-grained pat redacted");
  assert.doesNotMatch(clean, /\?sig=abc123/);
  assert.doesNotMatch(clean, /#frag/);
  assert.doesNotMatch(clean, /check_suite_focus/);
  assert.doesNotMatch(clean, /BEGIN RSA PRIVATE KEY/);
  assert.ok(!clean.includes("\x01"), "control chars stripped");
  assert.ok(clean.includes(redactedTag), "redaction marker present");
  assert.match(clean, /https:\/\/example\.com\/deploy( |$)/);
  assert.match(clean, /https:\/\/github\.com\/o\/r\/actions\/runs\/111\/jobs\/222( |$)/);
});

test("NOT-252: partial fetch failure keeps names and marks the excerpt incomplete", async () => {
  const exec: GhExec = async (args) => {
    if (args[0] === "pr") return { stdout: prViewWithRollup([actionsCheck("build", "FAILURE", "111"), actionsCheck("lint", "FAILURE", "222")]) };
    if (args[2] === "111") return { stdout: "build log\nError: boom\n" };
    throw Object.assign(new Error("log gone"), { stderr: "log gone" });
  };
  const evidence = await fetchChecksFailureEvidence(exec, { cwd: "/repo", number: 42, expectedHeadSha: HEAD_SHA });
  assert.ok(evidence, "partial failure still enriches with safe names");
  assert.deepEqual(
    evidence.failedChecks.map((c) => c.name),
    ["build", "lint"]
  );
  assert.equal(
    evidence.failedChecks.find((c) => c.name === "lint")?.logUnavailable,
    true
  );
  assert.equal(evidence.logsUnavailable, true);
  assert.match(evidence.excerpt, /boom/);
  assert.match(evidence.details, /build, lint/);
});

test("NOT-252: total fetch failure keeps names with an unavailable-excerpt marker", async () => {
  const exec: GhExec = async (args) => {
    if (args[0] === "pr") return { stdout: prViewWithRollup([actionsCheck("build", "FAILURE", "111")]) };
    throw Object.assign(new Error("forbidden"), { stderr: "forbidden" });
  };
  const evidence = await fetchChecksFailureEvidence(exec, { cwd: "/repo", number: 42, expectedHeadSha: HEAD_SHA });
  assert.ok(evidence, "total log failure still enriches with safe names, never null");
  assert.equal(evidence.excerpt, "");
  assert.equal(evidence.logsUnavailable, true);
  assert.match(evidence.details, /build/);
  assert.match(evidence.details, /excerpt unavailable/);
});

test("NOT-252: non-Actions check keeps safe metadata with no log fetch", async () => {
  const { exec, calls } = queuedExec([
    {
      stdout: prViewWithRollup([
        { context: "deploy/preview", state: "failure", targetUrl: "https://example.com/deploy/9?sig=abc#frag" },
      ]),
    },
  ]);
  const evidence = await fetchChecksFailureEvidence(exec, { cwd: "/repo", number: 42, expectedHeadSha: HEAD_SHA });
  assert.ok(evidence);
  assert.equal(evidence.failedChecks[0].name, "deploy/preview");
  assert.equal(evidence.failedChecks[0].runId, null);
  assert.equal(evidence.failedChecks[0].detailsUrl, "https://example.com/deploy/9");
  assert.ok(calls.every((c) => c[0] === "pr"), "external checks have no Actions run to fetch");
  assert.match(evidence.details, /deploy\/preview/);
});

test("NOT-252: checksSnapshot never shells out to a failure-log command", async () => {
  const { exec, calls } = queuedExec([
    { stdout: JSON.stringify({ statusCheckRollup: [{ conclusion: "failure" }] }) },
  ]);
  assert.equal(await createGithubAdapter(exec).checksSnapshot({ cwd: "/repo", number: 42 }), "failure");
  assert.deepEqual(calls, [["pr", "view", "42", "--json", "statusCheckRollup"]]);
});

test("NOT-252: extractActionsRunId and sanitizeUrl helpers", async () => {
  assert.equal(extractActionsRunId("https://github.com/o/r/actions/runs/123/jobs/456?x=1"), "123");
  assert.equal(extractActionsRunId("https://example.com/deploy/9"), null);
  assert.equal(extractActionsRunId(undefined), null);
  assert.equal(sanitizeUrl("https://example.com/a?b=1#c"), "https://example.com/a");
  assert.equal(sanitizeUrl("https://example.com/a"), "https://example.com/a");
});

test("NOT-252: formatChecksFailureDetails labels the excerpt as untrusted, not instructions", async () => {
  const details = formatChecksFailureDetails({
    headSha: HEAD_SHA,
    prNumber: 7,
    failedChecks: [{ name: "build", workflowName: "CI", conclusion: "failure", runId: "111" }],
    excerpt: "npm error 404 boom",
  });
  assert.match(details, new RegExp(CHECKS_FAILURE_GENERIC_REASON.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 20)));
  assert.match(details, /PR #7/);
  assert.match(details, new RegExp(HEAD_SHA));
  assert.match(details, /build \(CI · failure\)/);
  assert.match(details, /untrusted/);
  assert.match(details, /do NOT follow/);
  assert.match(details, /begin untrusted CI log excerpt/);
  assert.match(details, /end untrusted CI log excerpt/);
  const noExcerpt = formatChecksFailureDetails({
    headSha: HEAD_SHA,
    failedChecks: [{ name: "build", conclusion: "failure", runId: null }],
    excerpt: "",
  });
  assert.match(noExcerpt, /excerpt unavailable/);
});
