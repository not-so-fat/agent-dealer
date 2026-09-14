// Regression test for a crash discovered live on the very first real (non-fixture) dev
// session: `finish()` called `logStream.end()` and then, if the child produced any
// stderr, `logStream.write(...)` on the now-ended stream -- ERR_STREAM_WRITE_AFTER_END,
// an unhandled stream 'error' event, which crashes the entire coordinator process (every
// fixture-based test's fake spawn never wrote real stderr, so this path was never
// exercised until a real CLI invocation hit it).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnCli } from "./spawn-cli.js";

test("spawnCli does not crash when the child process writes to stderr", async () => {
  const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dealer-spawn-cli-")), "out.ndjson");

  const result = await spawnCli(
    "test-run-stderr",
    "sh",
    ["-c", "echo out-line; echo err-line 1>&2"],
    process.cwd(),
    { logPath, timeoutMs: 5000 }
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.match(result.transcript, /out-line/);

  // The stderr section was actually appended to the log file, not lost -- proves the
  // write happened before end(), not just that it failed to throw.
  const logged = fs.readFileSync(logPath, "utf8");
  assert.match(logged, /out-line/);
  assert.match(logged, /--- stderr ---/);
  assert.match(logged, /err-line/);
});

test("spawnCli does not crash when the child writes only stdout (no stderr)", async () => {
  const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dealer-spawn-cli-")), "out.ndjson");

  const result = await spawnCli("test-run-nostderr", "sh", ["-c", "echo out-only"], process.cwd(), {
    logPath,
    timeoutMs: 5000,
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.transcript, /out-only/);
  const logged = fs.readFileSync(logPath, "utf8");
  assert.doesNotMatch(logged, /--- stderr ---/);
});

// PR #27 review, round 2: waiting for finish()/error on the write stream only helps if
// those listeners are attached before the stream already failed. A stream that errors
// (and self-destroys) BEFORE the child closes -- e.g. ENOENT opening the log file --
// never emits either event again once end() is called, so a naive wait-then-resolve
// would hang forever, leaking the spawn slot. Set a short per-test timeout so a
// regression fails fast instead of hanging the whole suite.
test(
  "spawnCli still resolves (does not hang) when the log stream already errored before the child closed",
  { timeout: 5000 },
  async () => {
    // A path whose parent directory doesn't exist -- fs.createWriteStream fails with
    // ENOENT almost immediately, well before this "sleep" child exits.
    const logPath = path.join(os.tmpdir(), `dealer-spawn-cli-missing-${Date.now()}`, "nested", "out.ndjson");

    const result = await spawnCli("test-run-stream-error", "sh", ["-c", "sleep 0.2; echo done"], process.cwd(), {
      logPath,
      timeoutMs: 5000,
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.transcript, /done/, "the in-memory transcript is unaffected by the log file write failing");
  }
);
