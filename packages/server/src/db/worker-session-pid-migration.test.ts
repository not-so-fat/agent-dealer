// NOT-124 review finding: the two liveness columns are added by separate `ALTER TABLE`
// statements, each of which commits on its own. A process killed between them leaves the
// table half upgraded. Guarding the pair on the first column's absence would then skip the
// block on every later migrate() while `createWorkerSession` still names the second — an
// INSERT that fails forever, with no path back short of hand-editing the DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-pid-migrate-"));

const { migrate, getDb } = await import("./index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("../repository/issues.js");
const { createWorkerSession } = await import("../repository/worker-sessions.js");

const pidCols = (): string[] =>
  (getDb().prepare("PRAGMA table_info(worker_sessions)").all() as Array<{ name: string }>)
    .map((c) => c.name)
    .filter((c) => c === "process_pid" || c === "process_owner")
    .sort();

function newIssueId(): string {
  return createIssue({
    title: "T",
    repo: "/r",
    baseBranch: "main",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
  }).id;
}

/** A session insert names every column, so it is the real test of a complete upgrade. */
function assertSessionInsertWorks(): void {
  assert.doesNotThrow(() =>
    createWorkerSession({
      issueId: newIssueId(),
      role: "developer",
      round: 1,
      agentId: BUILTIN_AGENT_CLAUDE_ID,
      runtime: null,
    })
  );
}

test("migrate() adds both liveness columns to a DB that predates them", () => {
  migrate();
  assert.deepStrictEqual(pidCols(), ["process_owner", "process_pid"]);

  // A DB created before NOT-124.
  getDb().exec("ALTER TABLE worker_sessions DROP COLUMN process_pid");
  getDb().exec("ALTER TABLE worker_sessions DROP COLUMN process_owner");
  assert.deepStrictEqual(pidCols(), []);

  migrate();
  assert.deepStrictEqual(pidCols(), ["process_owner", "process_pid"]);
  assertSessionInsertWorks();
});

test("migrate() repairs a half-applied upgrade instead of skipping it forever", () => {
  migrate();

  // Exactly the partial state a crash between the two ALTERs leaves behind: the first
  // column landed, the second did not.
  getDb().exec("ALTER TABLE worker_sessions DROP COLUMN process_owner");
  assert.deepStrictEqual(pidCols(), ["process_pid"]);

  migrate();

  assert.deepStrictEqual(pidCols(), ["process_owner", "process_pid"], "the missing column is added");
  assertSessionInsertWorks();
});

test("migrate() repairs the mirror-image partial state too", () => {
  migrate();
  getDb().exec("ALTER TABLE worker_sessions DROP COLUMN process_pid");
  assert.deepStrictEqual(pidCols(), ["process_owner"]);

  migrate();

  assert.deepStrictEqual(pidCols(), ["process_owner", "process_pid"]);
  assertSessionInsertWorks();
});

test("migrate() is idempotent once both columns are present", () => {
  migrate();
  migrate();
  assert.deepStrictEqual(pidCols(), ["process_owner", "process_pid"]);
  assertSessionInsertWorks();
});
