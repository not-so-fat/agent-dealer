// packages/server/src/coordinator/failure-reason.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRESUMED_DEAD_REASON,
  classifyRunnerLogFailure,
  parseErrorJsonReason,
  presumedDeadReclaimReason,
  reasonForDirtyWorktree,
  reasonForSessionCrash,
  reasonForWorkerFailedEvent,
} from "./failure-reason.js";

const KEYCHAIN_STDERR = `Cursor couldn't save your login to the macOS keychain (errSecDuplicateItem, security exit code 45).
The keychain item is stuck. Delete it and sign in again:
  security delete-generic-password -s cursor-access-token -a cursor-user
  agent login
`;

/** Verbatim CLI captures — see packages/shared/src/fixtures/runtime-auth/README.md. */
const CAPTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../shared/src/fixtures/runtime-auth"
);

function capture(name: string): string {
  return fs.readFileSync(path.join(CAPTURES, name), "utf8");
}

function writeLog(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-fail-reason-"));
  const logPath = path.join(dir, "session.ndjson");
  fs.writeFileSync(logPath, body);
  return logPath;
}

/** The NOT-133 sessions' entire log: a spawn that produced nothing but this stderr trailer. */
function writeAuthDeathLog(): string {
  return writeLog(`\n--- stderr ---\n${capture("cursor-agent-print-logged-out.txt")}`);
}

test("classifyRunnerLogFailure maps keychain stderr trailer to auth/keychain reason", () => {
  const logPath = writeLog(`{"type":"assistant"}\n--- stderr ---\n${KEYCHAIN_STDERR}`);
  const reason = classifyRunnerLogFailure(logPath);
  assert.ok(reason);
  assert.match(reason!, /keychain|errSecDuplicateItem/i);
  assert.match(reason!, /auth/i);
});

test("keychain classification does not depend on the session's recorded runtime", () => {
  // worker_sessions.runtime is nullable and can disagree with whatever wrote the log; the
  // keychain signature could only have come from Cursor either way.
  const logPath = writeLog(`{"type":"assistant"}\n--- stderr ---\n${KEYCHAIN_STDERR}`);
  for (const runtime of [undefined, "claude_code", "codex_local", "cursor_local"] as const) {
    assert.match(classifyRunnerLogFailure(logPath, runtime)!, /keychain|errSecDuplicateItem/i);
  }
});

test("classifyRunnerLogFailure maps reconnect exhaustion", () => {
  const logPath = writeLog("stream error: failed to reconnect after 5 attempts\n");
  assert.match(classifyRunnerLogFailure(logPath)!, /reconnect exhausted/i);
});

test("reasonForDirtyWorktree prefers keychain classification while preserving dirty-tree note", () => {
  const logPath = writeLog(`\n--- stderr ---\n${KEYCHAIN_STDERR}`);
  const reason = reasonForDirtyWorktree(logPath);
  assert.match(reason, /keychain|errSecDuplicateItem/i);
  assert.match(reason, /Worktree preserved/i);
});

test("NOT-133: a cursor session that died on auth is named, not 'failed or crashed'", () => {
  const reason = reasonForSessionCrash({
    timedOut: false,
    logPath: writeAuthDeathLog(),
    runtime: "cursor_local",
  });
  assert.notEqual(reason, "Developer session failed or crashed.");
  assert.match(reason, /Cursor auth required mid-run/);
  // The strip has to carry the remediation, not just the diagnosis.
  assert.match(reason, /cursor-agent login/);
  assert.match(reason, /CURSOR_API_KEY/);
});

test("NOT-133: the same log classifies without being told which runtime wrote it", () => {
  // The recovery/detail path only has a log path — it must not fall back to the generic reason.
  assert.match(classifyRunnerLogFailure(writeAuthDeathLog())!, /Cursor auth required mid-run/);
});

test("NOT-133: codex and claude auth deaths are named too", () => {
  const codex = classifyRunnerLogFailure(
    writeLog(`\n--- stderr ---\n${capture("codex-exec-logged-out.txt")}`),
    "codex_local"
  );
  assert.match(codex!, /Codex auth required mid-run/);
  assert.match(codex!, /codex login/);

  const claude = classifyRunnerLogFailure(
    writeLog(`\n--- stderr ---\n${capture("claude-print-logged-out.txt")}`),
    "claude_code"
  );
  assert.match(claude!, /Claude Code auth required mid-run/);
  assert.match(claude!, /claude auth login/);
});

test("NOT-133: a runtime-less Claude log is named Claude, not Cursor", () => {
  // worker_sessions.runtime is nullable; "Not logged in · Please run /login" is Claude's, but
  // Cursor's pattern list carries "not logged in" too, so order-of-trial named Cursor here.
  const reason = classifyRunnerLogFailure(
    writeLog(`\n--- stderr ---\n${capture("claude-print-logged-out.txt")}`)
  );
  assert.match(reason!, /Claude Code auth required mid-run/);
  assert.match(reason!, /claude auth login/);
  assert.doesNotMatch(reason!, /cursor/i);
});

