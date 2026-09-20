// packages/server/src/repository/artifacts.ts
//
// Write side for issue-scoped artifacts. `artifacts-for-issue.ts` only ever read this
// table (issue_id/worker_session_id columns added additively by migrate(), see
// db/index.ts) — nothing wrote an issue-scoped row until NOT-61 needed one for the frozen
// task snapshot and the developer's implementation conclusion.
import { v4 as uuid } from "uuid";
import type { IssueArtifact } from "@agent-dealer/shared";
import { getDb } from "../db/index.js";

export interface CreateIssueArtifactInput {
  issueId: string;
  workerSessionId?: string | null;
  kind: string;
  content?: unknown;
  blobPath?: string | null;
  author: IssueArtifact["author"];
}

export function createIssueArtifact(input: CreateIssueArtifactInput): IssueArtifact {
  const id = uuid();
  const now = new Date().toISOString();
  const contentJson = input.content !== undefined ? JSON.stringify(input.content) : null;
  getDb()
    .prepare(`
      INSERT INTO artifacts (id, issue_id, worker_session_id, kind, content_json, blob_path, author, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(id, input.issueId, input.workerSessionId ?? null, input.kind, contentJson, input.blobPath ?? null, input.author, now);
  return {
    id,
    issueId: input.issueId,
    workerSessionId: input.workerSessionId ?? null,
    kind: input.kind,
    contentJson,
    blobPath: input.blobPath ?? null,
    author: input.author,
    createdAt: now,
  };
}

/** Most recent artifact of `kind` for the issue — used to read the frozen task snapshot. */
export function latestIssueArtifact(issueId: string, kind: string): IssueArtifact | null {
  const row = getDb()
    .prepare("SELECT * FROM artifacts WHERE issue_id = ? AND kind = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(issueId, kind) as
    | {
        id: string;
        issue_id: string | null;
        worker_session_id: string | null;
        kind: string;
        content_json: string | null;
        blob_path: string | null;
        author: string;
        created_at: string;
      }
    | undefined;
  if (!row) return null;
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
