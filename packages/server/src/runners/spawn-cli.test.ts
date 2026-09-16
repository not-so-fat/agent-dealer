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

// NOT-126: an attempt that loses its lease aborts, but the abort used to stop at the
// handler -- the spawned CLI kept running, kept editing the worktree, and the successor
// attempt was then handed that same worktree, so two live agents shared one tree. These
// use `process.execPath` rather than `sh -c '... sleep 30'` deliberately: a shell's
// orphaned grandchild inherits the stdout pipe and holds it open, so 'close' would not
// fire promptly and the test would pass for the wrong reason.
const nodeChild = (body: string) => ({ cmd: process.execPath, args: ["-e", body] });

async function waitForStart(logPath: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.readFileSync(logPath, "utf8").includes("started")) return;
    } catch {
      // The log file is created asynchronously by the write stream -- keep polling.
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("child never reported that it had started");
}

test("spawnCli terminates the child when the attempt is aborted", { timeout: 15_000 }, async () => {
  const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dealer-spawn-cli-")), "out.ndjson");
  const { cmd, args } = nodeChild("console.log('started'); setInterval(() => {}, 1000);");
  const controller = new AbortController();

  const startedAt = Date.now();
  // timeoutMs is deliberately far longer than the test timeout: if the abort does not
  // kill the child, nothing else will, and this test fails by timing out.
  const promise = spawnCli("test-run-abort", cmd, args, process.cwd(), {
    logPath,
    timeoutMs: 600_000,
    signal: controller.signal,
  });

  await waitForStart(logPath);
  controller.abort();
  const result = await promise;

  assert.ok(Date.now() - startedAt < 15_000, "resolved on the abort, not on the 10-minute timeout");
  assert.equal(result.timedOut, false, "an abort is a lost lease, not a wall-clock timeout");
  assert.match(result.transcript, /started/, "output produced before the abort is still returned");
});

test("spawnCli escalates to SIGKILL when the child ignores SIGTERM", { timeout: 15_000 }, async () => {
  const previous = process.env.SPAWN_ABORT_KILL_GRACE_MS;
  process.env.SPAWN_ABORT_KILL_GRACE_MS = "250";
  try {
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dealer-spawn-cli-")), "out.ndjson");
    const { cmd, args } = nodeChild(
      "process.on('SIGTERM', () => {}); console.log('started'); setInterval(() => {}, 1000);"
    );
    const controller = new AbortController();

    const promise = spawnCli("test-run-abort-sigkill", cmd, args, process.cwd(), {
      logPath,
      timeoutMs: 600_000,
      signal: controller.signal,
    });

    await waitForStart(logPath);
    controller.abort();
    // Only the SIGKILL backstop can end this child -- it swallows SIGTERM outright.
    const result = await promise;
    assert.equal(result.timedOut, false);
  } finally {
    if (previous === undefined) delete process.env.SPAWN_ABORT_KILL_GRACE_MS;
    else process.env.SPAWN_ABORT_KILL_GRACE_MS = previous;
  }
});

test("spawnCli runs normally when an un-aborted signal is supplied", { timeout: 10_000 }, async () => {
  const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dealer-spawn-cli-")), "out.ndjson");
  const controller = new AbortController();

  const result = await spawnCli("test-run-abort-unused", "sh", ["-c", "echo untouched"], process.cwd(), {
    logPath,
    timeoutMs: 5000,
    signal: controller.signal,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.match(result.transcript, /untouched/);
});
