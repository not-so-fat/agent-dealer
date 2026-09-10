import { test } from "node:test";
import assert from "node:assert/strict";
import { cursorInvokeArgs, resolveCodexBin } from "./cli-env.js";

test("cursorInvokeArgs passes through for cursor-agent", () => {
  const prev = process.env.CURSOR_CLI;
  process.env.CURSOR_CLI = "/home/user/.local/bin/cursor-agent";
  try {
    assert.deepEqual(cursorInvokeArgs(["status"]), ["status"]);
    assert.deepEqual(cursorInvokeArgs(["-p", "--trust", "hi"]), ["-p", "--trust", "hi"]);
  } finally {
    if (prev === undefined) delete process.env.CURSOR_CLI;
    else process.env.CURSOR_CLI = prev;
  }
});

test("cursorInvokeArgs prepends agent subcommand for legacy cursor shim", () => {
  const prev = process.env.CURSOR_CLI;
  process.env.CURSOR_CLI = "/usr/local/bin/cursor";
  try {
    assert.deepEqual(cursorInvokeArgs(["status"]), ["agent", "status"]);
  } finally {
    if (prev === undefined) delete process.env.CURSOR_CLI;
    else process.env.CURSOR_CLI = prev;
  }
});

test("resolveCodexBin respects CODEX_CLI override", () => {
  const prev = process.env.CODEX_CLI;
  process.env.CODEX_CLI = "/tmp/custom-codex";
  try {
    assert.equal(resolveCodexBin(), "/tmp/custom-codex");
  } finally {
    if (prev === undefined) delete process.env.CODEX_CLI;
    else process.env.CODEX_CLI = prev;
  }
});
