// packages/server/src/repository/review-publications.ts
//
// A one-row-per-work-item durable claim + result (NOT-62 review rounds 2-4), inserted
// atomically BEFORE the reviewer effect calls `gh pr review`. A `gh` review submission
// isn't naturally idempotent the way a `git push` is, and a read-only "does a review
// already exist" lookup alone is a check-then-publish race — two overlapping attempts on
// the same work item could both observe "not found" before either has published.
//
// The claim is gated on the SAME lease token the work-item kernel already uses (round 4):
// every write here requires the caller's `leaseToken` to still equal the live
// `work_items.lease_token`, with `status = 'leased'` AND `lease_expires_at` still in the
// future (round 5 — `status` alone lags reality: a work item sits at `status = 'leased'`
// with its old token for the whole window between the lease actually expiring and
// recovery's next sweep reclaiming it, and an attempt resuming inside that window is not
// "live" just because no one has swept it yet), checked in the same statement as the
// write. A zombie whose lease has already expired or been reclaimed can therefore never
// win — or reclaim — this claim, no matter how the two attempts' wall-clock timing
// happens to fall; only whichever attempt currently holds the work item's one *unexpired*
// lease token ever can. Without this, an earlier design let a slower-but-still-"leased"
// zombie win the claim ahead of the actual current lease holder, which would then time
// out waiting and apply `publish_failed` as the workflow's terminal decision while the
// zombie went on to actually publish moments later — the exact "GitHub and workflow
// state disagree" failure mode this table exists to prevent. Once the winner records its
// actual result, a loser reports exactly that (never its own independently-produced
// verdict, which two separate reviewer sessions really can disagree on).
//
// Round 6: checking the lease is only "live" at the instant of claiming isn't enough —
// nothing stopped the underlying lease from expiring, and recovery reclaiming it to a
// new attempt, WHILE the `gh pr review` call granted by this claim is still in flight.
// So granting a claim now ALSO atomically extends the work item's lease
// (`PUBLICATION_LEASE_EXTENSION_MS`) in the same transaction as the claim itself —
// recovery's own reclaim query (`work_items.lease_expires_at < now`) is a single
// statement too, so the two can never interleave: either recovery's reclaim commits
// first (and this claim's own live-lease check then correctly fails) or this claim's
// extension commits first (and recovery's reclaim then correctly does not match). The
// ambient per-tick heartbeat (`worker-loop.ts`) would ordinarily keep re-extending the
// lease throughout anyway on a healthy process, but that protection is incidental to
// this table; the extension here makes holding the claim its own explicit, structural
// guarantee for the whole publish operation, not something borrowed from unrelated
// machinery timing.
import { getDb } from "../db/index.js";

const num = (name: string, dflt: number): number => Number(process.env[name] ?? dflt);

/**
 * How long a granted claim guarantees the underlying lease stays valid for — must
 * comfortably exceed how long a real `gh pr review` call can take. Deliberately much
 * longer than the work-item kernel's own default per-heartbeat `leaseMs` (60s): this is
 * a one-shot grant at claim time, not refreshed on a timer the way the heartbeat is.
 */
function publicationLeaseExtensionMs(): number {
  return num("REVIEWER_PUBLISH_LEASE_EXTENSION_MS", 5 * 60_000);
}

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

/**
 * True only while `leaseToken` is still the work item's current, ACTUALLY-active lease
 * — `status = 'leased'` on its own is not enough (it lags an expiry that recovery hasn't
 * swept yet); `lease_expires_at` must still be in the future too.
 */
const STILL_LEASED = `EXISTS (
  SELECT 1 FROM work_items
  WHERE id = @work_item_id AND lease_token = @lease_token AND status = 'leased' AND lease_expires_at > @now
)`;

/**
 * Extends `workItemId`'s lease so it cannot expire (and so be reclaimed by recovery)
 * before `publicationLeaseExtensionMs()` has elapsed. Re-checks the live-lease condition
 * itself — a caller only extends a lease it is actually the current, live holder of.
 * Must be called from inside the same transaction as the claim/reclaim grant it protects.
 */
function extendLeaseForPublication(workItemId: string, leaseToken: string, now: string): void {
  const expires = new Date(Date.parse(now) + publicationLeaseExtensionMs()).toISOString();
  getDb()
    .prepare("UPDATE work_items SET lease_expires_at = @expires, updated_at = @now WHERE id = @work_item_id AND lease_token = @lease_token AND status = 'leased'")
    .run({ work_item_id: workItemId, lease_token: leaseToken, expires, now });
}

/**
 * Returns true if this call won the claim and may proceed to publish. False either
 * because another attempt already holds/held it, or because `leaseToken` is no longer
 * the work item's current lease (this attempt is itself the zombie — it must not
 * publish regardless of who else is racing it). Winning atomically extends the
 * underlying work-item lease (see module doc) so recovery cannot reclaim it out from
 * under the `gh` call this grant is about to allow.
 */
export function claimReviewPublication(workItemId: string, leaseToken: string): boolean {
  const now = new Date().toISOString();
  return getDb().transaction(() => {
    const result = getDb()
      .prepare(`
        INSERT INTO review_publications (work_item_id, state, claimed_at, updated_at)
        SELECT @work_item_id, 'claimed', @now, @now
        WHERE NOT EXISTS (SELECT 1 FROM review_publications WHERE work_item_id = @work_item_id)
          AND ${STILL_LEASED}
      `)
      .run({ work_item_id: workItemId, lease_token: leaseToken, now });
    if (result.changes !== 1) return false;
    extendLeaseForPublication(workItemId, leaseToken, now);
    return true;
  })();
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
 * but its own `gh` call never succeeded) — gated on the same live lease check as
 * `claimReviewPublication`, so only the work item's current holder can ever reclaim.
 *
 * A stale `claimed` row (the claimant crashed between `gh` succeeding and this table
 * being updated) is deliberately NOT reclaimable at all, by anyone, ever — surfacing
 * instead as a human-visible `publish_failed` escalation. This is a known, accepted gap
 * (a review already posted to GitHub could in that narrow case go unrecorded here): it
 * fails toward a human double-checking an already-safe state rather than toward an
 * automatic decision this code cannot actually verify is safe, matching this codebase's
 * general policy of escalating, not guessing, when a prior attempt's true fate is
 * unknown (see `profile-snapshot.ts`'s `PermissionPolicy` doc comment for the same
 * reasoning applied elsewhere).
 */
export function reclaimFailedReviewPublication(workItemId: string, leaseToken: string): boolean {
  const now = new Date().toISOString();
  return getDb().transaction(() => {
    const result = getDb()
      .prepare(`
        UPDATE review_publications
        SET state = 'claimed', claimed_at = @now, updated_at = @now
        WHERE work_item_id = @work_item_id AND state = 'failed'
          AND ${STILL_LEASED}
      `)
      .run({ work_item_id: workItemId, lease_token: leaseToken, now });
    if (result.changes !== 1) return false;
    extendLeaseForPublication(workItemId, leaseToken, now);
    return true;
  })();
}
