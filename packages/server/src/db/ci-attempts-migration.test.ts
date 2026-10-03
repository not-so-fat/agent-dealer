// NOT-313: the CI-repair budget columns are added by separate `ALTER TABLE`
// statements, each guarded on its own presence (same lesson as the
// worker_sessions liveness columns in worker-session-pid-migration.test.ts): a
// kill between the two ALTERs must still repair on the next migrate().
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-ci-migrate-"));

const { migrate, getDb } = await import("./index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, getIssue } = await import("../repository/issues.js");

const CI_COLS = ["ci_attempts", "max_ci_attempts"]; // sorted: ciCols() sorts

const ciCols = (): string[] =>
  (getDb().prepare("PRAGMA table_info(issues)").all() as Array<{ name: string }>)
    .map((c) => c.name)
    .filter((c) => CI_COLS.includes(c))
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

test("migrate() adds both CI-budget columns to a DB that predates them, keeping every row", () => {
  migrate();
  const before = newIssueId();
  const rowCount = (getDb().prepare("SELECT COUNT(*) AS c FROM issues").get() as { c: number }).c;

  // A DB created before NOT-313.
  getDb().exec("ALTER TABLE issues DROP COLUMN max_ci_attempts");
  getDb().exec("ALTER TABLE issues DROP COLUMN ci_attempts");
  assert.deepStrictEqual(ciCols(), []);

  migrate();
  assert.deepStrictEqual(ciCols(), CI_COLS);

  // All rows survive with the defaults.
  assert.equal((getDb().prepare("SELECT COUNT(*) AS c FROM issues").get() as { c: number }).c, rowCount);
  const reread = getDb()
    .prepare("SELECT max_ci_attempts, ci_attempts FROM issues WHERE id = ?")
    .get(before) as { max_ci_attempts: number; ci_attempts: number };
  assert.equal(reread.max_ci_attempts, 3);
  assert.equal(reread.ci_attempts, 0);

  // The repository maps the backfilled columns, and new issues open with a full budget.
  const issue = getIssue(before)!;
  assert.equal(issue.maxCiAttempts, 3);
  assert.equal(issue.ciAttempts, 0);
  const fresh = getIssue(newIssueId())!;
  assert.equal(fresh.maxCiAttempts, 3);
  assert.equal(fresh.ciAttempts, 0);
});

test("migrate() repairs a half-applied CI upgrade instead of skipping it forever", () => {
  migrate();

  // Exactly the partial state a crash between the two ALTERs leaves behind.
  getDb().exec("ALTER TABLE issues DROP COLUMN ci_attempts");
  assert.deepStrictEqual(ciCols(), ["max_ci_attempts"]);

  migrate();

  assert.deepStrictEqual(ciCols(), CI_COLS, "the missing column is added");
  assert.doesNotThrow(() => newIssueId(), "issue inserts name the restored column");
});

test("migrate() is idempotent once both CI columns are present", () => {
  migrate();
  migrate();
  assert.deepStrictEqual(ciCols(), CI_COLS);
  assert.doesNotThrow(() => newIssueId());
});
