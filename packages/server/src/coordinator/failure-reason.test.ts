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
