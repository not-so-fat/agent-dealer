// Regression test for the bug `npm run dev` hit against any database that ran migrate()
// between NOT-93 (introduced `authority_attempts`) and NOT-91 (added its `stale_at`
// column + an index on it): schema.sql's own `CREATE INDEX idx_authority_attempts_stale
// ON authority_attempts(status, stale_at)` threw "no such column: stale_at" against the
// pre-existing table, aborting migrate() before it ever reached the incremental-ALTER
// section below it — see db/index.ts's pre-schema.sql guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-authattempt-migrate-"));

const { migrate, getDb } = await import("./index.js");

test("migrate() upgrades a pre-NOT-91 authority_attempts table that has no stale_at column", () => {
  migrate();
  const db = getDb();

  // Recreate the pre-NOT-91 world: the table and its two original indexes, but without
  // stale_at or the index on it — exactly what a database that last ran migrate() between
  // NOT-93 and NOT-91 landing would have.
  db.exec(`
    DROP INDEX IF EXISTS idx_authority_attempts_owner;
    DROP INDEX IF EXISTS idx_authority_attempts_stale;
    DROP INDEX IF EXISTS idx_authority_attempts_status;
    DROP TABLE authority_attempts;
    CREATE TABLE authority_attempts (
      id TEXT PRIMARY KEY,
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      authority_id TEXT,
      deck_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      ttl_ms INTEGER NOT NULL,
      tool_scope_hint_json TEXT,
      status TEXT NOT NULL,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_authority_attempts_owner ON authority_attempts(owner_kind, owner_id);
    CREATE INDEX idx_authority_attempts_status ON authority_attempts(status);
  `);
  const preFixCols = db.prepare("PRAGMA table_info(authority_attempts)").all() as Array<{ name: string }>;
  assert.ok(!preFixCols.some((c) => c.name === "stale_at"), "test setup must reproduce the pre-fix table exactly");

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO authority_attempts (id, owner_kind, owner_id, idempotency_key, deck_id, run_id, attempt_id, ttl_ms, status, created_at, updated_at)
     VALUES ('a1', 'developer', 'issue-1:developer', 'a1:1', 'deck-1', 'run-1', 'a1', 60000, 'acquiring', ?, ?)`
  ).run(now, now);

  // This is the actual regression: pre-fix, this throws "no such column: stale_at" from
  // schema.sql's own CREATE INDEX, before ever reaching an incremental ALTER.
  assert.doesNotThrow(() => migrate());

  const cols = db.prepare("PRAGMA table_info(authority_attempts)").all() as Array<{ name: string }>;
  assert.ok(cols.some((c) => c.name === "stale_at"), "stale_at must exist after migrate()");

  // The pre-existing row survived the migration untouched.
  const row = db.prepare("SELECT stale_at FROM authority_attempts WHERE id = 'a1'").get() as { stale_at: string | null };
  assert.equal(row.stale_at, null);

  // The stale-tracking index now exists and is actually usable.
  db.exec("UPDATE authority_attempts SET stale_at = '2026-01-01T00:00:00.000Z' WHERE id = 'a1'");
  const staleRows = db
    .prepare("SELECT id FROM authority_attempts WHERE status = 'acquiring' AND stale_at IS NOT NULL")
    .all() as Array<{ id: string }>;
  assert.deepEqual(staleRows.map((r) => r.id), ["a1"]);

  // A second migrate() is a no-op (column already present) and still starts cleanly.
  assert.doesNotThrow(() => migrate());
});
