// packages/shared/src/execution-analysis.ts
//
// NOT-173: stable read-model contract for issue-level explanations and
// fleet-level runtime/model comparison (epic NOT-161, contract
// docs/EXECUTION_ANALYSIS.md). These are derived views — response schemas and
// types only. The server composes them from durable evidence; nothing here
// captures telemetry or changes control-plane policy.
//
// Missing-data rules (§4/§8 of the contract): null provider fields stay null
// with known/total counts and are never coerced to zero; aggregates take the
// weakest quality among the known inputs plus `partial_sample` when
// known < total; known = 0 is `unavailable`, never 0.
import { z } from "zod";
import { FailureCause } from "./failure-cause.js";

/** Evidence quality tier for one derived metric (§4). */
export const ExecutionQuality = z.enum(["exact", "inferred", "unavailable"]);
export type ExecutionQuality = z.infer<typeof ExecutionQuality>;

/** Quality label plus machine-readable reason codes for one field. */
export const QualityMeta = z.object({
  quality: ExecutionQuality,
  reasons: z.array(z.string()),
});
export type QualityMeta = z.infer<typeof QualityMeta>;

/** Top-level wall-clock phases (§2). `coordinator_work` covers publish-only
 * attempts that ran no agent process. */
export const ExecutionPhase = z.enum([
  "queue_wait",
  "coordinator_setup",
  "agent_process",
  "coordinator_validation_publish",
  "coordinator_work",
]);
export type ExecutionPhase = z.infer<typeof ExecutionPhase>;

/** One half-open [startMs, endMs) interval with its own quality. Null bounds
 * mean the boundary is not defensibly known (§8). */
export const PhaseInterval = z.object({
  phase: ExecutionPhase,
  /** Epoch ms, inclusive. Null when unavailable. */
  startMs: z.number().int().nullable(),
  /** Epoch ms, exclusive. Null when open or unavailable. */
  endMs: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  quality: ExecutionQuality,
  reasons: z.array(z.string()),
  /** Worker session this raw interval came from, when attributable. */
  sessionId: z.string().nullable(),
  /** Durable workflow_events rowid cursor for same-millisecond ordering (§1). */
  startCursor: z.number().int().nullable(),
  endCursor: z.number().int().nullable(),
});
export type PhaseInterval = z.infer<typeof PhaseInterval>;

/** Unioned duration for one phase across all attempts of an issue (§3 rule 2):
 * the union of that phase's raw intervals, then summed, so overlapping or
 * retried evidence is not double-counted. */
export const UnionedPhaseDuration = QualityMeta.extend({
  phase: ExecutionPhase,
  durationMs: z.number().int().nullable(),
  /** Raw intervals unioned into this total. */
  rawCount: z.number().int(),
  /** Unioned intervals counted (known) of raw total — mirrors known/total. */
  known: z.number().int(),
  total: z.number().int(),
});
export type UnionedPhaseDuration = z.infer<typeof UnionedPhaseDuration>;

/** A nested drill-down interval (§2): explains its parent phase, never adds
 * to the exclusive total (§3 rule 3). */
export const NestedInterval = z.object({
  kind: z.enum(["admission_dependency_wait", "runtime_health_preflight", "unexplained_silence", "human_wait"]),
  startMs: z.number().int().nullable(),
  endMs: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  quality: ExecutionQuality,
  reasons: z.array(z.string()),
  /** Category within the kind (queue-wait reason category, silence cause, …). */
  category: z.string().nullable(),
  sessionId: z.string().nullable(),
});
export type NestedInterval = z.infer<typeof NestedInterval>;

/** Aggregate over known observations with completeness counts (§4). */
export const CoveredTotal = QualityMeta.extend({
  value: z.number().nullable(),
  known: z.number().int(),
  total: z.number().int(),
});
export type CoveredTotal = z.infer<typeof CoveredTotal>;

/** Nearest-rank percentile over comparable non-null observations (§3 rule 6)
 * with its sample count. Null p50/p95 means n = 0. */
export const PercentileStat = QualityMeta.extend({
  p50: z.number().nullable(),
  p95: z.number().nullable(),
  n: z.number().int(),
});
export type PercentileStat = z.infer<typeof PercentileStat>;

/** Per-attempt evidence: role/runtime/model/status plus that attempt's
 * intervals, failures, silence, and provider values. */
