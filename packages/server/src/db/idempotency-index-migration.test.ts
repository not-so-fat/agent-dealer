import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-idem-migrate-"));

const { migrate, getDb } = await import("./index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("../repository/issues.js");

test("migrate() upgrades a pre-fix non-unique idempotency index that already holds duplicates", () => {
  migrate();
  const db = getDb();
  const issue = createIssue({
    title: "T",
    repo: "/r",
    baseBranch: "main",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    maxReviewRounds: 3,
    source: "manual",
  });

  // Recreate the pre-fix world: non-unique index + duplicate provider keys.
  db.exec("DROP INDEX idx_workflow_events_idempotency");
  db.exec(
    "CREATE INDEX idx_workflow_events_idempotency ON workflow_events(idempotency_key) WHERE idempotency_key IS NOT NULL"
  );
  const insert = db.prepare(
    `INSERT INTO workflow_events (id, issue_id, type, actor_type, stage, idempotency_key, causation_event_id, ts)
     VALUES (?, ?, 'pull_request.updated', 'system', 'developing', ?, ?, ?)`
  );
  insert.run("e1", issue.id, "dup-key", null, "2026-01-01T00:00:00.000Z");
  insert.run("e2", issue.id, "dup-key", null, "2026-01-01T00:00:01.000Z");
  insert.run("e3", issue.id, "dup-key", null, "2026-01-01T00:00:02.000Z");
  insert.run("e4", issue.id, "other-key", null, "2026-01-01T00:00:03.000Z");
  // A downstream event whose recorded cause is a duplicate that will be discarded.
  insert.run("e5", issue.id, "later-key", "e2", "2026-01-01T00:00:04.000Z");
  // A duplicate row that itself points at another duplicate.
  insert.run("e6", issue.id, "dup-key", "e3", "2026-01-01T00:00:05.000Z");

  assert.doesNotThrow(() => migrate());

  // The first event recorded for the repeated key is kept; later copies dropped.
  const kept = db
    .prepare("SELECT id FROM workflow_events WHERE idempotency_key = 'dup-key' ORDER BY id")
    .all() as Array<{ id: string }>;
  assert.deepStrictEqual(kept.map((r) => r.id), ["e1"]);
  assert.equal(
    (db.prepare("SELECT COUNT(*) c FROM workflow_events WHERE idempotency_key = 'other-key'").get() as { c: number }).c,
    1
  );

  // Causality is remapped to the canonical event, not left dangling or dropped.
  assert.equal(
    (db.prepare("SELECT causation_event_id x FROM workflow_events WHERE id = 'e5'").get() as { x: string }).x,
    "e1"
  );
  // Every causation reference still resolves to a surviving event.
  assert.equal(
    (db
      .prepare(
        `SELECT COUNT(*) c FROM workflow_events e
         WHERE e.causation_event_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM workflow_events p WHERE p.id = e.causation_event_id)`
      )
      .get() as { c: number }).c,
    0
  );

  // The index is now unique and actually enforced.
  const idx = (db.prepare("PRAGMA index_list(workflow_events)").all() as Array<{ name: string; unique: number }>).find(
    (i) => i.name === "idx_workflow_events_idempotency"
  );
  assert.equal(idx?.unique, 1);
  assert.throws(() => insert.run("e5", issue.id, "dup-key", "2026-01-01T00:00:04.000Z"));

  // A second migrate() is a no-op (index already unique) and still starts cleanly.
  assert.doesNotThrow(() => migrate());
});
