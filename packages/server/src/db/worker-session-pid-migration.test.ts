// NOT-124 review finding: the liveness columns are added by separate `ALTER TABLE`
// statements, each of which commits on its own. A process killed between them leaves the
// table half upgraded. Guarding them as a group on the first column's absence would then
// skip the block on every later migrate() while `createWorkerSession` still names the
// others — an INSERT that fails forever, with no path back short of hand-editing the DB.
//
// NOT-131 adds a third (`process_started_at`), which widens the same hazard rather than
// changing it: every real upgrade from a NOT-124 database IS the partial state, since the
// first two columns are already there. Each column stays independently guarded.
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

const LIVENESS_COLS = ["process_owner", "process_pid", "process_started_at"];

const pidCols = (): string[] =>
  (getDb().prepare("PRAGMA table_info(worker_sessions)").all() as Array<{ name: string }>)
    .map((c) => c.name)
    .filter((c) => LIVENESS_COLS.includes(c))
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

test("migrate() adds every liveness column to a DB that predates them", () => {
  migrate();
  assert.deepStrictEqual(pidCols(), LIVENESS_COLS);

  // A DB created before NOT-124.
  getDb().exec("ALTER TABLE worker_sessions DROP COLUMN process_pid");
  getDb().exec("ALTER TABLE worker_sessions DROP COLUMN process_owner");
  getDb().exec("ALTER TABLE worker_sessions DROP COLUMN process_started_at");
  assert.deepStrictEqual(pidCols(), []);

  migrate();
  assert.deepStrictEqual(pidCols(), LIVENESS_COLS);
  assertSessionInsertWorks();
});

test("migrate() upgrades a NOT-124 database, which already has the first two columns", () => {
  migrate();

  // The only partial state that actually ships: every existing install is here.
  getDb().exec("ALTER TABLE worker_sessions DROP COLUMN process_started_at");
  assert.deepStrictEqual(pidCols(), ["process_owner", "process_pid"]);

  migrate();

  assert.deepStrictEqual(pidCols(), LIVENESS_COLS, "the start-time column is added on its own");
  assertSessionInsertWorks();
});

test("rows that predate the start-time column read as NULL, never as evidence", () => {
  migrate();
  const id = createWorkerSession({
    issueId: newIssueId(),
    role: "developer",
    round: 1,
    agentId: BUILTIN_AGENT_CLAUDE_ID,
    runtime: null,
  }).id;
  // A session in flight across the upgrade: NOT-124 recorded a pid and an owner, and the
  // new column is NULL for it. processLiveness must read that as "unknown" (see
  // process-liveness.test.ts) rather than mistaking a stale pid for a live worker.
  getDb()
    .prepare("UPDATE worker_sessions SET process_pid = ?, process_owner = ? WHERE id = ?")
    .run(4242, "old-host:1:deadbeef", id);
  const row = getDb()
    .prepare("SELECT process_pid, process_owner, process_started_at FROM worker_sessions WHERE id = ?")
    .get(id) as { process_pid: number; process_owner: string; process_started_at: string | null };
  assert.equal(row.process_pid, 4242);
  assert.equal(row.process_started_at, null);
});

test("migrate() repairs a half-applied upgrade instead of skipping it forever", () => {
  migrate();

  // Exactly the partial state a crash between the two ALTERs leaves behind: the first
  // column landed, the second did not.
  getDb().exec("ALTER TABLE worker_sessions DROP COLUMN process_owner");
  assert.deepStrictEqual(pidCols(), ["process_pid", "process_started_at"]);

  migrate();

  assert.deepStrictEqual(pidCols(), LIVENESS_COLS, "the missing column is added");
  assertSessionInsertWorks();
});

test("migrate() repairs the mirror-image partial state too", () => {
  migrate();
  getDb().exec("ALTER TABLE worker_sessions DROP COLUMN process_pid");
  assert.deepStrictEqual(pidCols(), ["process_owner", "process_started_at"]);

  migrate();

  assert.deepStrictEqual(pidCols(), LIVENESS_COLS);
  assertSessionInsertWorks();
});

test("migrate() is idempotent once every column is present", () => {
  migrate();
  migrate();
  assert.deepStrictEqual(pidCols(), LIVENESS_COLS);
  assertSessionInsertWorks();
});

// NOT-181: usage_events.model is added to databases created before it existed, and stays NULL there.
test("usage_events.model is added on migrate() to a table that lacks it", () => {
  const cols = () =>
    (getDb().prepare("PRAGMA table_info(usage_events)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(cols().includes("model"));
  getDb().exec("ALTER TABLE usage_events DROP COLUMN model");
  assert.equal(cols().includes("model"), false);
  migrate();
  assert.ok(cols().includes("model"));
});