export const AttemptAnalysis = z.object({
  sessionId: z.string(),
  role: z.string(),
  runtime: z.string().nullable(),
  model: z.string().nullable(),
  status: z.string(),
  round: z.number().int(),
  publishOnly: z.boolean(),
  setup: PhaseInterval,
  agentProcess: PhaseInterval,
  validationPublish: PhaseInterval,
  /** Coordinator-measured spawn envelope (usage_events.duration_ms) — resource
   * evidence only, never CLI runtime (§6.1). */
  spawnEnvelopeMs: z.number().int().nullable(),
  spawnEnvelopeQuality: ExecutionQuality,
  spawnEnvelopeReasons: z.array(z.string()),
  failureCauses: z.array(FailureCause),
  /** Silence intervals nested inside this attempt's agent_process (§5). */
  silence: z.array(NestedInterval),
  silenceQuality: ExecutionQuality,
  silenceReasons: z.array(z.string()),
  tokensIn: z.number().int().nullable(),
  tokensOut: z.number().int().nullable(),
  costUsd: z.number().nullable(),
  usageDurationMs: z.number().int().nullable(),
  usageQuality: ExecutionQuality,
  usageReasons: z.array(z.string()),
});
export type AttemptAnalysis = z.infer<typeof AttemptAnalysis>;

export const FirstCheckpointView = z.object({
  kind: z.string().nullable(),
  observedSha: z.string().nullable(),
  msSinceWorkflowStart: z.number().int().nullable(),
  quality: ExecutionQuality,
  reasons: z.array(z.string()),
});
export type FirstCheckpointView = z.infer<typeof FirstCheckpointView>;

export const RetryReuseView = z.object({
  attempts: z.number().int(),
  retries: z.number().int(),
  cold: z.number().int(),
  reused: z.number().int(),
  unknown: z.number().int(),
  publishOnly: z.number().int(),
  reuseRate: z.number().nullable(),
  quality: ExecutionQuality,
  reasons: z.array(z.string()),
});
export type RetryReuseView = z.infer<typeof RetryReuseView>;

export const ReviewerView = z.object({
  /** Reviewer sessions run. */
  rounds: z.number().int(),
  /** review.submitted verdict events observed. */
  verdicts: z.number().int(),
  changeRequests: z.number().int(),
  /** changeRequests / verdicts; null when no verdict is recorded. */
  changeRequestRate: z.number().nullable(),
  quality: ExecutionQuality,
  reasons: z.array(z.string()),
});
export type ReviewerView = z.infer<typeof ReviewerView>;

/** The issue-level read model: answers every NOT-161 product question with
 * stable documented fields. */
export const IssueExecutionAnalysis = z.object({
  issueId: z.string(),
  /** Workflow start → completion (or open when still active). */
  elapsed: PhaseInterval,
  /** Raw intervals as recorded (§3 rule 1). */
  rawIntervals: z.array(PhaseInterval),
  /** Unioned duration per phase (§3 rule 2). */
  unionedDurations: z.array(UnionedPhaseDuration),
  /** Exclusive total over unioned top-level phases (human_wait excluded). */
  exclusiveTotalMs: z.number().int().nullable(),
  exclusiveTotalQuality: ExecutionQuality,
  exclusiveTotalReasons: z.array(z.string()),
  /** Nested drill-down intervals (never additive). */
  nested: z.array(NestedInterval),
  attempts: z.array(AttemptAnalysis),
  /** The single primary cause across the issue (first chronological actionable
   * cause), or null when no failure is recorded. */
  primaryFailure: FailureCause.nullable(),
  primaryFailureQuality: ExecutionQuality,
  primaryFailureReasons: z.array(z.string()),
  consequenceCauses: z.array(FailureCause),
  /** Failed-attempt resource waste over known values only (§4). */
  waste: z.object({
    failedAttempts: z.number().int(),
    publishOnlyAttempts: z.number().int(),
    runtimeMs: CoveredTotal,
    tokensIn: CoveredTotal,
    tokensOut: CoveredTotal,
    costUsd: CoveredTotal,
  }),
  firstCheckpoint: FirstCheckpointView,
  retry: RetryReuseView,
  reviewer: ReviewerView,
  humanWaitMs: z.number().int().nullable(),
  humanWaitQuality: ExecutionQuality,
  humanWaitReasons: z.array(z.string()),
  interventionCount: z.number().int(),
  /** Metadata coverage for duration, tokens, and cost over attempts. */
  coverage: z.object({
    duration: CoveredTotal,
    tokens: CoveredTotal,
    cost: CoveredTotal,
  }),
});
export type IssueExecutionAnalysis = z.infer<typeof IssueExecutionAnalysis>;

