// packages/server/src/coordinator/attempt-waste.ts
//
// NOT-172: failed-attempt waste, first checkpoint, and retry-reuse derivation
// (epic NOT-161, contract docs/EXECUTION_ANALYSIS.md).
//
// Pure derivation over durable evidence — workflow_events (`checkpoint.observed`
// / `retry.reused` / agent boundaries), worker_sessions rows, usage_events rows,
// and work-item payload hints. Writers never read this back: it must not drive
// retry, routing, worktree, or commit decisions.
//
// Missing-data rules (EXECUTION_ANALYSIS.md §4): null provider fields stay null
// with known/total counts, never coerced to zero; aggregates take the weakest
// quality among known inputs plus `partial_sample` when known < total; known = 0
// is `unavailable`, never 0. Legacy rows (pre-NOT-172, no checkpoint/reuse
// events) may consume recovery payloads and verification artifacts when
// defensible, always marked `inferred` with reason `backfill`.
import type { CheckpointKind, CheckpointOrigin, RetryReuseKind } from "@agent-dealer/shared";
import { CheckpointObservedPayload, RetryReusedPayload } from "@agent-dealer/shared";
import { getDb } from "../db/index.js";

export type WasteQuality = "exact" | "inferred" | "unavailable";

/** Sum/aggregate over known observations with completeness counts (§4). */
export interface WasteAggregate {
  value: number | null;
  quality: WasteQuality;
  reasons: string[];
  known: number;
  total: number;
}

export interface CheckpointRecord {
  sessionId: string | null;
  kind: CheckpointKind;
  observedSha: string | null;
  observedAt: string | null;
  origin: CheckpointOrigin | null;
  inputSha: string | null;
  samplingPrecisionMs: number | null;
  branch: string | null;
  ts: string;
  cursor: number;
}

export interface ReuseRecord {
  sessionId: string;
  kinds: RetryReuseKind[];
  retryReason: string | null;
  ts: string;
  cursor: number;
}

export interface WasteSession {
  id: string;
  role: string;
  status: string;
  errorJson: string | null;
  createdAt: string;
}

export interface WasteUsage {
  workerSessionId: string;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  durationMs: number | null;
}

export interface AgentBoundary {
  sessionId: string;
  startMs: number | null;
  endMs: number | null;
}

