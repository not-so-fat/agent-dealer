import {
  canTransitionIssue,
  type CreateIssueInput,
  type Issue,
  type IssueOwner,
  type IssueStatus,
} from "@agent-dealer/shared";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";

interface IssueRow {
  id: string;
  source: string;
  external_id: string | null;
  external_label: string | null;
  external_url: string | null;
  title: string;
  description: string | null;
  acceptance_criteria: string | null;
  repo: string;
  base_branch: string;
  status: string;
  current_owner: string;
  current_intent: string | null;
  developer_agent_id: string | null;
  reviewer_agent_id: string | null;
  max_review_rounds: number;
  current_round: number;
  max_infra_attempts: number;
  infra_attempts: number;
  branch: string | null;
  base_sha: string | null;
  head_sha: string | null;
  pr_number: number | null;
  pr_url: string | null;
  created_at: string;
  updated_at: string;
}

function rowToIssue(row: IssueRow): Issue {
  return {
    id: row.id,
    source: row.source as Issue["source"],
    externalId: row.external_id,
    externalLabel: row.external_label,
    externalUrl: row.external_url,
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptance_criteria,
    repo: row.repo,
    baseBranch: row.base_branch,
    status: row.status as IssueStatus,
    currentOwner: row.current_owner as IssueOwner,
    currentIntent: row.current_intent,
    developerAgentId: row.developer_agent_id,
    reviewerAgentId: row.reviewer_agent_id,
    maxReviewRounds: row.max_review_rounds,
    currentRound: row.current_round,
    maxInfraAttempts: row.max_infra_attempts,
    infraAttempts: row.infra_attempts,
    branch: row.branch,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createIssue(input: CreateIssueInput): Issue {
  const db = getDb();
  const now = new Date().toISOString();
  const id = uuid();
  const row: IssueRow = {
    id,
    source: input.source,
    external_id: input.externalId ?? null,
    external_label: input.externalLabel ?? null,
    external_url: input.externalUrl ?? null,
    title: input.title,
    description: input.description ?? null,
    acceptance_criteria: input.acceptanceCriteria ?? null,
    repo: input.repo,
    base_branch: input.baseBranch,
    status: "ready",
    current_owner: "system",
    current_intent: null,
    developer_agent_id: input.developerAgentId,
    reviewer_agent_id: input.reviewerAgentId,
    max_review_rounds: input.maxReviewRounds,
    current_round: 1,
    max_infra_attempts: input.maxInfraAttempts,
    infra_attempts: 0,
    branch: null,
    base_sha: null,
    head_sha: null,
    pr_number: null,
    pr_url: null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(`
    INSERT INTO issues (
      id, source, external_id, external_label, external_url, title, description,
      acceptance_criteria, repo, base_branch, status, current_owner, current_intent,
      developer_agent_id, reviewer_agent_id, max_review_rounds, current_round,
      max_infra_attempts, infra_attempts,
      branch, base_sha, head_sha, pr_number, pr_url, created_at, updated_at
    ) VALUES (
      @id, @source, @external_id, @external_label, @external_url, @title, @description,
      @acceptance_criteria, @repo, @base_branch, @status, @current_owner, @current_intent,
      @developer_agent_id, @reviewer_agent_id, @max_review_rounds, @current_round,
      @max_infra_attempts, @infra_attempts,
      @branch, @base_sha, @head_sha, @pr_number, @pr_url, @created_at, @updated_at
    )
  `).run(row);
  return rowToIssue(row);
}

export function getIssue(id: string): Issue | null {
  const row = getDb().prepare("SELECT * FROM issues WHERE id = ?").get(id) as IssueRow | undefined;
  return row ? rowToIssue(row) : null;
}

export function listIssues(status?: IssueStatus | IssueStatus[]): Issue[] {
  const db = getDb();
  if (!status) {
    const rows = db.prepare("SELECT * FROM issues ORDER BY updated_at DESC").all() as IssueRow[];
    return rows.map(rowToIssue);
  }
  const statuses = Array.isArray(status) ? status : [status];
  const placeholders = statuses.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM issues WHERE status IN (${placeholders}) ORDER BY updated_at DESC`)
    .all(...statuses) as IssueRow[];
  return rows.map(rowToIssue);
}

export function findIssueByExternalId(source: string, externalId: string): Issue | null {
  const row = getDb()
    .prepare("SELECT * FROM issues WHERE source = ? AND external_id = ?")
    .get(source, externalId) as IssueRow | undefined;
  return row ? rowToIssue(row) : null;
}

export interface TransitionIssuePatch {
  currentOwner?: IssueOwner;
  currentIntent?: string | null;
  branch?: string | null;
  baseSha?: string | null;
  headSha?: string | null;
  prNumber?: number | null;
  prUrl?: string | null;
}

export function transitionIssue(id: string, to: IssueStatus, patch?: TransitionIssuePatch): Issue {
  const current = getIssue(id);
  if (!current) throw new Error(`Issue not found: ${id}`);
  if (!canTransitionIssue(current.status, to)) {
    throw new Error(`Invalid transition: ${current.status} → ${to}`);
  }
  const now = new Date().toISOString();
  getDb()
    .prepare(`
      UPDATE issues SET
        status = @status,
        current_owner = @current_owner,
        current_intent = @current_intent,
        branch = @branch,
        base_sha = @base_sha,
        head_sha = @head_sha,
        pr_number = @pr_number,
        pr_url = @pr_url,
        updated_at = @updated_at
      WHERE id = @id
    `)
    .run({
      id,
      status: to,
      current_owner: patch?.currentOwner ?? current.currentOwner,
      current_intent: patch?.currentIntent !== undefined ? patch.currentIntent : current.currentIntent,
      branch: patch?.branch !== undefined ? patch.branch : current.branch,
      base_sha: patch?.baseSha !== undefined ? patch.baseSha : current.baseSha,
      head_sha: patch?.headSha !== undefined ? patch.headSha : current.headSha,
      pr_number: patch?.prNumber !== undefined ? patch.prNumber : current.prNumber,
      pr_url: patch?.prUrl !== undefined ? patch.prUrl : current.prUrl,
      updated_at: now,
    });
  const updated = getIssue(id);
  if (!updated) throw new Error(`Issue vanished: ${id}`);
  return updated;
}

export interface UpdateIssuePatch {
  title?: string;
  description?: string | null;
  acceptanceCriteria?: string | null;
  repo?: string;
  baseBranch?: string;
  developerAgentId?: string;
  reviewerAgentId?: string;
  maxReviewRounds?: number;
  maxInfraAttempts?: number;
}

/** Pre-start (or parked-on-`needs_human`) edits only — the route enforces no active
 * workflow instance. Never touches status/owner/intent/branch/SHA/PR fields, which are
 * coordinator-owned (see transitionIssue). */
export function updateIssue(id: string, patch: UpdateIssuePatch): Issue {
  const current = getIssue(id);
  if (!current) throw new Error(`Issue not found: ${id}`);
  const now = new Date().toISOString();
  getDb()
    .prepare(`
      UPDATE issues SET
        title = @title,
        description = @description,
        acceptance_criteria = @acceptance_criteria,
        repo = @repo,
        base_branch = @base_branch,
        developer_agent_id = @developer_agent_id,
        reviewer_agent_id = @reviewer_agent_id,
        max_review_rounds = @max_review_rounds,
        max_infra_attempts = @max_infra_attempts,
        updated_at = @updated_at
      WHERE id = @id
    `)
    .run({
      id,
      title: patch.title ?? current.title,
      description: patch.description !== undefined ? patch.description : current.description,
      acceptance_criteria:
        patch.acceptanceCriteria !== undefined ? patch.acceptanceCriteria : current.acceptanceCriteria,
      repo: patch.repo ?? current.repo,
      base_branch: patch.baseBranch ?? current.baseBranch,
      developer_agent_id: patch.developerAgentId ?? current.developerAgentId,
      reviewer_agent_id: patch.reviewerAgentId ?? current.reviewerAgentId,
      max_review_rounds: patch.maxReviewRounds ?? current.maxReviewRounds,
      max_infra_attempts: patch.maxInfraAttempts ?? current.maxInfraAttempts,
      updated_at: now,
    });
  const updated = getIssue(id);
  if (!updated) throw new Error(`Issue vanished: ${id}`);
  return updated;
}

export function incrementIssueRound(id: string): Issue {
  const current = getIssue(id);
  if (!current) throw new Error(`Issue not found: ${id}`);
  const now = new Date().toISOString();
  getDb()
    .prepare("UPDATE issues SET current_round = current_round + 1, updated_at = ? WHERE id = ?")
    .run(now, id);
  const updated = getIssue(id);
  if (!updated) throw new Error(`Issue vanished: ${id}`);
  return updated;
}

/** Spends one infra attempt — a session/git/gh/Agent Deck/publish failure that is being
 * retried automatically, never a reviewer's `changes_requested`. See incrementIssueRound. */
export function incrementIssueInfraAttempts(id: string): Issue {
  const current = getIssue(id);
  if (!current) throw new Error(`Issue not found: ${id}`);
  const now = new Date().toISOString();
  getDb()
    .prepare("UPDATE issues SET infra_attempts = infra_attempts + 1, updated_at = ? WHERE id = ?")
    .run(now, id);
  const updated = getIssue(id);
  if (!updated) throw new Error(`Issue vanished: ${id}`);
  return updated;
}

/** A human resuming past a `policy_escalation` gets a fresh infra-attempt budget. */
export function resetIssueInfraAttempts(id: string): Issue {
  const current = getIssue(id);
  if (!current) throw new Error(`Issue not found: ${id}`);
  const now = new Date().toISOString();
  getDb()
    .prepare("UPDATE issues SET infra_attempts = 0, updated_at = ? WHERE id = ?")
    .run(now, id);
  const updated = getIssue(id);
  if (!updated) throw new Error(`Issue vanished: ${id}`);
  return updated;
}

/** `attempts_exhausted:retry` grants one more review round instead of instantly
 * re-exhausting: bumps current_round AND max_review_rounds together. */
export function grantReviewRetry(id: string): Issue {
  const current = getIssue(id);
  if (!current) throw new Error(`Issue not found: ${id}`);
  const now = new Date().toISOString();
  getDb()
    .prepare(
      "UPDATE issues SET current_round = current_round + 1, max_review_rounds = max_review_rounds + 1, updated_at = ? WHERE id = ?"
    )
    .run(now, id);
  const updated = getIssue(id);
  if (!updated) throw new Error(`Issue vanished: ${id}`);
  return updated;
}
