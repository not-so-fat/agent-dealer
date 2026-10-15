// scripts/ci-visual/fixtures.ts
//
// NOT-490: deterministic fixture states the public API cannot reach without a real
// agent run. Pure — returns the SQL the capture driver applies to the CI server's
// own SQLite file — so it is unit-testable in the builder sandbox.

export interface SqlStatement {
  sql: string;
  params: Array<string | number>;
}

/**
 * Moves a freshly created draft issue into an active, pre-decision `reviewing` state:
 * one open workflow instance, reviewer-owned, round 1, and no work items. Recovery
 * leaves exactly this shape alone (`recoverStrandedReviewing` skips an instance with
 * no work-item history), and no worker ever claims it, so the capture is stable.
 * The issue occupies the only admission slot, so a later queued fixture keeps waiting.
 */
export function activeReviewingFixture(issueId: string, instanceId: string, now: string): SqlStatement[] {
  return [
    {
      sql: "INSERT INTO workflow_instances (id, issue_id, workflow_version, started_at) VALUES (?, ?, 'v1', ?)",
      params: [instanceId, issueId, now],
    },
    {
      sql:
        "UPDATE issues SET status = 'reviewing', current_owner = 'reviewer', current_intent = ?, current_round = 1, updated_at = ? WHERE id = ?",
      params: ["Reviewing the PR (CI visual fixture)", now, issueId],
    },
  ];
}
