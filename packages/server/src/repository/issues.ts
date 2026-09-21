import {
  canTransitionIssue,
  CreateIssueInput,
  looksLikeLocalRepoPath,
  parseGitHubRepoInput,
  type Issue,
  type IssueOwner,
  type IssueStatus,
  TERMINAL_ISSUE_STATUSES,
} from "@agent-dealer/shared";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";

/** Wire body or internal create — `repo` may be a GitHub ref or an existing legacy local path. */
type CreateIssueRaw = Omit<import("@agent-dealer/shared").CreateIssueInput, "repo"> & { repo: string };

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
  auto_merge: number;
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
    autoMerge: row.auto_merge !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Persistable `issues.repo` value (NOT-149):
 * - GitHub URL / owner/repo → canonical `github.com/owner/repo`
 * - Local filesystem path → kept as-is for in-flight recovery / tests (existence is
 *   checked at checkout resolve time via classifyIssueRepo — never guess a remote)
 */
export function normalizeStoredIssueRepo(repoRaw: string): string {
  const trimmed = repoRaw.trim();
  if (looksLikeLocalRepoPath(trimmed)) {
    return trimmed;
  }
  return parseGitHubRepoInput(trimmed).identity;
}

export function createIssue(raw: CreateIssueRaw): Issue {
  const { repo: repoRaw, ...rest } = raw;
  const input = CreateIssueInput.omit({ repo: true }).parse(rest);
  const repo = normalizeStoredIssueRepo(repoRaw);
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
    repo,
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
    auto_merge: input.autoMerge ? 1 : 0,
    created_at: now,
    updated_at: now,
  };
  db.prepare(`
    INSERT INTO issues (
      id, source, external_id, external_label, external_url, title, description,
      acceptance_criteria, repo, base_branch, status, current_owner, current_intent,
      developer_agent_id, reviewer_agent_id, max_review_rounds, current_round,
      max_infra_attempts, infra_attempts,
      branch, base_sha, head_sha, pr_number, pr_url, auto_merge, created_at, updated_at
    ) VALUES (
      @id, @source, @external_id, @external_label, @external_url, @title, @description,
      @acceptance_criteria, @repo, @base_branch, @status, @current_owner, @current_intent,
      @developer_agent_id, @reviewer_agent_id, @max_review_rounds, @current_round,
      @max_infra_attempts, @infra_attempts,
      @branch, @base_sha, @head_sha, @pr_number, @pr_url, @auto_merge, @created_at, @updated_at
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
    const rows = db
      .prepare("SELECT * FROM issues ORDER BY updated_at DESC, rowid DESC")
      .all() as IssueRow[];
    return rows.map(rowToIssue);
  }
  const statuses = Array.isArray(status) ? status : [status];
  const placeholders = statuses.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM issues WHERE status IN (${placeholders}) ORDER BY updated_at DESC, rowid DESC`)
    .all(...statuses) as IssueRow[];
  return rows.map(rowToIssue);
}

/** NOT-228: page-size bounds for the Issues list (matches the report default/max). */
export const ISSUES_LIST_DEFAULT_LIMIT = 25;
export const ISSUES_LIST_MAX_LIMIT = 100;

export interface IssuesListQuery {
  /** Free text matched case-insensitively against title and external label. */
  search?: string;
  status?: IssueStatus | IssueStatus[];
  /** Exact repository identity (the stored canonical `github.com/owner/repo`). */
  repo?: string;
  /** Only issues with at least one open human action. */
  needsAttention?: boolean;
  /** 1-based; values below 1 clamp to 1. */
  page?: number;
  /** Values outside 1..100 fall back to the default / clamp to the max. */
  limit?: number;
}

