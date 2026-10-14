// NOT-489: a clean install's `issues.auto_merge` column defaults on, while an upgrade
// never rewrites an existing issue's stored choice — and new creates on the upgraded
// database still take the shared `CreateIssueInput` default (true), not the column's.
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-auto-merge-migrate-"));

const { migrate, getDb } = await import("./index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, getIssue } = await import("../repository/issues.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const autoMergeDefault = (db: Database.Database): string | null =>
  (db.prepare("PRAGMA table_info(issues)").all() as Array<{ name: string; dflt_value: string | null }>).find(
    (c) => c.name === "auto_merge"
  )!.dflt_value;

const storedAutoMerge = (id: string): number =>
  (getDb().prepare("SELECT auto_merge FROM issues WHERE id = ?").get(id) as { auto_merge: number }).auto_merge;

function newIssueId(autoMerge?: boolean): string {
  return createIssue({
    title: "T",
    repo: "github.com/acme/app",
    baseBranch: "main",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
    ...(autoMerge === undefined ? {} : { autoMerge }),
  }).id;
}

test("a clean schema defaults auto_merge on", () => {
  const db = new Database(":memory:");
  db.exec(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
  assert.equal(autoMergeDefault(db), "1");
});

test("upgrading preserves every stored auto_merge value; post-upgrade omitted-field creates still get true", () => {
  migrate();
  const optedOut = newIssueId(false);
  const optedIn = newIssueId(true);

  // An upgraded database whose column predates NOT-489 (still DEFAULT 0).
  getDb().exec("ALTER TABLE issues DROP COLUMN auto_merge");
  getDb().exec("ALTER TABLE issues ADD COLUMN auto_merge INTEGER NOT NULL DEFAULT 0");
  getDb().prepare("UPDATE issues SET auto_merge = 1 WHERE id = ?").run(optedIn);
  assert.equal(autoMergeDefault(getDb()), "0");

  migrate();

  assert.equal(storedAutoMerge(optedOut), 0, "a pre-existing false row is not rewritten");
  assert.equal(getIssue(optedOut)!.autoMerge, false);
  assert.equal(storedAutoMerge(optedIn), 1);

  const fresh = newIssueId();
  assert.equal(storedAutoMerge(fresh), 1, "an omitted-field create on the upgraded DB stores true");
  assert.equal(getIssue(fresh)!.autoMerge, true);
});
