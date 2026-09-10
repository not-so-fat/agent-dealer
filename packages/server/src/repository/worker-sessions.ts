// packages/server/src/repository/worker-sessions.ts
import type { CreateWorkerSessionInput, WorkerSession, WorkerSessionRole, WorkerSessionStatus } from "@agent-dealer/shared";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";

interface WorkerSessionRow {
  id: string;
  issue_id: string;
  role: string;
  round: number;
  agent_id: string | null;
  runtime: string | null;
  model: string | null;
  budget_json: string | null;
  worktree_path: string | null;
  input_sha: string | null;
  status: string;
  session_ref: string | null;
  log_path: string | null;
  exit_code: number | null;
  error_json: string | null;
  metadata_json: string | null;
  created_at: string;
  started_at: string | null;
  heartbeat_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

function rowToSession(row: WorkerSessionRow): WorkerSession {
  return {
    id: row.id,
    issueId: row.issue_id,
    role: row.role as WorkerSessionRole,
    round: row.round,
    agentId: row.agent_id,
    runtime: row.runtime as WorkerSession["runtime"],
    model: row.model,
    budgetJson: row.budget_json,
    worktreePath: row.worktree_path,
    inputSha: row.input_sha,
    status: row.status as WorkerSessionStatus,
    sessionRef: row.session_ref,
    logPath: row.log_path,
    exitCode: row.exit_code,
    errorJson: row.error_json,
    metadataJson: row.metadata_json,
    createdAt: row.created_at,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

export function createWorkerSession(input: CreateWorkerSessionInput): WorkerSession {
  const db = getDb();
  const now = new Date().toISOString();
  const row: WorkerSessionRow = {
    id: uuid(),
    issue_id: input.issueId,
    role: input.role,
    round: input.round,
    agent_id: input.agentId,
    runtime: input.runtime,
    model: input.model ?? null,
    budget_json: input.budgetJson ?? null,
    worktree_path: null,
    input_sha: input.inputSha ?? null,
    status: "queued",
    session_ref: null,
    log_path: null,
    exit_code: null,
    error_json: null,
    metadata_json: input.metadataJson ?? null,
    created_at: now,
    started_at: null,
    heartbeat_at: null,
    completed_at: null,
    updated_at: now,
  };
  db.prepare(`
    INSERT INTO worker_sessions (
      id, issue_id, role, round, agent_id, runtime, model, budget_json, worktree_path,
      input_sha, status, session_ref, log_path, exit_code, error_json, metadata_json,
      created_at, started_at, heartbeat_at, completed_at, updated_at
    ) VALUES (
      @id, @issue_id, @role, @round, @agent_id, @runtime, @model, @budget_json, @worktree_path,
      @input_sha, @status, @session_ref, @log_path, @exit_code, @error_json, @metadata_json,
      @created_at, @started_at, @heartbeat_at, @completed_at, @updated_at
    )
  `).run(row);
  return rowToSession(row);
}

export function getWorkerSession(id: string): WorkerSession | null {
  const row = getDb().prepare("SELECT * FROM worker_sessions WHERE id = ?").get(id) as
    | WorkerSessionRow
    | undefined;
  return row ? rowToSession(row) : null;
}

export function listWorkerSessionsForIssue(issueId: string): WorkerSession[] {
  const rows = getDb()
    .prepare("SELECT * FROM worker_sessions WHERE issue_id = ? ORDER BY created_at ASC")
    .all(issueId) as WorkerSessionRow[];
  return rows.map(rowToSession);
}

/** Compare-and-set queued → running. Returns null if another dispatcher already claimed it. */
export function claimQueuedSession(id: string): WorkerSession | null {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(
      `UPDATE worker_sessions SET status = 'running', started_at = ?, heartbeat_at = ?, updated_at = ?
       WHERE id = ? AND status = 'queued'`
    )
    .run(now, now, now, id);
  if (result.changes === 0) return null;
  return getWorkerSession(id);
}

/** Persists the worktree path once the checkout exists, before the session is spawned. */
export function setSessionWorktreePath(id: string, worktreePath: string): WorkerSession {
  const now = new Date().toISOString();
  getDb().prepare("UPDATE worker_sessions SET worktree_path = ?, updated_at = ? WHERE id = ?").run(worktreePath, now, id);
  const updated = getWorkerSession(id);
  if (!updated) throw new Error(`Worker session vanished: ${id}`);
  return updated;
}

export function heartbeatSession(id: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare("UPDATE worker_sessions SET heartbeat_at = ?, updated_at = ? WHERE id = ? AND status = 'running'")
    .run(now, now, id);
}

export interface CompleteSessionPatch {
  status: Extract<WorkerSessionStatus, "done" | "failed" | "timed_out" | "cancelled">;
  exitCode?: number | null;
  errorJson?: string | null;
  sessionRef?: string | null;
  logPath?: string | null;
  worktreePath?: string | null;
}

export function completeSession(id: string, patch: CompleteSessionPatch): WorkerSession {
  const current = getWorkerSession(id);
  if (!current) throw new Error(`Worker session not found: ${id}`);
  const now = new Date().toISOString();
  getDb()
    .prepare(`
      UPDATE worker_sessions SET
        status = @status,
        exit_code = @exit_code,
        error_json = @error_json,
        session_ref = @session_ref,
        log_path = @log_path,
        worktree_path = @worktree_path,
        completed_at = @completed_at,
        updated_at = @updated_at
      WHERE id = @id
    `)
    .run({
      id,
      status: patch.status,
      exit_code: patch.exitCode !== undefined ? patch.exitCode : current.exitCode,
      error_json: patch.errorJson !== undefined ? patch.errorJson : current.errorJson,
      session_ref: patch.sessionRef !== undefined ? patch.sessionRef : current.sessionRef,
      log_path: patch.logPath !== undefined ? patch.logPath : current.logPath,
      worktree_path: patch.worktreePath !== undefined ? patch.worktreePath : current.worktreePath,
      completed_at: now,
      updated_at: now,
    });
  const updated = getWorkerSession(id);
  if (!updated) throw new Error(`Worker session vanished: ${id}`);
  return updated;
}