/** Bounded cohort filters. `from`/`to` are ISO-8601 UTC; when omitted the
 * conservative default window applies (see DEFAULT_COHORT_WINDOW_DAYS). */
export const CohortFilters = z.object({
  from: z.string().nullable().default(null),
  to: z.string().nullable().default(null),
  role: z.string().nullable().default(null),
  runtime: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  /** Worker-session status or workflow outcome, e.g. `done`, `failed`, `timed_out`. */
  status: z.string().nullable().default(null),
  /** Portable repo identity (`github.com/owner/repo`). */
  repo: z.string().nullable().default(null),
  limit: z.number().int().min(1).max(200).default(50),
  /** Offset over issues in the window (stable order: workflow start, then id). */
  offset: z.number().int().min(0).default(0),
});
export type CohortFilters = z.infer<typeof CohortFilters>;

/** Conservative default date window for the cohort endpoint (days). */
export const DEFAULT_COHORT_WINDOW_DAYS = 30;
/** Hard cap on the cohort date window (days). */
export const MAX_COHORT_WINDOW_DAYS = 365;

export const RateStat = QualityMeta.extend({
  numerator: z.number().int(),
  denominator: z.number().int(),
  rate: z.number().nullable(),
});
export type RateStat = z.infer<typeof RateStat>;

/** Completion/retry breakdown for one role/runtime/model slice. */
export const CohortSliceStat = z.object({
  key: z.string(),
  attempts: z.number().int(),
  successes: z.number().int(),
  successRate: z.number().nullable(),
  retries: z.number().int(),
  retryRate: z.number().nullable(),
  wallTimeMs: PercentileStat,
});
export type CohortSliceStat = z.infer<typeof CohortSliceStat>;

export const CohortExecutionReport = z.object({
  window: z.object({
    from: z.string(),
    to: z.string(),
    defaultApplied: z.boolean(),
  }),
  pagination: z.object({
    limit: z.number().int(),
    offset: z.number().int(),
    totalIssues: z.number().int(),
  }),
  /** Issues in this page that contributed to the aggregates. */
  issueIds: z.array(z.string()),
  /** P50/P95 + sample count for wall time by top-level phase. */
  phaseWallTime: z.record(z.string(), PercentileStat),
  /** Attempt success: done sessions / all sessions (attempt denominator). */
  attemptSuccess: RateStat,
  /** Issue success: issues whose latest workflow completed done / all issues
   * (issue denominator — separate from attempt success). */
  issueSuccess: RateStat,
  /** Primary failure counts/rates by cause code. */
  primaryFailures: z.array(z.object({ code: z.string(), count: z.number().int(), rate: z.number().nullable() })),
  primaryFailureDenominator: z.number().int(),
  /** Failed runtime/token/known-cost waste over known values only. */
  waste: z.object({
    failedAttempts: z.number().int(),
    runtimeMs: CoveredTotal,
    tokensIn: CoveredTotal,
    tokensOut: CoveredTotal,
    costUsd: CoveredTotal,
  }),
  checkpointLatencyMs: PercentileStat,
  retryReuse: RateStat,
  reviewer: z.object({
    rounds: z.number().int(),
    verdicts: z.number().int(),
    changeRequests: z.number().int(),
    changeRequestRate: z.number().nullable(),
    quality: ExecutionQuality,
    reasons: z.array(z.string()),
  }),
  humanInterventions: z.object({
    totalActions: z.number().int(),
    issuesWithIntervention: z.number().int(),
    humanWaitMs: PercentileStat,
  }),
  byRole: z.array(CohortSliceStat),
  byRuntime: z.array(CohortSliceStat),
  byModel: z.array(CohortSliceStat),
  /** Metadata coverage for duration, tokens, and cost. */
  coverage: z.object({
    duration: CoveredTotal,
    tokens: CoveredTotal,
    cost: CoveredTotal,
  }),
});
export type CohortExecutionReport = z.infer<typeof CohortExecutionReport>;
