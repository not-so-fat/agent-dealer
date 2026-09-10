import type { Finding, FindingSeverity } from "@agent-dealer/shared";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";

interface FindingRow {
  id: string;
  issue_id: string;
  fingerprint: string;
  severity: string;
  title: string;
  rationale: string;
  evidence_ref: string | null;
  file: string | null;
  line: number | null;
  status: string;
  first_round: number;
  last_round: number;
}

function rowToFinding(row: FindingRow): Finding {
  return {
    id: row.id,
    issueId: row.issue_id,
    fingerprint: row.fingerprint,
    severity: row.severity as FindingSeverity,
    title: row.title,
    rationale: row.rationale,
    evidenceRef: row.evidence_ref,
    file: row.file,
    line: row.line,
    status: row.status as Finding["status"],
    firstRound: row.first_round,
    lastRound: row.last_round,
  };
}

export interface ReconcileFindingInput {
  issueId: string;
  fingerprint: string;
  severity: FindingSeverity;
  title: string;
  rationale: string;
  evidenceRef?: string | null;
  file?: string | null;
  line?: number | null;
  round: number;
}

/**
 * Inserts a new finding, or — if one with the same (issue, fingerprint) is
 * open/recurring — marks it recurring and bumps last_round (PRD §6.4).
 */
export function reconcileFinding(input: ReconcileFindingInput): Finding {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT * FROM findings WHERE issue_id = ? AND fingerprint = ? AND status IN ('open', 'recurring')`
    )
    .get(input.issueId, input.fingerprint) as FindingRow | undefined;

  if (existing) {
    db.prepare("UPDATE findings SET status = 'recurring', last_round = ? WHERE id = ?").run(
      input.round,
      existing.id
    );
    const row = db.prepare("SELECT * FROM findings WHERE id = ?").get(existing.id) as FindingRow;
    return rowToFinding(row);
  }

  const row: FindingRow = {
    id: uuid(),
    issue_id: input.issueId,
    fingerprint: input.fingerprint,
    severity: input.severity,
    title: input.title,
    rationale: input.rationale,
    evidence_ref: input.evidenceRef ?? null,
    file: input.file ?? null,
    line: input.line ?? null,
    status: "open",
    first_round: input.round,
    last_round: input.round,
  };
  db.prepare(`
    INSERT INTO findings (
      id, issue_id, fingerprint, severity, title, rationale, evidence_ref, file, line,
      status, first_round, last_round
    ) VALUES (
      @id, @issue_id, @fingerprint, @severity, @title, @rationale, @evidence_ref, @file, @line,
      @status, @first_round, @last_round
    )
  `).run(row);
  return rowToFinding(row);
}

export function resolveFinding(id: string): Finding {
  getDb().prepare("UPDATE findings SET status = 'resolved' WHERE id = ?").run(id);
  const row = getDb().prepare("SELECT * FROM findings WHERE id = ?").get(id) as FindingRow | undefined;
  if (!row) throw new Error(`Finding not found: ${id}`);
  return rowToFinding(row);
}

export function listFindingsForIssue(issueId: string): Finding[] {
  const rows = getDb()
    .prepare("SELECT * FROM findings WHERE issue_id = ? ORDER BY first_round ASC")
    .all(issueId) as FindingRow[];
  return rows.map(rowToFinding);
}
