// scripts/migrate-to-issues.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigration, isServiceRunning } from "./migrate-to-issues.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const legacySchemaPath = path.join(__dirname, "..", "packages", "server", "src", "db", "schema.sql");

function seedLegacyDb(): string {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dealer-migration-")), "dealer.db");
  const db = new Database(dbPath);
  db.exec(fs.readFileSync(legacySchemaPath, "utf8"));
  // A real production dealer.db always has these via migrate()'s additive ALTER (see
  // packages/server/src/db/index.ts) before this script ever runs against it — schema.sql
  // alone doesn't carry them, matching this repo's established additive-column convention.
  db.exec("ALTER TABLE artifacts ADD COLUMN issue_id TEXT REFERENCES issues(id)");
  db.exec("ALTER TABLE artifacts ADD COLUMN worker_session_id TEXT REFERENCES worker_sessions(id)");
  const now = "2026-01-01T00:00:00.000Z";
  db.prepare(
    `INSERT INTO agents (id, name, runtime, is_builtin, created_at, updated_at)
     VALUES ('agent-1', 'Claude', 'claude_code', 0, ?, ?)`
  ).run(now, now);

  // Lineage A: one completed run — should migrate to an issue with status 'done'.
  db.prepare(
    `INSERT INTO runs (id, source, external_id, task_category, title, repo, agent_id, status,
      lineage_id, created_at, updated_at)
     VALUES ('run-a1', 'manual', 'run-a1', 'code', 'Done task', '/repo', 'agent-1', 'done',
      NULL, ?, ?)`
  ).run(now, now);
  db.prepare(
    `INSERT INTO artifacts (id, run_id, kind, content_json, author, created_at)
     VALUES ('art-a1', 'run-a1', 'execution_result', '{"exitCode":0}', 'agent', ?)`
  ).run(now);
  db.prepare(
    `INSERT INTO events (id, run_id, type, payload_json, ts) VALUES ('evt-a1', 'run-a1', 'run.created', NULL, ?)`
  ).run(now);

  // Lineage B: two runs sharing a lineage_id, latest is plan_pending — should migrate to
  // one issue with status 'ready' and no active workflow, legacy session status 'cancelled'.
  db.prepare(
    `INSERT INTO runs (id, source, external_id, task_category, title, repo, agent_id, status,
      lineage_id, created_at, updated_at)
     VALUES ('run-b1', 'manual', 'run-b1', 'code', 'Retried task', '/repo', 'agent-1', 'failed',
      NULL, ?, ?)`
  ).run(now, now);
  db.prepare(
    `INSERT INTO runs (id, source, external_id, task_category, title, repo, agent_id, status,
      lineage_id, created_at, updated_at)
     VALUES ('run-b2', 'manual', 'run-b2', 'code', 'Retried task', '/repo', 'agent-1', 'plan_pending',
      'run-b1', ?, ?)`
  ).run(now, now);

  db.close();
  return dbPath;
}

test("creates one issue per lineage, preserves artifacts/events, and renames legacy tables", () => {
  const dbPath = seedLegacyDb();
  const report = runMigration(dbPath, { skipServiceCheck: true });
  assert.deepStrictEqual(report.mismatches, []);
  assert.equal(report.issuesCreated, 2);
  assert.equal(report.legacySessionsCreated, 3); // run-a1, run-b1, run-b2
  assert.equal(report.artifactsRepointed, 1);
  assert.equal(report.eventsRepointed, 1);

  const db = new Database(dbPath, { readonly: true });
  const issues = db.prepare("SELECT status FROM issues").all() as Array<{ status: string }>;
  const statuses = issues.map((i) => i.status).sort();
  assert.deepStrictEqual(statuses, ["done", "ready"]);

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
    name: string;
  }>;
  const names = tables.map((t) => t.name);
  assert.ok(names.includes("legacy_v0_runs"));
  assert.equal(names.includes("runs"), false);

  const legacySessions = db.prepare("SELECT status FROM worker_sessions WHERE role = 'legacy'").all() as Array<{
    status: string;
  }>;
  assert.ok(legacySessions.some((s) => s.status === "done"));
  assert.ok(legacySessions.some((s) => s.status === "cancelled"));

  // Reviewer finding #4: migrated artifacts must be reachable via the exact query the live
  // API uses (listArtifactsForIssue queries "artifacts" by issue_id) — not just "somewhere
  // in the database" post-rename. Also confirm the staging table doesn't linger.
  assert.equal(names.includes("artifacts"), true);
  assert.equal(names.includes("artifacts_migrated"), false);
  const doneIssue = db.prepare("SELECT id FROM issues WHERE status = 'done'").get() as { id: string };
  const reachable = db.prepare("SELECT kind FROM artifacts WHERE issue_id = ?").all(doneIssue.id) as Array<{ kind: string }>;
  assert.equal(reachable.length, 1);
  assert.equal(reachable[0].kind, "execution_result");
  db.close();
});

test("rolls back and leaves the original tables untouched when a lineage_id points nowhere", () => {
  const dbPath = seedLegacyDb();
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO runs (id, source, external_id, task_category, title, repo, agent_id, status,
      lineage_id, created_at, updated_at)
     VALUES ('run-orphan', 'manual', 'run-orphan', 'code', 'Orphan', '/repo', 'agent-1', 'done',
      'does-not-exist', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run();
  db.close();

  const report = runMigration(dbPath, { skipServiceCheck: true });
  assert.ok(report.mismatches.length > 0);

  const after = new Database(dbPath, { readonly: true });
  const tables = after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
    name: string;
  }>;
  assert.ok(tables.map((t) => t.name).includes("runs")); // untouched — rollback happened
  after.close();
});

// Data-safety follow-up from the PR review: the stopped-service guard previously checked a
// "dealer.lock" file this codebase never creates, so it never actually guarded anything.
// isServiceRunning() replaces it with a real check against run.json (mirroring
// packages/cli/src/runtime-state.ts's RunState + isProcessAlive).
test("isServiceRunning: no run.json means not running", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-liveness-"));
  const dbPath = path.join(dir, "dealer.db");
  fs.writeFileSync(dbPath, "");
  assert.equal(isServiceRunning(dbPath).running, false);
});

test("isServiceRunning: run.json with a dead pid means not running", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-liveness-"));
  const dbPath = path.join(dir, "dealer.db");
  fs.writeFileSync(dbPath, "");
  // PID 999999 is picked to be implausibly alive on any normal dev/CI machine.
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ serverPid: 999999, port: 2221 }));
  assert.equal(isServiceRunning(dbPath).running, false);
});

test("isServiceRunning: run.json with a live pid means running", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-liveness-"));
  const dbPath = path.join(dir, "dealer.db");
  fs.writeFileSync(dbPath, "");
  // This test process's own pid is guaranteed alive for the duration of the assertion.
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ serverPid: process.pid, port: 2221 }));
  const result = isServiceRunning(dbPath);
  assert.equal(result.running, true);
  assert.ok(result.detail?.includes(String(process.pid)));
});
