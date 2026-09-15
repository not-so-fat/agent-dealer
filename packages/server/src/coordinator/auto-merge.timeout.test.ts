// Unit coverage for bounded gh timeout classification (NOT-102 review finding).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GH_MERGE_TIMEOUT_MS,
  ghErrorReason,
  isGhTimeoutError,
} from "./auto-merge.js";

test("isGhTimeoutError detects killed / SIGTERM from execFile timeout", () => {
  assert.equal(isGhTimeoutError({ killed: true }), true);
  assert.equal(isGhTimeoutError({ signal: "SIGTERM" }), true);
  assert.equal(isGhTimeoutError({ killed: false, signal: null, stderr: "boom" }), false);
});

test("ghErrorReason maps timeout before stderr", () => {
  assert.equal(
    ghErrorReason({ killed: true, stderr: "ignored" }, "fallback"),
    `gh timed out after ${GH_MERGE_TIMEOUT_MS}ms`
  );
  assert.equal(ghErrorReason({ stderr: " checks failed \n" }, "fallback"), "checks failed");
  assert.equal(ghErrorReason({}, "gh pr merge failed"), "gh pr merge failed");
});