test("NOT-133: a runtime-less Codex log is named Codex, not Cursor", () => {
  const reason = classifyRunnerLogFailure(
    writeLog(`\n--- stderr ---\n${capture("codex-exec-logged-out.txt")}`)
  );
  assert.match(reason!, /Codex auth required mid-run/);
  assert.match(reason!, /codex login/);
  assert.doesNotMatch(reason!, /cursor/i);
});

test("NOT-133: a runtime-less log that names no CLI reports auth without guessing one", () => {
  // `cursor-agent status` and `codex login status` both print exactly "Not logged in".
  const reason = classifyRunnerLogFailure(
    writeLog(`\n--- stderr ---\n${capture("codex-login-status-logged-out.txt")}`)
  );
  assert.match(reason!, /Runtime auth required mid-run/);
  assert.match(reason!, /cursor-agent login/);
  assert.match(reason!, /codex login/);
  assert.match(reason!, /claude auth login/);
  // Still better than the thing NOT-133 was filed about.
  assert.notEqual(reason, "Developer session failed or crashed.");
});

test("NOT-133: a recorded runtime still names that CLI for the shared `Not logged in`", () => {
  const logPath = writeLog(`\n--- stderr ---\n${capture("codex-login-status-logged-out.txt")}`);
  assert.match(classifyRunnerLogFailure(logPath, "codex_local")!, /Codex auth required mid-run/);
  assert.match(classifyRunnerLogFailure(logPath, "cursor_local")!, /Cursor auth required mid-run/);
});

test("NOT-133: a log that names its own CLI outranks a wrong recorded runtime", () => {
  // worker_sessions.runtime can disagree with what ran (nullable column, older rows, an agent
  // whose runtime was edited between attempts). Telling the operator `cursor-agent login`
  // because the row said cursor_local, when Claude printed the failure, is the same class of
  // wrong answer NOT-133 is about — a confident remediation for the wrong CLI.
  const claudeLog = writeLog(`\n--- stderr ---\n${capture("claude-print-logged-out.txt")}`);
  for (const wrong of ["cursor_local", "codex_local"] as const) {
    const reason = classifyRunnerLogFailure(claudeLog, wrong)!;
    assert.match(reason, /Claude Code auth required mid-run/, `recorded ${wrong} must not win`);
    assert.match(reason, /claude auth login/);
    assert.doesNotMatch(reason, /cursor|codex/i);
  }

  const codexLog = writeLog(`\n--- stderr ---\n${capture("codex-exec-logged-out.txt")}`);
  assert.match(classifyRunnerLogFailure(codexLog, "cursor_local")!, /Codex auth required mid-run/);

  const cursorLog = writeAuthDeathLog();
  assert.match(classifyRunnerLogFailure(cursorLog, "claude_code")!, /Cursor auth required mid-run/);
});

/**
 * A worker transcript that *discusses* auth failures — the NOT-133 session itself quotes every
 * capture in this directory — must not be read as one. Every runner spawns its CLI in a
 * structured output mode, so transcript prose always arrives inside stream events; only
 * stderr and terminal error events describe how the session died.
 */
const TRANSCRIPT_QUOTING_AUTH_PROSE = [
  JSON.stringify({
    type: "assistant",
    message: {
      content: [
        {
          type: "text",
          text:
            `The classifier missed the real string. Captures:\n` +
            `${capture("cursor-agent-print-logged-out.txt")}` +
            `${capture("claude-print-logged-out.txt")}` +
            `${capture("codex-exec-logged-out.txt")}` +
            `${capture("cursor-agent-print-invalid-api-key.txt")}`,
        },
      ],
    },
  }),
  // Codex's native JSONL transcript shape carries the same prose in `item.text`.
  JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: capture("claude-print-invalid-api-key.txt") },
  }),
  JSON.stringify({ type: "result", is_error: true, result: "exit 1" }),
].join("\n");

test("NOT-133: auth prose inside a non-error transcript event is not an auth failure", () => {
  const logPath = writeLog(`${TRANSCRIPT_QUOTING_AUTH_PROSE}\n`);
  for (const runtime of [undefined, "cursor_local", "codex_local", "claude_code"] as const) {
    assert.equal(
      classifyRunnerLogFailure(logPath, runtime),
      null,
      `transcript prose must not classify as auth for runtime=${runtime}`
    );
  }
  assert.equal(
    reasonForSessionCrash({ timedOut: false, logPath, runtime: "cursor_local" }),
    "Developer session failed or crashed."
  );
});

