// packages/server/src/repository/review-publications.ts
//
// A one-row-per-work-item durable claim (NOT-62 review round 2), inserted atomically
// BEFORE the reviewer effect calls `gh pr review`. A `gh` review submission isn't
// naturally idempotent the way a `git push` is, and a read-only "does a review already
// exist" lookup alone is a check-then-publish race — two overlapping attempts on the
// same work item could both observe "not found" before either has published. Whichever
// attempt's insert wins the primary key is the only one allowed to publish; the loser's
// insert fails immediately (fenced by SQLite itself, not by an in-process lock, so it
// also holds across a crash-and-restart).
import { getDb } from "../db/index.js";

interface SqliteConstraintError {
  code?: string;
}

/** Returns true if this call won the claim and may proceed to publish; false if another attempt already holds it. */
export function claimReviewPublication(workItemId: string): boolean {
  try {
    getDb()
      .prepare("INSERT INTO review_publications (work_item_id, claimed_at) VALUES (?, ?)")
      .run(workItemId, new Date().toISOString());
    return true;
  } catch (err) {
    if ((err as SqliteConstraintError).code === "SQLITE_CONSTRAINT_PRIMARYKEY") return false;
    throw err;
  }
}
