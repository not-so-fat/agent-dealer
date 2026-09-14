import type { IssueArtifact } from "@agent-dealer/shared";
import { getDb } from "../db/index.js";

interface ArtifactRow {
  id: string;
  issue_id: string | null;
  worker_session_id: string | null;
  kind: string;
  content_json: string | null;
  blob_path: string | null;
  author: string;
  created_at: string;
}

function rowToArtifact(row: ArtifactRow): IssueArtifact {
  return {
    id: row.id,
    issueId: row.issue_id,
    workerSessionId: row.worker_session_id,
    kind: row.kind,
    contentJson: row.content_json,
    blobPath: row.blob_path,
    author: row.author as IssueArtifact["author"],
    createdAt: row.created_at,
  };
}

/** Scoped to the issue so a caller can't fetch an artifact belonging to a different
 * issue by guessing/incrementing an id — used by the raw-trace route. */
export function getIssueArtifact(issueId: string, artifactId: string): IssueArtifact | null {
  const row = getDb()
    .prepare("SELECT * FROM artifacts WHERE id = ? AND issue_id = ?")
    .get(artifactId, issueId) as ArtifactRow | undefined;
  return row ? rowToArtifact(row) : null;
}

export function listArtifactsForIssue(
  issueId: string,
  opts?: { limit?: number; before?: string }
): IssueArtifact[] {
  const limit = opts?.limit ?? 50;
  const rows = opts?.before
    ? (getDb()
        .prepare("SELECT * FROM artifacts WHERE issue_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?")
        .all(issueId, opts.before, limit) as ArtifactRow[])
    : (getDb()
        .prepare("SELECT * FROM artifacts WHERE issue_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(issueId, limit) as ArtifactRow[]);
  return rows.map(rowToArtifact);
}

/** Every artifact of `kind` for the issue, unbounded — unlike `listArtifactsForIssue`'s
 * newest-first `limit` window, filtering by kind in SQL means a caller that needs "all
 * artifacts of this kind ever recorded" (e.g. reflect-trigger's already-proposed-playbook
 * scan) can't have an old row fall outside the window on an artifact-heavy issue. */
export function listArtifactsForIssueByKind(issueId: string, kind: string): IssueArtifact[] {
  const rows = getDb()
    .prepare("SELECT * FROM artifacts WHERE issue_id = ? AND kind = ? ORDER BY created_at DESC")
    .all(issueId, kind) as ArtifactRow[];
  return rows.map(rowToArtifact);
}
