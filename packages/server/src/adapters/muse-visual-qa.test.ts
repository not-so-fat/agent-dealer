// packages/server/src/adapters/muse-visual-qa.test.ts
//
// NOT-303: the Muse Dev screenshot-path preflight. The unusable verdict must fail
// loudly — naming the RegisterApplication abort and the missing binary — instead
// of letting the worker discover it mid-session.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkMuseVisualQa,
  MUSE_HEADLESS_SHELL_BIN_ENV,
  museVisualQaPromptSection,
} from "./muse-visual-qa.js";

test("unset override: unusable, naming the Chrome.app abort and the missing binary", () => {
  const status = checkMuseVisualQa({ env: {}, exists: () => false });
  assert.equal(status.usable, false);
  assert.equal(status.binary, null);
  assert.match(status.reason, /RegisterApplication/);
  assert.match(status.reason, /MUSE_HEADLESS_SHELL_BIN/);
});

test("configured but absent binary: unusable, naming the path", () => {
  const status = checkMuseVisualQa({
    env: { [MUSE_HEADLESS_SHELL_BIN_ENV]: "/opt/headless/chrome-headless-shell" },
    exists: () => false,
  });
  assert.equal(status.usable, false);
  assert.equal(status.binary, null);
  assert.match(status.reason, /\/opt\/headless\/chrome-headless-shell/);
  assert.match(status.reason, /RegisterApplication/);
});

test("configured but non-absolute value: unusable, not treated as a binary", () => {
  const status = checkMuseVisualQa({
    env: { [MUSE_HEADLESS_SHELL_BIN_ENV]: "relative/bin" },
    exists: () => true,
  });
  assert.equal(status.usable, false);
  assert.equal(status.binary, null);
  assert.match(status.reason, /absolute path/);
});

test("pre-installed binary present: usable with binary and screenshot flags", () => {
  const status = checkMuseVisualQa({
    env: { [MUSE_HEADLESS_SHELL_BIN_ENV]: "/opt/headless/chrome-headless-shell" },
    exists: (p) => p === "/opt/headless/chrome-headless-shell",
  });
  assert.equal(status.usable, true);
  assert.equal(status.binary, "/opt/headless/chrome-headless-shell");
  assert.ok(status.args.some((a) => a.startsWith("--screenshot=")));
});

test("unusable prompt section: forbids Chrome.app probing, declares out of scope, requires the conclusion line", () => {
  const lines = museVisualQaPromptSection(checkMuseVisualQa({ env: {}, exists: () => false }));
  const text = lines.join("\n");
  assert.match(text, /## Visual QA/);
  assert.match(text, /Google Chrome\.app/);
  assert.match(text, /RegisterApplication/);
  assert.match(text, /do not spend steps probing/i);
  assert.match(text, /out of scope/i);
  assert.match(text, /Visual QA: not run/);
  assert.doesNotMatch(text, /--disable-sandbox/);
  assert.doesNotMatch(text, /--yolo/);
});

test("usable prompt section: names the binary and still forbids Google Chrome.app", () => {
  const lines = museVisualQaPromptSection({
    usable: true,
    binary: "/opt/headless/chrome-headless-shell",
    args: ["--screenshot=<png>", "--window-size=1280,800"],
    reason: "pre-installed headless shell",
  });
  const text = lines.join("\n");
  assert.match(text, /\/opt\/headless\/chrome-headless-shell/);
  assert.match(text, /--screenshot=<png>/);
  assert.match(text, /Google Chrome\.app/);
  assert.match(text, /Visual QA:/);
});
