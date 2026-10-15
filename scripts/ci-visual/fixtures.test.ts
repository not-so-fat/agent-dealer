// NOT-490: the active pre-decision fixture applies cleanly to the real schema and
// leaves the shape recovery and the worker loop never touch.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { activeReviewingFixture } from "./fixtures.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("activeReviewingFixture opens one workflow instance and moves the issue to reviewing", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(fs.readFileSync(join(root, "packages/server/src/db/schema.sql"), "utf8"));
  db.exec(`INSERT INTO agents (id, name, runtime, created_at, updated_at) VALUES ('a', 'a', 'claude_local', 'n', 'n')`);
  db.prepare(
    `INSERT INTO issues (id, source, title, repo, base_branch, status, current_owner, developer_agent_id, reviewer_agent_id, created_at, updated_at)
     VALUES ('i1', 'manual', 't', 'github.com/o/r', 'main', 'ready', 'human', 'a', 'a', 'n', 'n')`
  ).run();
  for (const { sql, params } of activeReviewingFixture("i1", "w1", "2026-10-14T00:00:00.000Z")) {
    db.prepare(sql).run(...params);
  }
  const issue = db.prepare("SELECT status, current_owner, current_round FROM issues WHERE id = 'i1'").get() as Record<string, unknown>;
  assert.deepEqual({ ...issue }, { status: "reviewing", current_owner: "reviewer", current_round: 1 });
  const instances = db.prepare("SELECT id, completed_at FROM workflow_instances WHERE issue_id = 'i1'").all();
  assert.deepEqual(instances.map((r) => ({ ...r })), [{ id: "w1", completed_at: null }]);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM work_items").get() as { n: number }).n, 0);
});