function msOf(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

function withPartialSample(base: Omit<WasteAggregate, "reasons"> & { reasons?: string[] }): WasteAggregate {
  const reasons = [...(base.reasons ?? [])];
  if (base.known < base.total && !reasons.includes("partial_sample")) reasons.push("partial_sample");
  return { ...base, reasons };
}

// ---------------------------------------------------------------------------
// First checkpoint
// ---------------------------------------------------------------------------

export interface FirstCheckpointInput {
  /** workflow_instances.started_at for the issue's workflow. */
  workflowStartedAt: string | null;
  checkpoints: CheckpointRecord[];
  /**
   * Legacy fallback (pre-NOT-172 rows): earliest defensible durable timestamp —
   * e.g. a `branch.pushed` event ts, a verification-receipt artifact created_at,
   * or a recovery republish payload time. Consumed only when no checkpoint
   * event exists, and always marked inferred.
   */
  legacyFirstEvidenceAt?: string | null;
}

export interface FirstCheckpoint {
  kind: CheckpointKind | null;
  observedSha: string | null;
  /** Ms from workflow start to the first checkpoint; null when unavailable. */
  msSinceWorkflowStart: number | null;
  quality: WasteQuality;
  reasons: string[];
}

function orderCheckpoints(checkpoints: CheckpointRecord[]): CheckpointRecord[] {
  return [...checkpoints].sort((a, b) => {
    const ta = msOf(a.observedAt ?? a.ts) ?? 0;
    const tb = msOf(b.observedAt ?? b.ts) ?? 0;
    return ta - tb || a.cursor - b.cursor;
  });
}

export function deriveFirstCheckpoint(input: FirstCheckpointInput): FirstCheckpoint {
  const ordered = orderCheckpoints(input.checkpoints);
  const startMs = msOf(input.workflowStartedAt);
  const first = ordered[0] ?? null;
  if (first) {
    const atMs = msOf(first.observedAt ?? first.ts);
    if (startMs === null || atMs === null) {
      return { kind: first.kind, observedSha: first.observedSha, msSinceWorkflowStart: null, quality: "unavailable", reasons: ["no_defensible_boundary"] };
    }
    if (atMs < startMs) {
      return { kind: first.kind, observedSha: first.observedSha, msSinceWorkflowStart: null, quality: "unavailable", reasons: ["negative_duration"] };
    }
    return { kind: first.kind, observedSha: first.observedSha, msSinceWorkflowStart: atMs - startMs, quality: "exact", reasons: [] };
  }
  const legacyMs = msOf(input.legacyFirstEvidenceAt);
  if (startMs !== null && legacyMs !== null) {
    if (legacyMs < startMs) {
      return { kind: null, observedSha: null, msSinceWorkflowStart: null, quality: "unavailable", reasons: ["negative_duration"] };
    }
    return { kind: null, observedSha: null, msSinceWorkflowStart: legacyMs - startMs, quality: "inferred", reasons: ["backfill"] };
  }
  return { kind: null, observedSha: null, msSinceWorkflowStart: null, quality: "unavailable", reasons: ["missing_checkpoint"] };
}

// ---------------------------------------------------------------------------
// Failed-attempt waste
// ---------------------------------------------------------------------------

export interface AttemptWasteInput {
  sessions: WasteSession[];
  usages: WasteUsage[];
  agentBoundaries: AgentBoundary[];
  /** Sessions that ran the no-agent publish path — zero agent waste by structure. */
  publishOnlySessionIds?: Set<string>;
}

export interface AttemptWaste {
  /** Failed agent sessions (failed/timed_out, or cancelled with failure evidence). */
  failedAttempts: number;
  /** Failed publish-only sessions: retry attempts with zero agent-process waste. */
  publishOnlyAttempts: number;
  runtimeMs: WasteAggregate;
  tokensIn: WasteAggregate;
  tokensOut: WasteAggregate;
  costUsd: WasteAggregate;
}

/**
 * Waste includes agent-process/usage from attempts whose primary result is
 * failed/timed_out/cancelled for a failure. A later successful retry never
 * erases prior waste. `cancelled` counts only with failure evidence
 * (errorJson) — a clean operator cancel discarded nothing.
 */
export function isWastedSession(session: WasteSession): boolean {
  if (session.status === "failed" || session.status === "timed_out") return true;
  if (session.status === "cancelled") return session.errorJson != null;
  return false;
}

function unavailableAggregate(total: number, reason: string): WasteAggregate {
  return { value: null, quality: "unavailable", reasons: total > 0 ? [reason] : [reason], known: 0, total };
}

export function deriveAttemptWaste(input: AttemptWasteInput): AttemptWaste {
  const publishOnly = input.publishOnlySessionIds ?? new Set<string>();
  const usageBySession = new Map(input.usages.map((u) => [u.workerSessionId, u]));
  const boundsBySession = new Map(input.agentBoundaries.map((b) => [b.sessionId, b]));

  const failed = input.sessions.filter(isWastedSession);
  const publishOnlyFailed = failed.filter((s) => publishOnly.has(s.id));
  const agentFailed = failed.filter((s) => !publishOnly.has(s.id));

  // Runtime: exact agent interval when both boundaries exist, else the inferred
  // spawn envelope (usage duration includes slot wait + post-exit work, §6.1).
  const runtimes: Array<{ value: number; quality: WasteQuality; reasons: string[] }> = [];
  for (const session of agentFailed) {
    const bounds = boundsBySession.get(session.id);
    if (bounds?.startMs != null && bounds?.endMs != null) {
      if (bounds.endMs < bounds.startMs) continue;
      runtimes.push({ value: bounds.endMs - bounds.startMs, quality: "exact", reasons: [] });
      continue;
    }
    const duration = usageBySession.get(session.id)?.durationMs;
    if (duration != null && Number.isFinite(duration)) {
      runtimes.push({
        value: duration,
        quality: "inferred",
        reasons: ["proxy_boundary", "includes_spawn_slot_wait", "includes_post_exit_work"],
      });
    }
  }
  const runtimeMs: WasteAggregate =
    runtimes.length === 0
      ? unavailableAggregate(agentFailed.length, "no_defensible_boundary")
      : withPartialSample({
          value: runtimes.reduce((sum, r) => sum + r.value, 0),
          quality: runtimes.some((r) => r.quality === "inferred") ? "inferred" : "exact",
          reasons: [...new Set(runtimes.flatMap((r) => r.reasons))],
          known: runtimes.length,
          total: agentFailed.length,
        });

  // Value metrics: provider-recorded numbers only, never coerced from null.
  const sumKnown = (pick: (u: WasteUsage) => number | null): WasteAggregate => {
    const values: number[] = [];
    for (const session of agentFailed) {
      const v = usageBySession.get(session.id) ? pick(usageBySession.get(session.id)!) : null;
      if (v != null && Number.isFinite(v)) values.push(v);
    }
    if (values.length === 0) return unavailableAggregate(agentFailed.length, "missing_provider_metadata");
    return withPartialSample({
      value: values.reduce((sum, v) => sum + v, 0),
      quality: "exact",
      known: values.length,
      total: agentFailed.length,
    });
  };

  return {
    failedAttempts: agentFailed.length,
    publishOnlyAttempts: publishOnlyFailed.length,
    runtimeMs,
    tokensIn: sumKnown((u) => u.tokensIn),
    tokensOut: sumKnown((u) => u.tokensOut),
    costUsd: sumKnown((u) => u.costUsd),
  };
}

// ---------------------------------------------------------------------------
// Retry count and cold-vs-reused retries
// ---------------------------------------------------------------------------

export interface RetrySessionHint {
  publishOnly: boolean;
  retryReason: string | null;
}

export interface RetrySummaryInput {
  /** Developer sessions ordered by creation (oldest first); retries follow the first. */
  sessions: WasteSession[];
  reuse: ReuseRecord[];
  /** Per-session work-item payload hints (legacy derivation source). */
  hints?: Map<string, RetrySessionHint>;
}

export interface RetryAttempt {
  sessionId: string;
  kinds: RetryReuseKind[];
  /** True = cold, false = reused, null = unknown (no evidence either way). */
  cold: boolean | null;
  quality: WasteQuality;
  reasons: string[];
}

export interface RetrySummary {
  attempts: number;
  retries: number;
  cold: number;
  reused: number;
  unknown: number;
  publishOnly: number;
  attemptsDetail: RetryAttempt[];
}

export function deriveRetrySummary(input: RetrySummaryInput): RetrySummary {
  const reuseBySession = new Map(input.reuse.map((r) => [r.sessionId, r]));
  const hints = input.hints ?? new Map<string, RetrySessionHint>();
  const detail: RetryAttempt[] = [];

  for (const session of input.sessions.slice(1)) {
    const record = reuseBySession.get(session.id);
    if (record) {
      detail.push({
        sessionId: session.id,
        kinds: record.kinds,
        cold: record.kinds.length === 0,
        quality: "exact",
        reasons: [],
      });
      continue;
    }
    // Legacy: consume the recovery/routing payload only when defensible.
    const hint = hints.get(session.id);
    if (hint?.publishOnly) {
      detail.push({
        sessionId: session.id,
        kinds: ["publish_only"],
        cold: false,
        quality: "inferred",
        reasons: ["backfill"],
      });
      continue;
    }
    detail.push({
      sessionId: session.id,
      kinds: [],
      cold: null,
      quality: hint?.retryReason ? "inferred" : "unavailable",
      reasons: hint?.retryReason ? ["backfill"] : ["missing_reuse_evidence"],
    });
  }

  return {
    attempts: input.sessions.length,
    retries: detail.length,
    cold: detail.filter((d) => d.cold === true).length,
    reused: detail.filter((d) => d.cold === false).length,
    unknown: detail.filter((d) => d.cold === null).length,
    publishOnly: detail.filter((d) => d.kinds.includes("publish_only")).length,
    attemptsDetail: detail,
  };
}

// ---------------------------------------------------------------------------
// DB-backed loaders
// ---------------------------------------------------------------------------

interface CheckpointEventRow {
  cursor: number;
  ts: string;
  worker_session_id: string | null;
  payload_json: string | null;
}

function parseCheckpointRow(row: CheckpointEventRow): CheckpointRecord | null {
  if (!row.payload_json) return null;
  try {
    const parsed = CheckpointObservedPayload.safeParse(JSON.parse(row.payload_json));
    if (!parsed.success) return null;
    return {
      sessionId: row.worker_session_id,
      kind: parsed.data.kind,
      observedSha: parsed.data.observedSha,
      observedAt: parsed.data.observedAt,
      origin: parsed.data.origin,
      inputSha: parsed.data.inputSha,
      samplingPrecisionMs: parsed.data.samplingPrecisionMs,
      branch: parsed.data.branch,
      ts: row.ts,
      cursor: row.cursor,
    };
  } catch {
    return null;
  }
}

/** All checkpoint evidence for an issue, in durable (ts, cursor) order. */
export function listCheckpointsForIssue(issueId: string): CheckpointRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT rowid AS cursor, ts, worker_session_id, payload_json FROM workflow_events
       WHERE issue_id = ? AND type = 'checkpoint.observed'
       ORDER BY ts ASC, rowid ASC`
    )
    .all(issueId) as CheckpointEventRow[];
  return rows
    .map(parseCheckpointRow)
    .filter((r): r is CheckpointRecord => r !== null);
}

interface ReuseEventRow {
  cursor: number;
  ts: string;
  worker_session_id: string | null;
  payload_json: string | null;
}

/** The reuse record for one retry session, or null when none was recorded. */
export function getRetryReuseForSession(workerSessionId: string): ReuseRecord | null {
  const row = getDb()
    .prepare(
      `SELECT rowid AS cursor, ts, worker_session_id, payload_json FROM workflow_events
       WHERE worker_session_id = ? AND type = 'retry.reused'
       ORDER BY rowid ASC LIMIT 1`
    )
    .get(workerSessionId) as ReuseEventRow | undefined;
  if (!row?.payload_json || !row.worker_session_id) return null;
  try {
    const parsed = RetryReusedPayload.safeParse(JSON.parse(row.payload_json));
    if (!parsed.success) return null;
    return {
      sessionId: row.worker_session_id,
      kinds: parsed.data.kinds,
      retryReason: parsed.data.retryReason,
      ts: row.ts,
      cursor: row.cursor,
    };
  } catch {
    return null;
  }
}

/** All reuse records for an issue, in durable (ts, cursor) order. */
export function listReuseForIssue(issueId: string): ReuseRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT rowid AS cursor, ts, worker_session_id, payload_json FROM workflow_events
       WHERE issue_id = ? AND type = 'retry.reused'
       ORDER BY ts ASC, rowid ASC`
    )
    .all(issueId) as ReuseEventRow[];
  const out: ReuseRecord[] = [];
  for (const row of rows) {
    if (!row.payload_json || !row.worker_session_id) continue;
    try {
      const parsed = RetryReusedPayload.safeParse(JSON.parse(row.payload_json));
      if (!parsed.success) continue;
      out.push({
        sessionId: row.worker_session_id,
        kinds: parsed.data.kinds,
        retryReason: parsed.data.retryReason,
        ts: row.ts,
        cursor: row.cursor,
      });
    } catch {
      // malformed evidence never drives metrics
    }
  }
  return out;
}

