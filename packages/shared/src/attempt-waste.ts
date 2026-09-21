// packages/shared/src/attempt-waste.ts
//
// NOT-172: stable shared types for failed-attempt waste, first-checkpoint, and
// retry-reuse evidence (epic NOT-161, contract docs/EXECUTION_ANALYSIS.md).
//
// Checkpoints record that durable work survived an attempt; retry-reuse records
// which prior work a retry actually reused instead of starting cold. Both are
// stored append-only (workflow_events `checkpoint.observed` / `retry.reused`)
// and derived views never rewrite them.
import { z } from "zod";

/** What durable work a checkpoint vouches for. */
export const CheckpointKind = z.enum(["commit", "verification_receipt", "branch_pushed"]);
export type CheckpointKind = z.infer<typeof CheckpointKind>;

/**
 * How a `commit` checkpoint was observed. `sampler` is the coordinator-observed
 * first HEAD difference (sampling precision, not Git author time); `salvage` is
 * an auto-committed dirty worktree (NOT-145); `session_end` is a post-session
 * read when the sampler could not observe one (e.g. no input SHA to diff).
 */
export const CheckpointOrigin = z.enum(["sampler", "salvage", "session_end"]);
export type CheckpointOrigin = z.infer<typeof CheckpointOrigin>;

/** Which prior work a retry actually reused. Empty means a cold retry. */
export const RetryReuseKind = z.enum(["worktree", "commit", "verification_receipt", "publish_only"]);
export type RetryReuseKind = z.infer<typeof RetryReuseKind>;

export const CheckpointObservedPayload = z.object({
  kind: CheckpointKind,
  /** Observed HEAD for commit/pushed checkpoints; receipt tip for verification. */
  observedSha: z.string().nullable(),
  /** Coordinator observation time (ISO-8601 UTC) — never an invented Git time. */
  observedAt: z.string(),
  /** Only for kind `commit`. */
  origin: CheckpointOrigin.nullable(),
  /** Session input SHA the commit was diffed against (sampler only). */
  inputSha: z.string().nullable(),
  /** Sampler tick spacing that bounds the observation precision (sampler only). */
  samplingPrecisionMs: z.number().int().nullable(),
  branch: z.string().nullable(),
});
export type CheckpointObservedPayload = z.infer<typeof CheckpointObservedPayload>;

export const RetryReusedPayload = z.object({
  /** Empty array marks an explicit cold retry (no prior work reused). */
  kinds: z.array(RetryReuseKind),
  /** The retry reason the attempt started with, when any. */
  retryReason: z.string().nullable(),
});
export type RetryReusedPayload = z.infer<typeof RetryReusedPayload>;
