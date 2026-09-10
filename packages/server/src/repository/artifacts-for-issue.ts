import type { Artifact, ArtifactKind } from "@agent-dealer/shared";
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

function rowToArtifact(row: ArtifactRow): Artifact & { issueId: string | null; workerSessionId: string | null } {
  return {
    id: row.id,
    runId: "", // legacy field, unused for issue-linked artifacts — kept only so the Artifact shape still parses
    issueId: row.issue_id,
    workerSessionId: row.worker_session_id,
    kind: row.kind as ArtifactKind,
    contentJson: row.content_json,
    blobPath: row.blob_path,
    author: row.author as Artifact["author"],
    createdAt: row.created_at,
  };
}

export function listArtifactsForIssue(issueId: string, opts?: { limit?: number; before?: string }) {
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
