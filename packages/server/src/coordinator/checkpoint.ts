// packages/server/src/coordinator/checkpoint.ts
//
// NOT-172: append-only checkpoint/reuse evidence writers.
//
// A checkpoint records that durable work survived an attempt (commit,
// verification receipt, pushed branch); a retry-reuse record captures which
// prior work a retry actually reused instead of starting cold. Both are stored
// as workflow_events rows (immutable evidence, EXECUTION_ANALYSIS.md §1) and
// are idempotent per session via idempotency keys: duplicate sampler ticks,
// recovery ticks, and coordinator restarts never duplicate rows.
//
// Evidence only — nothing here reads back into retry, routing, worktree, or
// commit decisions.
import type {
  CheckpointKind,
  CheckpointOrigin,
  RetryReuseKind,
} from "@agent-dealer/shared";
import { appendWorkflowEvent } from "../repository/workflow-events.js";
import type { SessionRole } from "./session-progress.js";
import { workerSessionPayload } from "./session-progress.js";

export interface CheckpointEvidence {
  issueId: string;
  workflowInstanceId: string;
  workerSessionId: string;
  role: SessionRole;
  stage: string;
  round: number;
  kind: CheckpointKind;
  observedSha?: string | null;
  /** Coordinator observation time; defaults to now. Never an invented Git time. */
  observedAt?: string;
  origin?: CheckpointOrigin | null;
  inputSha?: string | null;
  samplingPrecisionMs?: number | null;
  branch?: string | null;
}

/**
 * Record one checkpoint kind for a session — at most once per (session, kind).
 * The commit kind additionally distinguishes its origin (sampler / salvage /
 * session_end) in the payload while sharing the kind-level idempotency key, so
 * a salvage commit and a sampler observation never double-count "first commit".
 */
export function emitCheckpointObserved(ev: CheckpointEvidence): void {
  appendWorkflowEvent({
    issueId: ev.issueId,
    workflowInstanceId: ev.workflowInstanceId,
    workerSessionId: ev.workerSessionId,
    type: "checkpoint.observed",
    actorType: ev.role,
    stage: ev.stage,
    round: ev.round,
    payload: {
      ...workerSessionPayload({ runtime: null, model: null, sessionId: ev.workerSessionId }),
      kind: ev.kind,
      observedSha: ev.observedSha ?? null,
      observedAt: ev.observedAt ?? new Date().toISOString(),
      origin: ev.kind === "commit" ? (ev.origin ?? null) : null,
      inputSha: ev.inputSha ?? null,
      samplingPrecisionMs: ev.samplingPrecisionMs ?? null,
      branch: ev.branch ?? null,
    },
    idempotencyKey: `checkpoint:${ev.workerSessionId}:${ev.kind}`,
  });
}

export interface RetryReuseEvidence {
  issueId: string;
  workflowInstanceId: string;
  workerSessionId: string;
  role: SessionRole;
  stage: string;
  round: number;
  /** Empty array marks an explicit cold retry — recorded, not omitted. */
  kinds: RetryReuseKind[];
  retryReason?: string | null;
}

/**
 * Record which prior work a retry/recovery actually reused — exactly once per
 * session. A cold retry is recorded with an empty kinds array so it stays
 * distinguishable from "no reuse evidence recorded".
 */
export function emitRetryReuse(ev: RetryReuseEvidence): void {
  appendWorkflowEvent({
    issueId: ev.issueId,
    workflowInstanceId: ev.workflowInstanceId,
    workerSessionId: ev.workerSessionId,
    type: "retry.reused",
    actorType: ev.role,
    stage: ev.stage,
    round: ev.round,
    payload: {
      ...workerSessionPayload({ runtime: null, model: null, sessionId: ev.workerSessionId }),
      kinds: ev.kinds,
      retryReason: ev.retryReason ?? null,
    },
    idempotencyKey: `retry-reused:${ev.workerSessionId}`,
  });
}
