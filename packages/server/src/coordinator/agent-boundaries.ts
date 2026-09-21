// packages/server/src/coordinator/agent-boundaries.ts
//
// NOT-169: durable setup / agent-process / validation-publish boundaries.
//
// `worker.started` is written before worktree setup; `worker.completed/failed` after
// validation/publish. The two agent events below fill the gap between them:
//   coordinator setup       = worker.started → agent.started
//   agent process           = agent.started → agent.completed
//   validation/publish      = agent.completed → worker.completed/failed
// Ordering for same-millisecond boundaries is the durable insertion cursor
// (workflow_events rowid), never ts alone (EXECUTION_ANALYSIS.md §1).
import { appendWorkflowEvent } from "../repository/workflow-events.js";
import type { SessionRole } from "./session-progress.js";
import { workerSessionPayload } from "./session-progress.js";

export interface AgentStartedEvidence {
  issueId: string;
  workflowInstanceId: string;
  workerSessionId: string;
  role: SessionRole;
  stage: string;
  round: number;
  runtime: string | null;
  model: string | null;
  pid: number;
}

/** Emitted only after the CLI child actually exists — the onSpawn callback is the source of truth. */
export function emitAgentStarted(ev: AgentStartedEvidence): void {
  appendWorkflowEvent({
    issueId: ev.issueId,
    workflowInstanceId: ev.workflowInstanceId,
    workerSessionId: ev.workerSessionId,
    type: "agent.started",
    actorType: ev.role,
    stage: ev.stage,
    round: ev.round,
    payload: {
      ...workerSessionPayload({ runtime: ev.runtime, model: ev.model, sessionId: ev.workerSessionId }),
      role: ev.role,
      round: ev.round,
      runtime: ev.runtime,
      model: ev.model,
      pid: ev.pid,
    },
    idempotencyKey: `agent-started:${ev.workerSessionId}`,
  });
}

export interface AgentCompletedEvidence {
  issueId: string;
  workflowInstanceId: string;
  workerSessionId: string;
  role: SessionRole;
  stage: string;
  round: number;
  runtime: string | null;
  model: string | null;
  pid: number | null;
  exitCode: number | null;
  timedOut: boolean;
  /** Coordinator abort (lease lost / shutdown) killed or preceded the exit. */
  aborted: boolean;
  /** The spawn attempt threw after process creation (no exit code observed). */
  thrown: boolean;
}

/**
 * Exactly once per spawned process, at child exit and before any receipt mining, usage
 * extraction, or validation. Carries the raw exit/timeout/abort outcome only — no
 * failure classification (that is a derived view, NOT-167 §7).
 */
export function emitAgentCompleted(ev: AgentCompletedEvidence): void {
  appendWorkflowEvent({
    issueId: ev.issueId,
    workflowInstanceId: ev.workflowInstanceId,
    workerSessionId: ev.workerSessionId,
    type: "agent.completed",
    actorType: ev.role,
    stage: ev.stage,
    round: ev.round,
    payload: {
      ...workerSessionPayload({ runtime: ev.runtime, model: ev.model, sessionId: ev.workerSessionId }),
      role: ev.role,
      round: ev.round,
      runtime: ev.runtime,
      model: ev.model,
      ...(ev.pid != null ? { pid: ev.pid } : {}),
      ...(ev.exitCode != null ? { exitCode: ev.exitCode } : {}),
      timedOut: ev.timedOut,
      ...(ev.aborted ? { aborted: true } : {}),
      ...(ev.thrown ? { thrown: true } : {}),
    },
    idempotencyKey: `agent-completed:${ev.workerSessionId}`,
  });
}

export interface HostSuspendedEvidence {
  issueId: string;
  workflowInstanceId: string;
  workerSessionId: string;
  role: "developer" | "reviewer";
  stage: string;
  round: number;
  /** Wall-clock ms at the tick that observed the jump. */
  detectedAt: number;
  /** No pre-jump lease may be reclaimed until this wall-clock time. */
  graceUntil: number;
  wallGapMs: number;
  unelapsedMs: number;
  unobservedMs: number;
}

/**
 * Durable evidence that clock-jump recovery protected an in-flight item. Idempotent per
 * session/jump via the idempotency key; observational only — never fails, retries, or
 * reassigns work itself.
 */
export function emitHostSuspended(ev: HostSuspendedEvidence): void {
  appendWorkflowEvent({
    issueId: ev.issueId,
    workflowInstanceId: ev.workflowInstanceId,
    workerSessionId: ev.workerSessionId,
    type: "host.suspended",
    actorType: ev.role,
    stage: ev.stage,
    round: ev.round,
    payload: {
      ...workerSessionPayload({ runtime: null, model: null, sessionId: ev.workerSessionId }),
      detectedAt: new Date(ev.detectedAt).toISOString(),
      graceUntil: new Date(ev.graceUntil).toISOString(),
      wallGapMs: ev.wallGapMs,
      unelapsedMs: ev.unelapsedMs,
      unobservedMs: ev.unobservedMs,
    },
    idempotencyKey: `host-suspended:${ev.workerSessionId}:${ev.detectedAt}`,
  });
}
