// packages/server/src/repository/source-attachments.ts
//
// NOT-364: read/write side for `issue_source_attachments` — durable snapshots
// of a Linear issue's own file/link attachments, keyed by
// (Dealer issue id, Linear attachment id). Hosted files carry a Dealer-owned
// blob_path plus integrity fields; links carry source metadata only.
import { v4 as uuid } from "uuid";
import type { SourceAttachmentRecord } from "@agent-dealer/shared";
import { getDb } from "../db/index.js";

interface SourceAttachmentRow {
  id: string;
  issue_id: string;
  linear_attachment_id: string;
  kind: string;
  title: string;
  safe_file_name: string | null;
  blob_path: string | null;
  content_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  url: string;
  subtitle: string | null;
  source: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: SourceAttachmentRow): SourceAttachmentRecord {
  const out: SourceAttachmentRecord = {
    linearAttachmentId: row.linear_attachment_id,
    kind: row.kind === "file" ? "file" : "link",
    title: row.title,
    url: row.url,
  };
  if (row.safe_file_name) out.safeFileName = row.safe_file_name;
  if (row.blob_path) out.blobPath = row.blob_path;
  if (row.content_type) out.contentType = row.content_type;
  if (row.size_bytes !== null) out.sizeBytes = row.size_bytes;
  if (row.sha256) out.sha256 = row.sha256;
  if (row.subtitle) out.subtitle = row.subtitle;
  if (row.source) out.source = row.source;
  return out;
}

/** Every source attachment for the issue, oldest first (stable prompt order). */
export function listSourceAttachments(issueId: string): SourceAttachmentRecord[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM issue_source_attachments WHERE issue_id = ? ORDER BY created_at ASC, rowid ASC"
    )
    .all(issueId) as SourceAttachmentRow[];
  return rows.map(rowToRecord);
}

/**
 * All-or-nothing replacement of an issue's attachment snapshot: deletes every
 * existing row for the issue, then inserts the new set. Call inside the
 * caller's transaction when the replacement must commit atomically with other
 * writes (import text, reload text) — a throw leaves the prior rows untouched.
 */
export function replaceSourceAttachments(
  issueId: string,
  records: readonly SourceAttachmentRecord[]
): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("DELETE FROM issue_source_attachments WHERE issue_id = ?").run(issueId);
  const insert = db.prepare(
    `INSERT INTO issue_source_attachments
      (id, issue_id, linear_attachment_id, kind, title, safe_file_name, blob_path,
       content_type, size_bytes, sha256, url, subtitle, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const r of records) {
    insert.run(
      uuid(),
      issueId,
      r.linearAttachmentId,
      r.kind,
      r.title,
      r.safeFileName ?? null,
      r.blobPath ?? null,
      r.contentType ?? null,
      r.sizeBytes ?? null,
      r.sha256 ?? null,
      r.url,
      r.subtitle ?? null,
      r.source ?? null,
      now,
      now
    );
  }
}
