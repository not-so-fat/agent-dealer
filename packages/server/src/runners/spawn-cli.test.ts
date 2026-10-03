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
import { sanitizeArgv, spawnCli } from "./spawn-cli.js";

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

// NOT-225: a NUL byte in any argv entry used to make spawn() throw
// ERR_INVALID_ARG_VALUE synchronously (no process, no pid, no log), which killed
// every reviewer session whose prompt embedded a PR diff containing a raw NUL.
// spawnCli must start anyway, with the visible six-character `\u0000` text where
// the byte was.
test("spawnCli starts when an arg contains a NUL byte, with the escaped text in the transcript", async () => {
  const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dealer-spawn-cli-")), "out.ndjson");

  const result = await spawnCli(
    "test-run-nul",
    process.execPath,
    ["-e", "console.log(process.argv[1])", "a\0b"],
    process.cwd(),
    { logPath, timeoutMs: 5000 }
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.ok(result.transcript.includes("a\\u0000b"), `expected the escaped text, got: ${JSON.stringify(result.transcript)}`);
  assert.ok(!result.transcript.includes("\0"), "no raw NUL may reach the child or the transcript");
});

test("sanitizeArgv leaves NUL-free args byte-identical (no re-encoding)", () => {
  const args = ["-p", "plain", "", "héllo😀", "--max-model-steps=10"];
  const out = sanitizeArgv(args);
  assert.deepEqual(out, args);
  assert.notStrictEqual(out, args, "a new array is returned");
  for (let i = 0; i < args.length; i++) {
    assert.strictEqual(out[i], args[i], `arg ${i} must be the identical string, not a copy`);
  }
  assert.deepEqual(sanitizeArgv([]), []);
});

test("sanitizeArgv replaces every NUL with the visible six-character escape", () => {
  assert.deepEqual(sanitizeArgv(["a\0b"]), ["a\\u0000b"]);
  assert.deepEqual(sanitizeArgv(["a\0b\0c"]), ["a\\u0000b\\u0000c"]);
  assert.deepEqual(sanitizeArgv(["\0"]), ["\\u0000"]);
  assert.deepEqual(sanitizeArgv(["ok", "x\0y", "ok"]), ["ok", "x\\u0000y", "ok"]);
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

// NOT-278: the Muse exec lane passes the approved attempt.env exactly — ambient
// META_API_KEY, MUSE_*, CODEX_HOME, and unrelated variables must not reach the child.
test("spawnCli exactEnv delivers only the supplied environment", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-spawn-cli-"));
  const logPath = path.join(dir, "out.ndjson");
  process.env.DEALER_SPAWN_CLI_AMBIENT_PROBE = "ambient-leaks";
  process.env.MUSE_PROBE_SHOULD_NOT_ARRIVE = "1";
  try {
    const result = await spawnCli(
      "test-run-exact-env",
      process.execPath,
      ["-e", "console.log(JSON.stringify(process.env))"],
      process.cwd(),
      { logPath, timeoutMs: 5000, env: { EXACT_ONLY: "yes" }, exactEnv: true }
    );
    assert.equal(result.exitCode, 0);
    const childEnv = JSON.parse(result.transcript) as Record<string, string>;
    assert.equal(childEnv.EXACT_ONLY, "yes");
    assert.equal("DEALER_SPAWN_CLI_AMBIENT_PROBE" in childEnv, false);
    assert.equal("MUSE_PROBE_SHOULD_NOT_ARRIVE" in childEnv, false);
    assert.equal("META_API_KEY" in childEnv, false);
    for (const key of Object.keys(childEnv)) {
      assert.equal(key.startsWith("MUSE_"), false, key);
      assert.equal(key.startsWith("CODEX_"), false, key);
    }
  } finally {
    delete process.env.DEALER_SPAWN_CLI_AMBIENT_PROBE;
    delete process.env.MUSE_PROBE_SHOULD_NOT_ARRIVE;
  }
});

test("spawnCli merges process.env by default (existing callers unchanged)", async () => {
  const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dealer-spawn-cli-")), "out.ndjson");
  process.env.DEALER_SPAWN_CLI_AMBIENT_PROBE = "ambient-present";
  try {
    const result = await spawnCli(
      "test-run-merged-env",
      process.execPath,
      ["-e", "console.log(`${process.env.DEALER_SPAWN_CLI_AMBIENT_PROBE}|${process.env.MERGED_ONLY}`)"],
      process.cwd(),
      { logPath, timeoutMs: 5000, env: { MERGED_ONLY: "yes" } }
    );
    assert.equal(result.exitCode, 0);
    assert.match(result.transcript, /ambient-present\|yes/);
  } finally {
    delete process.env.DEALER_SPAWN_CLI_AMBIENT_PROBE;
  }
});

// NOT-278: the Muse API key travels on stdin only — written once, closed, never logged.
test("spawnCli stdin payload is delivered on stdin and never logged", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-spawn-cli-"));
  const logPath = path.join(dir, "out.ndjson");
  const secret = `mk-test-secret-${Date.now()}`;
  const result = await spawnCli(
    "test-run-stdin",
    process.execPath,
    ["-e", "let b='';process.stdin.on('data',c=>b+=c).on('end',()=>console.log('got:'+b.length))"],
    process.cwd(),
    { logPath, timeoutMs: 5000, stdin: `${secret}\n` }
  );
  assert.equal(result.exitCode, 0);
  assert.match(result.transcript, new RegExp(`got:${secret.length + 1}`));
  const logged = fs.readFileSync(logPath, "utf8");
  assert.equal(logged.includes(secret), false);
  assert.equal(result.transcript.includes(secret), false);
});

test("spawnCli stdin close on an instantly-exiting child still settles", async () => {
  const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dealer-spawn-cli-")), "out.ndjson");
  const result = await spawnCli("test-run-stdin-early-exit", process.execPath, ["-e", "process.exit(3)"], process.cwd(), {
    logPath,
    timeoutMs: 5000,
    stdin: "payload-that-nobody-reads\n",
  });
  assert.equal(result.exitCode, 3);
  assert.equal(result.timedOut, false);
});

// NOT-307: a child that prints nothing for longer than idleTimeoutMs is killed like a
// wall-clock timeout (timedOut true) with the idle flag set — well before timeoutMs.
// Fake timers: the child is real (only the parent's clock is mocked), so the SIGTERM
// kill and the close event need real event-loop turns between mock advances.
test("spawnCli kills a silent child after idleTimeoutMs, well before timeoutMs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  try {
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dealer-spawn-cli-")), "out.ndjson");
    const { cmd, args } = nodeChild("setInterval(() => {}, 1000);");
    const promise = spawnCli("test-run-idle-kill", cmd, args, process.cwd(), {
      logPath,
      timeoutMs: 60_000,
      idleTimeoutMs: 250,
    });
    const flushIo = async (rounds: number) => {
      for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
    };
    t.mock.timers.tick(1000); // the 250ms idle bound fires; the 60s wall clock does not
    await flushIo(50); // let the SIGTERM kill land and the close event arrive
    t.mock.timers.tick(1000); // the finish(124) 500ms delay after the kill
    const result = await promise;
    assert.equal(result.timedOut, true, "an idle kill reads as a timeout downstream");
    assert.equal(result.idleTimedOut, true);
    assert.equal(result.transcript, "");
    assert.equal(result.firstOutputMs, null, "a silent child never produced output");
    assert.ok(
      typeof result.idleForMs === "number" && result.idleForMs >= 250,
      `idleForMs reports the observed silence, got ${result.idleForMs}`
    );
  } finally {
    t.mock.timers.reset();
  }
});

