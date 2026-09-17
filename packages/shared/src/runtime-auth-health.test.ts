// packages/shared/src/runtime-auth-health.test.ts
//
// NOT-133: these assertions run against verbatim CLI captures (src/fixtures/runtime-auth/),
// not phrasings a test author guessed at. The bug being regression-tested is exactly the
// gap that hand-written expectations cannot catch — the old suite asserted "login required"
// while cursor-agent prints "Authentication required".
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AMBIGUOUS_AUTH_REMEDIATION,
  CLAUDE_AUTH_REMEDIATION,
  CODEX_AUTH_REMEDIATION,
  CURSOR_AUTH_REMEDIATION,
  CURSOR_KEYCHAIN_HEALTH_ISSUE,
  anyRuntimeAuthIssueFromOutput,
  cursorAuthIssueFromOutput,
  isCursorKeychainStuckOutput,
  runtimeAuthIssueFromOutput,
} from "./runtime-auth-health.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/runtime-auth");

function capture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

/**
 * The NOT-133 stderr, byte for byte. Asserting the capture's own content here means a
 * fixture silently replaced by a paraphrase fails this test instead of passing quietly.
 */
test("the cursor-agent logged-out capture is the string the incident reported", () => {
  assert.equal(
    capture("cursor-agent-print-logged-out.txt"),
    "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.\n"
  );
});

test("cursorAuthIssueFromOutput classifies the verbatim cursor-agent logged-out stderr", () => {
  const issue = cursorAuthIssueFromOutput(capture("cursor-agent-print-logged-out.txt"));
  assert.equal(issue?.code, "runtime_auth");
  assert.equal(issue?.message, CURSOR_AUTH_REMEDIATION);
});

test("the cursor remediation offers both routes the CLI itself offers", () => {
  // The old message named only `cursor-agent login` while the CLI offers login *or* an API key.
  assert.match(CURSOR_AUTH_REMEDIATION, /cursor-agent login/);
  assert.match(CURSOR_AUTH_REMEDIATION, /agent login/);
  assert.match(CURSOR_AUTH_REMEDIATION, /CURSOR_API_KEY/);
});

test("cursorAuthIssueFromOutput classifies the verbatim `cursor-agent status` logged-out capture", () => {
  // The admission-gate half: the preflight classifies `status`, not `-p` stderr.
  const issue = cursorAuthIssueFromOutput(capture("cursor-agent-status-logged-out.txt"));
  assert.equal(issue?.code, "runtime_auth");
});

test("cursorAuthIssueFromOutput classifies a rejected CURSOR_API_KEY", () => {
  const issue = cursorAuthIssueFromOutput(capture("cursor-agent-print-invalid-api-key.txt"));
  assert.equal(issue?.code, "runtime_auth");
});

test("cursorAuthIssueFromOutput passes a logged-in `cursor-agent status` capture (ANSI included)", () => {
  assert.equal(cursorAuthIssueFromOutput(capture("cursor-agent-status-logged-in.txt")), null);
});

test("codex logged-out captures classify as runtime_auth", () => {
  for (const name of ["codex-login-status-logged-out.txt", "codex-exec-logged-out.txt"]) {
    const issue = runtimeAuthIssueFromOutput("codex_local", capture(name));
    assert.equal(issue?.code, "runtime_auth", `${name} should classify`);
    assert.equal(issue?.message, CODEX_AUTH_REMEDIATION);
  }
});

test("a logged-in `codex login status` capture is not a runtime_auth issue", () => {
  assert.equal(
    runtimeAuthIssueFromOutput("codex_local", capture("codex-login-status-logged-in.txt")),
    null
  );
});

test("claude logged-out captures classify as runtime_auth", () => {
  for (const name of [
    "claude-print-logged-out.txt",
    "claude-print-invalid-api-key.txt",
    "claude-auth-status-logged-out.txt",
  ]) {
    const issue = runtimeAuthIssueFromOutput("claude_code", capture(name));
    assert.equal(issue?.code, "runtime_auth", `${name} should classify`);
    assert.equal(issue?.message, CLAUDE_AUTH_REMEDIATION);
  }
});

test("a logged-in `claude auth status` capture is not a runtime_auth issue", () => {
  assert.equal(
    runtimeAuthIssueFromOutput("claude_code", capture("claude-auth-status-logged-in.txt")),
    null
  );
});

test("anyRuntimeAuthIssueFromOutput names the runtime a log came from", () => {
  const cursor = anyRuntimeAuthIssueFromOutput(capture("cursor-agent-print-logged-out.txt"));
  assert.equal(cursor?.runtime, "cursor_local");
  assert.equal(cursor?.issue.message, CURSOR_AUTH_REMEDIATION);

  const codex = anyRuntimeAuthIssueFromOutput(capture("codex-exec-logged-out.txt"));
  assert.equal(codex?.runtime, "codex_local");
  assert.equal(codex?.issue.message, CODEX_AUTH_REMEDIATION);

  const claude = anyRuntimeAuthIssueFromOutput(capture("claude-print-invalid-api-key.txt"));
  assert.equal(claude?.runtime, "claude_code");
  assert.equal(claude?.issue.message, CLAUDE_AUTH_REMEDIATION);

  assert.equal(anyRuntimeAuthIssueFromOutput(capture("codex-login-status-logged-in.txt")), null);
});

