// packages/server/src/repository/review-publications.ts
//
// A one-row-per-work-item durable claim + result (NOT-62 review rounds 2-3), inserted
// atomically BEFORE the reviewer effect calls `gh pr review`. A `gh` review submission
// isn't naturally idempotent the way a `git push` is, and a read-only "does a review
// already exist" lookup alone is a check-then-publish race — two overlapping attempts on
// the same work item could both observe "not found" before either has published.
// Whichever attempt's insert wins the primary key is the only one allowed to publish;
// the loser fences on SQLite itself (not an in-process lock, so it also holds across a
// crash-and-restart), and — once the winner records its actual result — reports exactly
// what the winner published rather than its own independently-produced verdict, which a
// review round found could genuinely disagree with the winner's (two separate reviewer
// sessions are two separate model calls).
import { getDb } from "../db/index.js";

export type ReviewPublicationState = "claimed" | "published" | "failed";

export interface ReviewPublicationRow {
  workItemId: string;
  state: ReviewPublicationState;
  resultJson: string | null;
  event: string | null;
  usedCommentFallback: boolean;
}

interface ReviewPublicationDbRow {
  work_item_id: string;
  state: string;
  result_json: string | null;
  event: string | null;
  used_comment_fallback: number | null;
}

function rowFrom(raw: ReviewPublicationDbRow): ReviewPublicationRow {
  return {
    workItemId: raw.work_item_id,
    state: raw.state as ReviewPublicationState,
    resultJson: raw.result_json,
    event: raw.event,
    usedCommentFallback: raw.used_comment_fallback === 1,
  };
}

interface SqliteConstraintError {
  code?: string;
}

/** Returns true if this call won the claim and may proceed to publish; false if another attempt already holds or held it. */
export function claimReviewPublication(workItemId: string): boolean {
  const now = new Date().toISOString();
  try {
    getDb()
      .prepare("INSERT INTO review_publications (work_item_id, state, claimed_at, updated_at) VALUES (?, 'claimed', ?, ?)")
      .run(workItemId, now, now);
    return true;
  } catch (err) {
    if ((err as SqliteConstraintError).code === "SQLITE_CONSTRAINT_PRIMARYKEY") return false;
    throw err;
  }
}

export function getReviewPublication(workItemId: string): ReviewPublicationRow | null {
  const row = getDb().prepare("SELECT * FROM review_publications WHERE work_item_id = ?").get(workItemId) as
    | ReviewPublicationDbRow
    | undefined;
  return row ? rowFrom(row) : null;
}

/** Only the current claimant (state = 'claimed') may record a result — a stale writer can never overwrite one. */
export function recordReviewPublished(
  workItemId: string,
  input: { resultJson: string; event: string; usedCommentFallback: boolean }
): void {
  getDb()
    .prepare(
      "UPDATE review_publications SET state = 'published', result_json = ?, event = ?, used_comment_fallback = ?, updated_at = ? WHERE work_item_id = ? AND state = 'claimed'"
    )
    .run(input.resultJson, input.event, input.usedCommentFallback ? 1 : 0, new Date().toISOString(), workItemId);
}

export function recordReviewPublishFailed(workItemId: string): void {
  getDb()
    .prepare("UPDATE review_publications SET state = 'failed', updated_at = ? WHERE work_item_id = ? AND state = 'claimed'")
    .run(new Date().toISOString(), workItemId);
}

/**
 * Lets a new attempt retry publishing after a prior claimant recorded `failed` (it ran,
 * but its own `gh` call never succeeded) — a stale `claimed` row (the claimant crashed
 * before recording either outcome) is deliberately NOT reclaimable here; that case
 * surfaces as a human-visible `publish_failed` escalation instead of an automatic
 * takeover, matching this codebase's general policy of escalating rather than guessing
 * when a prior attempt's true fate is unknown.
 */
export function reclaimFailedReviewPublication(workItemId: string): boolean {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare("UPDATE review_publications SET state = 'claimed', claimed_at = ?, updated_at = ? WHERE work_item_id = ? AND state = 'failed'")
    .run(now, now, workItemId);
  return result.changes === 1;
}
