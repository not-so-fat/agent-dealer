import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-artifact-cols-"));

const { migrate, getDbPath } = await import("./index.js");

test("migrate() adds issue_id and worker_session_id to the legacy artifacts table", () => {
  migrate();
  const db = new Database(getDbPath(), { readonly: true });
  const cols = db.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>;
  const names = cols.map((c) => c.name);
  assert.ok(names.includes("issue_id"), "expected artifacts.issue_id to exist");
  assert.ok(names.includes("worker_session_id"), "expected artifacts.worker_session_id to exist");
  assert.ok(names.includes("run_id"), "run_id must remain for legacy rows");
  db.close();
});