export interface IssuesListResult {
  rows: Issue[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** Escape the LIKE metacharacters in a user query so `%`/`_` match literally. */
function escapeLikePattern(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * NOT-228: server-side filtering + stable pagination for the Issues list.
 * Ordering is `updated_at DESC, rowid DESC` so pages are repeatable when many
 * rows share a timestamp; the filter applies before pagination so `total` and
 * `totalPages` describe the full matching cohort.
 */
export function queryIssues(query: IssuesListQuery = {}): IssuesListResult {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  const rawStatuses = query.status === undefined ? [] : Array.isArray(query.status) ? query.status : [query.status];
  const statuses = rawStatuses.map((s) => String(s).trim()).filter(Boolean);
  if (statuses.length > 0) {
    conditions.push(`status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);
  }

  const search = query.search?.trim();
  if (search) {
    const pattern = `%${escapeLikePattern(search).toLowerCase()}%`;
    conditions.push(
      `(LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(external_label, '')) LIKE ? ESCAPE '\\')`
    );
    params.push(pattern, pattern);
  }

  const repo = query.repo?.trim();
  if (repo) {
    conditions.push(`repo = ?`);
    params.push(repo);
  }

  if (query.needsAttention) {
    conditions.push(
      `EXISTS (SELECT 1 FROM human_actions ha WHERE ha.issue_id = issues.id AND ha.status = 'open')`
    );
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rawLimit = query.limit === undefined ? ISSUES_LIST_DEFAULT_LIMIT : Math.floor(query.limit);
  const limit =
    !Number.isFinite(rawLimit) || rawLimit < 1
      ? ISSUES_LIST_DEFAULT_LIMIT
      : Math.min(rawLimit, ISSUES_LIST_MAX_LIMIT);
  const rawPage = query.page === undefined ? 1 : Math.floor(query.page);
  const page = !Number.isFinite(rawPage) || rawPage < 1 ? 1 : rawPage;

  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM issues ${where}`)
    .get(...params) as { total: number };
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  const offset = (page - 1) * limit;
  const rows = db
    .prepare(`SELECT * FROM issues ${where} ORDER BY updated_at DESC, rowid DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as IssueRow[];
  return { rows: rows.map(rowToIssue), page, limit, total, totalPages };
}

/**
 * Every issue ever imported for this external id, newest first. `(source, external_id)` is
 * deliberately non-unique (`idx_issues_external` is a plain index): one ticket may need a
 * second pass after the first ended terminally (NOT-141).
 */
export function listIssuesByExternalId(source: string, externalId: string): Issue[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM issues WHERE source = ? AND external_id = ? ORDER BY created_at DESC, rowid DESC"
    )
    .all(source, externalId) as IssueRow[];
  return rows.map(rowToIssue);
}

/**
 * NOT-141: the import guard — the issues-model analog of runs' `findActiveByExternalId`.
 * It exists to stop two live workflows racing on one ticket, not to make a ticket
 * single-use: a `done`/`closed` row no longer matches, so a re-import after a terminal pass
 * creates a new issue instead of silently returning the old one.
 */
export function findActiveIssueByExternalId(source: string, externalId: string): Issue | null {
  const placeholders = TERMINAL_ISSUE_STATUSES.map(() => "?").join(",");
  const row = getDb()
    .prepare(
      `SELECT * FROM issues
       WHERE source = ? AND external_id = ? AND status NOT IN (${placeholders})
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`
    )
    .get(source, externalId, ...TERMINAL_ISSUE_STATUSES) as IssueRow | undefined;
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
  autoMerge?: boolean;
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
        auto_merge = @auto_merge,
        updated_at = @updated_at
      WHERE id = @id
    `)
    .run({
      id,
      title: patch.title ?? current.title,
      description: patch.description !== undefined ? patch.description : current.description,
      acceptance_criteria:
        patch.acceptanceCriteria !== undefined ? patch.acceptanceCriteria : current.acceptanceCriteria,
      repo: patch.repo !== undefined ? normalizeStoredIssueRepo(patch.repo) : current.repo,
      base_branch: patch.baseBranch ?? current.baseBranch,
      developer_agent_id: patch.developerAgentId ?? current.developerAgentId,
      reviewer_agent_id: patch.reviewerAgentId ?? current.reviewerAgentId,
      max_review_rounds: patch.maxReviewRounds ?? current.maxReviewRounds,
      max_infra_attempts: patch.maxInfraAttempts ?? current.maxInfraAttempts,
      auto_merge: (patch.autoMerge !== undefined ? patch.autoMerge : current.autoMerge) ? 1 : 0,
      updated_at: now,
    });
  const updated = getIssue(id);
  if (!updated) throw new Error(`Issue vanished: ${id}`);
  return updated;
}

/** Distinct portable GitHub repo identities from prior issues, most recently used first.
 * Legacy local filesystem rows are excluded from create/recent surfaces (NOT-149) —
 * recovery for those issues remains at checkout time only. */
export function listRecentRepos(limit = 20): string[] {
  const rows = getDb()
    .prepare(
      `SELECT repo, MAX(updated_at) AS last_used
       FROM issues
       WHERE repo IS NOT NULL AND TRIM(repo) != ''
       GROUP BY repo
       ORDER BY last_used DESC
       LIMIT ?`
    )
    .all(Math.max(limit * 4, 40)) as Array<{ repo: string }>;
  const out: string[] = [];
  for (const r of rows) {
    if (looksLikeLocalRepoPath(r.repo)) continue;
    out.push(r.repo);
    if (out.length >= limit) break;
  }
  return out;
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
