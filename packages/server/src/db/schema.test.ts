import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);
  return db;
}

const EXPECTED_TABLES = [
  "issues",
  "worker_sessions",
  "workflow_instances",
  "workflow_events",
  "human_actions",
  "findings",
  "usage_events",
  "work_items",
];

test("schema creates every issue-centric table", () => {
  const db = freshDb();
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
    name: string;
  }>;
  const names = rows.map((r) => r.name);
  for (const t of EXPECTED_TABLES) {
    assert.ok(names.includes(t), `expected table ${t} to exist`);
  }
});

test("schema enforces at most one active workflow_instance per issue", () => {
  const db = freshDb();
  db.exec(`
    INSERT INTO agents (id, name, runtime, is_builtin, created_at, updated_at)
    VALUES ('a1', 'A', 'claude_code', 0, '2026-01-01', '2026-01-01');
  `);
  db.prepare(
    `INSERT INTO issues (id, source, title, repo, base_branch, status, current_owner,
      max_review_rounds, current_round, created_at, updated_at)
     VALUES ('i1', 'manual', 'T', '/r', 'main', 'ready', 'system', 3, 1, '2026-01-01', '2026-01-01')`
  ).run();
  db.prepare(
    `INSERT INTO workflow_instances (id, issue_id, workflow_version, started_at, outcome)
     VALUES ('w1', 'i1', 'dev_reviewer_v1', '2026-01-01', NULL)`
  ).run();
  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO workflow_instances (id, issue_id, workflow_version, started_at, outcome)
         VALUES ('w2', 'i1', 'dev_reviewer_v1', '2026-01-01', NULL)`
      )
      .run()
  );
});

test("schema enforces at most one non-terminal work_item per workflow instance", () => {
  const db = freshDb();
  db.exec(`
    INSERT INTO agents (id, name, runtime, is_builtin, created_at, updated_at)
    VALUES ('a1', 'A', 'claude_code', 0, '2026-01-01', '2026-01-01');
  `);
  db.prepare(
    `INSERT INTO issues (id, source, title, repo, base_branch, status, current_owner,
      max_review_rounds, current_round, created_at, updated_at)
     VALUES ('i1', 'manual', 'T', '/r', 'main', 'developing', 'developer', 3, 1, '2026-01-01', '2026-01-01')`
  ).run();
  db.prepare(
    `INSERT INTO workflow_instances (id, issue_id, workflow_version, started_at, outcome)
     VALUES ('w1', 'i1', 'dev_reviewer_v1', '2026-01-01', NULL)`
  ).run();
  const insertItem = (id: string) =>
    db
      .prepare(
        `INSERT INTO work_items (id, issue_id, workflow_instance_id, kind, round, status,
          available_at, created_at, updated_at)
         VALUES (?, 'i1', 'w1', 'developer', 1, 'pending', '2026-01-01', '2026-01-01', '2026-01-01')`
      )
      .run(id);
  insertItem("k1");
  assert.throws(() => insertItem("k2"));
});