/** Exact agent-process boundaries per session from durable agent.* events. */
export function listAgentBoundariesForIssue(issueId: string): AgentBoundary[] {
  const rows = getDb()
    .prepare(
      `SELECT worker_session_id AS sessionId, type, ts FROM workflow_events
       WHERE issue_id = ? AND type IN ('agent.started', 'agent.completed')
       ORDER BY ts ASC, rowid ASC`
    )
    .all(issueId) as Array<{ sessionId: string | null; type: string; ts: string }>;
  const starts = new Map<string, number>();
  const ends = new Map<string, number>();
  for (const row of rows) {
    if (!row.sessionId) continue;
    const ms = msOf(row.ts);
    if (ms === null) continue;
    if (row.type === "agent.started" && !starts.has(row.sessionId)) starts.set(row.sessionId, ms);
    if (row.type === "agent.completed" && !ends.has(row.sessionId)) ends.set(row.sessionId, ms);
  }
  const ids = new Set([...starts.keys(), ...ends.keys()]);
  return [...ids].map((sessionId) => ({
    sessionId,
    startMs: starts.get(sessionId) ?? null,
    endMs: ends.get(sessionId) ?? null,
  }));
}

/** Sessions that ran the no-agent publish path (worker terminal carries publishOnly). */
export function listPublishOnlySessionsForIssue(issueId: string): Set<string> {
  const rows = getDb()
    .prepare(
      `SELECT worker_session_id AS sessionId, payload_json AS payload FROM workflow_events
       WHERE issue_id = ? AND type IN ('worker.completed', 'worker.failed')`
    )
    .all(issueId) as Array<{ sessionId: string | null; payload: string | null }>;
  const out = new Set<string>();
  for (const row of rows) {
    if (!row.sessionId || !row.payload) continue;
    try {
      const payload = JSON.parse(row.payload) as { publishOnly?: unknown };
      if (payload.publishOnly === true) out.add(row.sessionId);
    } catch {
      // ignore malformed payloads
    }
  }
  return out;
}

/** Per-session work-item payload hints for legacy retry derivation. */
export function sessionHintsForIssue(issueId: string): Map<string, RetrySessionHint> {
  const rows = getDb()
    .prepare("SELECT worker_session_id AS sessionId, payload_json AS payload FROM work_items WHERE issue_id = ?")
    .all(issueId) as Array<{ sessionId: string | null; payload: string | null }>;
  const out = new Map<string, RetrySessionHint>();
  for (const row of rows) {
    if (!row.sessionId) continue;
    let publishOnly = false;
    let retryReason: string | null = null;
    if (row.payload) {
      try {
        const payload = JSON.parse(row.payload) as { publishOnly?: unknown; retryReason?: unknown };
        publishOnly = payload.publishOnly === true;
        retryReason = typeof payload.retryReason === "string" ? payload.retryReason : null;
      } catch {
        // keep defaults
      }
    }
    out.set(row.sessionId, { publishOnly, retryReason });
  }
  return out;
}