test("a Claude log with no recorded runtime is not reported as Cursor", () => {
  // `Not logged in · Please run /login`. Cursor's pattern list also carries "not logged in",
  // so trying the runtimes in a fixed order attributed this capture — and Cursor's
  // remediation — to Cursor. `/login` is Claude's own wording and settles it.
  const claude = anyRuntimeAuthIssueFromOutput(capture("claude-print-logged-out.txt"));
  assert.equal(claude?.runtime, "claude_code");
  assert.equal(claude?.issue.message, CLAUDE_AUTH_REMEDIATION);
  assert.doesNotMatch(claude!.issue.message, /cursor/i);
});

test("a Claude `auth status` JSON body with no recorded runtime is attributed to Claude", () => {
  const claude = anyRuntimeAuthIssueFromOutput(capture("claude-auth-status-logged-out.txt"));
  assert.equal(claude?.runtime, "claude_code");
  assert.equal(claude?.issue.message, CLAUDE_AUTH_REMEDIATION);
});

test("a Codex exec log with no recorded runtime is attributed to Codex, not Cursor", () => {
  const codex = anyRuntimeAuthIssueFromOutput(capture("codex-exec-logged-out.txt"));
  assert.equal(codex?.runtime, "codex_local");
  assert.doesNotMatch(codex!.issue.message, /cursor/i);
});

test("a bare `Not logged in` is classified as auth but attributed to no runtime", () => {
  // cursor-agent status and codex login status print the identical line: the two captures are
  // byte-for-byte the same, so nothing in the text can name the CLI that wrote it.
  assert.equal(
    capture("cursor-agent-status-logged-out.txt"),
    capture("codex-login-status-logged-out.txt")
  );
  for (const name of ["cursor-agent-status-logged-out.txt", "codex-login-status-logged-out.txt"]) {
    const classified = anyRuntimeAuthIssueFromOutput(capture(name));
    assert.equal(classified?.issue.code, "runtime_auth", `${name} is still an auth failure`);
    assert.equal(classified?.runtime, null, `${name} must not be attributed to a runtime`);
    assert.equal(classified?.issue.message, AMBIGUOUS_AUTH_REMEDIATION);
    // The generic remediation covers every runtime rather than betting on one.
    assert.match(classified!.issue.message, /cursor-agent login/);
    assert.match(classified!.issue.message, /codex login/);
    assert.match(classified!.issue.message, /claude auth login/);
  }
});

test("a known runtime still gets its own remediation for the shared `Not logged in`", () => {
  // The ambiguity above only applies when the caller cannot say what ran. The health
  // preflight always can, and must keep naming the CLI it just probed.
  const status = capture("cursor-agent-status-logged-out.txt");
  assert.equal(runtimeAuthIssueFromOutput("cursor_local", status)?.message, CURSOR_AUTH_REMEDIATION);
  assert.equal(runtimeAuthIssueFromOutput("codex_local", status)?.message, CODEX_AUTH_REMEDIATION);
});

test("a stuck keychain is attributed to Cursor even with no recorded runtime", () => {
  const classified = anyRuntimeAuthIssueFromOutput(RECONSTRUCTED_KEYCHAIN_STDERR);
  assert.equal(classified?.runtime, "cursor_local");
  assert.equal(classified?.issue.code, "cursor_keychain");
});

// NOT-114's keychain branch has no capture — the stuck-keychain state cannot be provoked
// without corrupting the operator's real keychain, so this stays a reconstruction of the
// reported stderr and is labelled as such rather than filed under fixtures/.
const RECONSTRUCTED_KEYCHAIN_STDERR = `Cursor couldn't save your login to the macOS keychain (errSecDuplicateItem, security exit code 45).
The keychain item is stuck. Delete it and sign in again:
  security delete-generic-password -s cursor-access-token -a cursor-user
  agent login
`;

test("isCursorKeychainStuckOutput detects errSecDuplicateItem", () => {
  assert.equal(isCursorKeychainStuckOutput(RECONSTRUCTED_KEYCHAIN_STDERR), true);
});

test("isCursorKeychainStuckOutput detects security exit code 45", () => {
  assert.equal(isCursorKeychainStuckOutput("security exit code 45 while saving token"), true);
});

test("isCursorKeychainStuckOutput detects keychain item is stuck prose", () => {
  assert.equal(isCursorKeychainStuckOutput("The keychain item is stuck."), true);
});

test("isCursorKeychainStuckOutput ignores healthy status", () => {
  assert.equal(isCursorKeychainStuckOutput(capture("cursor-agent-status-logged-in.txt")), false);
  assert.equal(isCursorKeychainStuckOutput(capture("cursor-agent-status-logged-out.txt")), false);
});

test("the keychain classification still wins over the plain logged-out one", () => {
  const issue = cursorAuthIssueFromOutput(RECONSTRUCTED_KEYCHAIN_STDERR);
  assert.equal(issue?.code, "cursor_keychain");
  assert.equal(issue?.message, CURSOR_KEYCHAIN_HEALTH_ISSUE.message);
  assert.match(issue!.message, /security delete-generic-password/);
  assert.match(issue!.message, /cursor-access-token/);
  assert.match(issue!.message, /agent login|cursor-agent login/);
});

test("cursorAuthIssueFromOutput returns null for clean output", () => {
  assert.equal(cursorAuthIssueFromOutput("✓ Logged in\n"), null);
});
