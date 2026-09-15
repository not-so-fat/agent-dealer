import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CURSOR_KEYCHAIN_HEALTH_ISSUE,
  cursorAuthIssueFromOutput,
  isCursorKeychainStuckOutput,
} from "./cursor-auth-health.js";

const STUCK_STDERR = `Cursor couldn't save your login to the macOS keychain (errSecDuplicateItem, security exit code 45).
The keychain item is stuck. Delete it and sign in again:
  security delete-generic-password -s cursor-access-token -a cursor-user
  agent login
`;

test("isCursorKeychainStuckOutput detects errSecDuplicateItem", () => {
  assert.equal(isCursorKeychainStuckOutput(STUCK_STDERR), true);
});

test("isCursorKeychainStuckOutput detects security exit code 45", () => {
  assert.equal(isCursorKeychainStuckOutput("security exit code 45 while saving token"), true);
});

test("isCursorKeychainStuckOutput detects keychain item is stuck prose", () => {
  assert.equal(isCursorKeychainStuckOutput("The keychain item is stuck."), true);
});

test("isCursorKeychainStuckOutput ignores healthy status", () => {
  assert.equal(isCursorKeychainStuckOutput("Logged in as user@example.com\n"), false);
  assert.equal(isCursorKeychainStuckOutput("not logged in"), false);
});

test("cursorAuthIssueFromOutput maps stuck stderr to cursor_keychain issue code", () => {
  const issue = cursorAuthIssueFromOutput(STUCK_STDERR);
  assert.ok(issue);
  assert.equal(issue?.code, "cursor_keychain");
  assert.equal(issue?.message, CURSOR_KEYCHAIN_HEALTH_ISSUE.message);
  assert.match(issue!.message, /security delete-generic-password/);
  assert.match(issue!.message, /cursor-access-token/);
  assert.match(issue!.message, /agent login|cursor-agent login/);
});

test("cursorAuthIssueFromOutput maps not-logged-in to runtime_auth", () => {
  const issue = cursorAuthIssueFromOutput("Error: not logged in — run agent login");
  assert.deepEqual(issue, {
    code: "runtime_auth",
    message: "Run cursor-agent login",
  });
});

test("cursorAuthIssueFromOutput returns null for clean output", () => {
  assert.equal(cursorAuthIssueFromOutput("✓ Logged in\n"), null);
});
