// packages/shared/src/failure-cause.ts
//
// NOT-171: shared FailureCause contract for normalized first-actionable-cause
// classification (EXECUTION_ANALYSIS.md §7). A classification is a derived view:
// the raw reason text, error JSON, log path, and workflow evidence stay as recorded
// and are referenced, never replaced.
import { z } from "zod";

/** Closed failure taxonomy (EXECUTION_ANALYSIS.md §7). */
export const FailureCauseCode = z.enum([
  "authentication_configuration",
  "provider_capacity_rate_limit",
  "agent_cli_crash",
  "tool_test_timeout",
  "coordinator_crash",
  "validation_failure",
  "publish_git_failure",
  "agent_deck_unavailable",
  "host_sleep_liveness",
  "unknown",
]);
export type FailureCauseCode = z.infer<typeof FailureCauseCode>;

export const FailureCauseDomain = z.enum(["task", "infrastructure", "unknown"]);
export type FailureCauseDomain = z.infer<typeof FailureCauseDomain>;

export const FailureCauseConfidence = z.enum(["high", "medium", "low"]);
export type FailureCauseConfidence = z.infer<typeof FailureCauseConfidence>;

/** Where the supporting evidence came from. */
export const FailureEvidenceSource = z.enum([
  "outcome_kind",
  "session_error",
  "spawn_log",
  "workflow_event",
  "recovery",
]);
export type FailureEvidenceSource = z.infer<typeof FailureEvidenceSource>;

export const FailureCauseQuality = z.enum(["exact", "inferred"]);
export type FailureCauseQuality = z.infer<typeof FailureCauseQuality>;

export const FailureCause = z.object({
  code: FailureCauseCode,
  domain: FailureCauseDomain,
  /** First chronological actionable cause within the attempt; later causes are consequences. */
  primary: z.boolean(),
  confidence: FailureCauseConfidence,
  evidenceSource: FailureEvidenceSource,
  /** ISO-8601 UTC when the evidence occurred, when known. */
  occurredAt: z.string().nullable(),
  /** Durable workflow_events rowid cursor for ordering, when known. */
  eventCursor: z.number().int().nullable(),
  /** Raw reason text as recorded — never operator remediation prose. */
  rawReason: z.string(),
  sessionId: z.string().nullable(),
  logPath: z.string().nullable(),
  eventId: z.string().nullable(),
  eventType: z.string().nullable(),
  /** "inferred" marks backfill-on-read for legacy rows; fresh writes are "exact". */
  quality: FailureCauseQuality,
});
export type FailureCause = z.infer<typeof FailureCause>;

/**
 * Suggested default domain per code (EXECUTION_ANALYSIS.md §7). Evidence may
 * override with lower confidence; the classifier owns that decision.
 */
export const FAILURE_CAUSE_DEFAULT_DOMAIN: Record<FailureCauseCode, FailureCauseDomain> = {
  authentication_configuration: "infrastructure",
  provider_capacity_rate_limit: "infrastructure",
  agent_cli_crash: "infrastructure",
  tool_test_timeout: "task",
  coordinator_crash: "infrastructure",
  validation_failure: "task",
  publish_git_failure: "infrastructure",
  agent_deck_unavailable: "infrastructure",
  host_sleep_liveness: "infrastructure",
  unknown: "unknown",
};