// NOT-307: a progressSource that keeps reporting fresh activity holds the watchdog off.
// The child prints once then idles forever; after forty idle windows of mock time it must
// still be alive (the abort below ends it — an idle kill would have beaten the abort).
test("spawnCli does not idle-kill while the progress source reports activity", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  try {
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dealer-spawn-cli-")), "out.ndjson");
    const { cmd, args } = nodeChild("console.log('started'); setInterval(() => {}, 1000);");
    const controller = new AbortController();
    const promise = spawnCli("test-run-idle-source", cmd, args, process.cwd(), {
      logPath,
      timeoutMs: 3_600_000,
      idleTimeoutMs: 250,
      progressSource: () => Date.now(),
      signal: controller.signal,
    });
    // Real-time wait for the child to actually print (mock-safe: no timer calls) —
    // otherwise the abort below can race child startup and prove nothing.
    for (let i = 0; i < 20000; i++) {
      try {
        if (fs.readFileSync(logPath, "utf8").includes("started")) break;
      } catch {
        // The log file is created asynchronously by the write stream — keep polling.
      }
      if (i === 19999) throw new Error("child never reported that it had started");
      await new Promise((r) => setImmediate(r));
    }
    for (let i = 0; i < 40; i++) {
      t.mock.timers.tick(250);
      await new Promise((r) => setImmediate(r));
    }
    controller.abort();
    const result = await promise;
    assert.equal(result.timedOut, false, "the abort ends it, not any timeout");
    assert.equal(result.idleTimedOut, false, "forty idle windows passed with no idle kill");
    assert.match(result.transcript, /started/);
  } finally {
    t.mock.timers.reset();
  }
});