test("NOT-133: the same prose in a terminal error result IS an auth failure", () => {
  // The narrowed haystack must not lose the signal: a CLI that reports its auth failure as
  // the session's error result, rather than on stderr, still has to be classified.
  const logPath = writeLog(
    `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "starting" }] } })}\n` +
      `${JSON.stringify({
        type: "result",
        is_error: true,
        result: capture("cursor-agent-print-logged-out.txt"),
      })}\n`
  );
  assert.match(classifyRunnerLogFailure(logPath)!, /Cursor auth required mid-run/);
  assert.match(classifyRunnerLogFailure(logPath, "cursor_local")!, /CURSOR_API_KEY/);
});

test("NOT-133: a Codex turn.failed error message is classified", () => {
  const logPath = writeLog(
    `${JSON.stringify({ type: "thread.started", thread_id: "t1" })}\n` +
      `${JSON.stringify({
        type: "turn.failed",
        error: { message: capture("codex-exec-logged-out.txt") },
      })}\n`
  );
  assert.match(classifyRunnerLogFailure(logPath, "codex_local")!, /Codex auth required mid-run/);
});

test("NOT-133: an error event carries its message whether nested or flat", () => {
  // `error` arrives as a bare string in some events and `{ message }` in others; reading
  // only one shape silently loses the failure and falls back to "failed or crashed".
  for (const error of [
    capture("cursor-agent-print-logged-out.txt"),
    { message: capture("cursor-agent-print-logged-out.txt") },
  ]) {
    const logPath = writeLog(`${JSON.stringify({ type: "error", error })}\n`);
    assert.match(classifyRunnerLogFailure(logPath)!, /Cursor auth required mid-run/);
  }
});

test("NOT-133: a timestamped plain-text CLI line is still classified", () => {
  // Not every CLI diagnostic is a JSON event; a bracketed prefix must not make one look
  // like a transcript line and get skipped.
  const logPath = writeLog(
    `[2026-09-16T05:05:53Z] ${capture("cursor-agent-print-logged-out.txt")}`
  );
  assert.match(classifyRunnerLogFailure(logPath)!, /Cursor auth required mid-run/);
});

test("NOT-133: a worker.failed event for an auth death carries the auth reason", () => {
  const reason = reasonForWorkerFailedEvent({
    outcome: { kind: "session_failed" },
    routeReason: "Developer session failed or crashed.",
    logPath: writeAuthDeathLog(),
    runtime: "cursor_local",
  });
  assert.match(reason, /Cursor auth required mid-run/);
});

test("reasonForSessionCrash falls back when log is clean", () => {
  assert.equal(
    reasonForSessionCrash({ timedOut: false, logPath: writeLog('{"type":"result"}\n') }),
    "Developer session failed or crashed."
  );
});

test("parseErrorJsonReason reads recovery presumed-dead shape", () => {
  assert.equal(
    parseErrorJsonReason(JSON.stringify({ reason: PRESUMED_DEAD_REASON })),
    PRESUMED_DEAD_REASON
  );
});

test("presumedDeadReclaimReason names the role that is actually being re-run (NOT-129)", () => {
  // A reviewer item has no branch of its own to publish, so republish is always null for it —
  // the message must not claim the developer is being re-run, nor mention a branch.
  const reviewer = presumedDeadReclaimReason("reviewer", null);
  assert.match(reviewer, /presumed dead/);
  assert.match(reviewer, /re-running the reviewer/);
  assert.doesNotMatch(reviewer, /branch|developer/);

  assert.match(presumedDeadReclaimReason("developer", null), /nothing on the branch to publish, re-running the developer/);
  assert.match(
    presumedDeadReclaimReason("developer", { branch: "issue-1", commits: 2, alreadyPushed: false }),
    /republishing 2 unpushed commits on issue-1/
  );
  assert.match(
    presumedDeadReclaimReason("developer", { branch: "issue-1", commits: 1, alreadyPushed: true }),
    /issue-1 is already on origin, re-verifying the PR/
  );
});

test("reasonForWorkerFailedEvent prefers explicit outcome.reason", () => {
  assert.equal(
    reasonForWorkerFailedEvent({
      outcome: { kind: "dirty_worktree", reason: "Cursor macOS keychain/auth died mid-run." },
      routeReason: "generic dirty",
    }),
    "Cursor macOS keychain/auth died mid-run."
  );
});

test("reasonForWorkerFailedEvent uses session errorJson for presumed dead", () => {
  assert.equal(
    reasonForWorkerFailedEvent({
      outcome: { kind: "session_failed" },
      sessionErrorJson: JSON.stringify({ reason: PRESUMED_DEAD_REASON }),
    }),
    PRESUMED_DEAD_REASON
  );
});
