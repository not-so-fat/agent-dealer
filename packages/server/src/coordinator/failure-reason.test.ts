// packages/server/src/coordinator/failure-reason.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

function writeLog(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-fail-reason-"));
  const logPath = path.join(dir, "session.ndjson");
  fs.writeFileSync(logPath, body);
  return logPath;
}

test("classifyRunnerLogFailure maps keychain stderr trailer to auth/keychain reason", () => {
  const logPath = writeLog(`{"type":"assistant"}\n--- stderr ---\n${KEYCHAIN_STDERR}`);
  const reason = classifyRunnerLogFailure(logPath);
  assert.ok(reason);
  assert.match(reason!, /keychain|errSecDuplicateItem/i);
  assert.match(reason!, /auth/i);
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
