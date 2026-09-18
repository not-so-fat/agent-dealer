// packages/server/src/coordinator/sync-issue-base-branch.ts
//
// Shared by developer and reviewer effects: keep issue.baseBranch + frozen task_snapshot
// aligned with resolveCheckoutBaseBranch so prompts, baseRefCandidates, and the Issues UI
// all see the same base the PR was cut from.
import type { Issue } from "@agent-dealer/shared";
import { getTaskSnapshot, TASK_SNAPSHOT_ARTIFACT_KIND } from "./commands.js";
import { createIssueArtifact } from "../repository/artifacts.js";
import { updateIssue } from "../repository/issues.js";

export function syncIssueBaseBranch(issue: Issue, resolved: string): void {
  if (issue.baseBranch === resolved) return;
  updateIssue(issue.id, { baseBranch: resolved });
  issue.baseBranch = resolved;
  const snap = getTaskSnapshot(issue);
  if (snap.baseBranch === resolved) return;
  createIssueArtifact({
    issueId: issue.id,
    kind: TASK_SNAPSHOT_ARTIFACT_KIND,
    author: "system",
    content: { ...snap, baseBranch: resolved },
  });
}