// NOT-307: frequent stdout (faster than idleTimeoutMs, real timers) is progress — the
// child is never killed and the timing fields are populated.
test("spawnCli does not idle-kill a child that emits output more often than idleTimeoutMs", async () => {
  const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dealer-spawn-cli-")), "out.ndjson");
  const { cmd, args } = nodeChild(
    "let i = 0; const t = setInterval(() => { console.log('tick-' + i++); if (i >= 8) clearInterval(t); }, 50);"
  );
  const result = await spawnCli("test-run-idle-chatty", cmd, args, process.cwd(), {
    logPath,
    timeoutMs: 30_000,
    idleTimeoutMs: 500,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.idleTimedOut, false);
  assert.equal(result.idleForMs, null);
  assert.match(result.transcript, /tick-7/);
  assert.ok(
    typeof result.firstOutputMs === "number" && result.firstOutputMs >= 0,
    `firstOutputMs is measured, got ${result.firstOutputMs}`
  );
  assert.ok(result.lastActivityAt !== null, "lastActivityAt is recorded");
});

// NOT-307: the line hook reports each stdout line with a non-decreasing arrival time —
// the arrival stamps muse-spawn joins back to stream envelopes for per-event `ts`.
test("spawnCli onStdoutLine reports every line with arrival times", async () => {
  const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dealer-spawn-cli-")), "out.ndjson");
  const { cmd, args } = nodeChild(
    "console.log('line-one'); setTimeout(() => console.log('line-two'), 120);"
  );
  const seen: Array<{ line: string; atMs: number }> = [];
  const startedAt = Date.now();
  const result = await spawnCli("test-run-lines", cmd, args, process.cwd(), {
    logPath,
    timeoutMs: 10_000,
    onStdoutLine: (line, atMs) => seen.push({ line, atMs }),
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(
    seen.map((s) => s.line),
    ["line-one", "line-two"]
  );
  assert.ok(seen[0].atMs >= startedAt && seen[0].atMs <= Date.now());
  assert.ok(seen[1].atMs >= seen[0].atMs, "arrival times never run backwards");
  assert.ok(seen[1].atMs - seen[0].atMs >= 50, `the 120ms gap is visible, got ${seen[1].atMs - seen[0].atMs}ms`);
});

// NOT-307: with idleTimeoutMs unset the watchdog is disabled — a silent child runs to
// the wall clock exactly as before, and idleTimedOut reads false.
test("spawnCli without idleTimeoutMs times out on the wall clock with idleTimedOut false", async () => {
  const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dealer-spawn-cli-")), "out.ndjson");
  const { cmd, args } = nodeChild("setInterval(() => {}, 1000);");
  const result = await spawnCli("test-run-no-idle", cmd, args, process.cwd(), {
    logPath,
    timeoutMs: 400,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.idleTimedOut, false);
  assert.equal(result.lingeredAfterTerminal, false);
});

const terminalFailedLine = JSON.stringify({
  payload_type: "run.terminal.failed",
  payload: { terminal: "failed", reason: "transport error [net-timeout]: timed out waiting for response data (meta stream)" },
});
const isTerminalLine = (line: string) => line.includes("run.terminal.failed") || line.includes("run.terminal.completed");

// NOT-342: a child that has already printed its terminal envelope but does not exit
// is SIGTERM'd after the grace — well before the wall clock — and is not a timeout.
test("spawnCli kills a lingering child after terminalGrace without timing out", { timeout: 10_000 }, async () => {
  const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dealer-spawn-cli-")), "out.ndjson");
  const { cmd, args } = nodeChild(`console.log(${JSON.stringify(terminalFailedLine)}); setInterval(() => {}, 1000);`);
  const startedAt = Date.now();
  const result = await spawnCli("test-run-terminal-linger", cmd, args, process.cwd(), {
    logPath,
    timeoutMs: 30_000,
    terminalGrace: { isTerminalLine, graceMs: 200 },
  });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 5_000, `settled on the grace, not the wall clock, took ${elapsed}ms`);
  assert.equal(result.lingeredAfterTerminal, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.idleTimedOut, false);
  assert.match(result.transcript, /transport error/);
});

// NOT-342: exiting on its own inside the grace is the child's own close — no linger kill.
test("spawnCli does not linger-kill a child that exits inside the terminal grace", async () => {
  const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dealer-spawn-cli-")), "out.ndjson");
  const { cmd, args } = nodeChild(`console.log(${JSON.stringify(terminalFailedLine)}); process.exit(0);`);
  const result = await spawnCli("test-run-terminal-exits", cmd, args, process.cwd(), {
    logPath,
    timeoutMs: 10_000,
    terminalGrace: { isTerminalLine, graceMs: 2_000 },
  });
  assert.equal(result.lingeredAfterTerminal, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.idleTimedOut, false);
  assert.equal(result.exitCode, 0);
});
