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
