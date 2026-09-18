import { z } from "zod";
import { GitHubRepoInput } from "./github-repo.js";

export const IssueStatus = z.enum([
  "ready",
  "developing",
  "reviewing",
  "repairing",
  "final_review",
  "needs_human",
  "done",
  "closed",
]);
export type IssueStatus = z.infer<typeof IssueStatus>;

export const IssueOwner = z.enum(["human", "developer", "reviewer", "system"]);
export type IssueOwner = z.infer<typeof IssueOwner>;

/** "agent" covers an issue a coding agent created via the API/CLI (PRD §5). */
export const IssueSource = z.enum(["manual", "linear", "agent"]);
export type IssueSource = z.infer<typeof IssueSource>;

export const Issue = z.object({
  id: z.string().uuid(),
  source: IssueSource,
  externalId: z.string().nullable(),
  externalLabel: z.string().nullable(),
  externalUrl: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  acceptanceCriteria: z.string().nullable(),
  /**
   * Portable GitHub identity (`github.com/owner/repo`) for new issues (NOT-149).
   * Legacy rows may still hold a local filesystem path until explicitly migrated —
   * the coordinator resolves those via an explicit compatibility path, never by guessing.
   */
  repo: z.string(),
  baseBranch: z.string(),
  status: IssueStatus,
  currentOwner: IssueOwner,
  currentIntent: z.string().nullable(),
  developerAgentId: z.string().uuid().nullable(),
  reviewerAgentId: z.string().uuid().nullable(),
  maxReviewRounds: z.number().int().min(1),
  currentRound: z.number().int().min(1),
  /** 0 is a valid policy: no automatic infra retry, escalate to a human immediately. */
  maxInfraAttempts: z.number().int().min(0),
  infraAttempts: z.number().int().min(0),
  branch: z.string().nullable(),
  baseSha: z.string().nullable(),
  headSha: z.string().nullable(),
  prNumber: z.number().int().nullable(),
  prUrl: z.string().nullable(),
  /**
   * When true, reviewer `approved` merges the PR and marks the issue done (skips
   * `final_review`). Kick UI defaults this on; API/CLI omit → false so existing
   * callers keep the human final-review path.
   */
  autoMerge: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Issue = z.infer<typeof Issue>;

export const CreateIssueInput = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  acceptanceCriteria: z.string().optional(),
  /** GitHub URL or `owner/repo` — normalized to `github.com/owner/repo` on parse. */
  repo: GitHubRepoInput,
  baseBranch: z.string().min(1).default("main"),
  developerAgentId: z.string().uuid(),
  reviewerAgentId: z.string().uuid(),
  maxReviewRounds: z.number().int().min(1).default(3),
  maxInfraAttempts: z.number().int().min(0).default(3),
  /** Kick UI sends true; omit/false preserves final_review after approve. */
  autoMerge: z.boolean().default(false),
  source: IssueSource.default("manual"),
  externalId: z.string().optional(),
  externalLabel: z.string().optional(),
  externalUrl: z.string().optional(),
  /**
   * NOT-118: a create directive, not an issue field — the route enqueues the new issue for
   * admission by default so creating one never starts a workflow behind the queue's back.
   * `false` creates a draft that sits outside the queue until someone adds or starts it.
   */
  enqueue: z.boolean().default(true),
});
/** Wire/API body shape — defaults applied by `CreateIssueInput.parse` / repository. */
export type CreateIssueInput = z.input<typeof CreateIssueInput>;

/** Pre-start (or parked-on-`needs_human`) edits only — the route enforces no active
 * workflow instance; status/owner/intent/branch/SHA/PR stay coordinator-owned. */
export const UpdateIssueInput = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  acceptanceCriteria: z.string().nullable().optional(),
  repo: GitHubRepoInput.optional(),
  baseBranch: z.string().min(1).optional(),
  developerAgentId: z.string().uuid().optional(),
  reviewerAgentId: z.string().uuid().optional(),
  maxReviewRounds: z.number().int().min(1).optional(),
  maxInfraAttempts: z.number().int().min(0).optional(),
  autoMerge: z.boolean().optional(),
});
export type UpdateIssueInput = z.infer<typeof UpdateIssueInput>;

/**
 * Guard rails only — which status the coordinator may move an issue to next.
 * The *specific* target within an allowed set (e.g. which needs_human resolution
 * leads where) is coordinator business logic, not encoded here, mirroring how
 * VALID_TRANSITIONS works for the legacy RunStatus table today.
 */
export const ISSUE_STATUS_TRANSITIONS: Record<IssueStatus, IssueStatus[]> = {
  ready: ["developing", "closed"],
  developing: ["developing", "reviewing", "needs_human", "closed"],
  // Self-loop matches developing/repairing below: a stale-review retry re-queues a fresh
  // reviewer at a newly verified head without leaving the "reviewing" stage.
  reviewing: ["reviewing", "repairing", "final_review", "needs_human", "closed"],
  repairing: ["repairing", "reviewing", "needs_human", "closed"],
  // "reviewing" lets a reviewer-side infra escalation (session_failed/publish_failed
  // exhausted) resume with a fresh reviewer session at the still-valid pinned head,
  // instead of always routing back through the developer.
  needs_human: ["developing", "reviewing", "repairing", "final_review", "done", "closed"],
  // Self-loop: human complete parks owner/intent for undraft+merge without leaving the stage.
  final_review: ["final_review", "done", "repairing", "needs_human", "closed"],
  done: [],
  closed: [],
};

export function canTransitionIssue(from: IssueStatus, to: IssueStatus): boolean {
  return ISSUE_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * The statuses a pass can never leave — derived from the transition table so the two cannot
 * drift. "Terminal" is a property of the *local* issue row, not of the upstream ticket: a
 * closed dealer issue for a still-open Linear ticket is the normal case a re-import serves
 * (NOT-141).
 */
export const TERMINAL_ISSUE_STATUSES: readonly IssueStatus[] = (
  Object.keys(ISSUE_STATUS_TRANSITIONS) as IssueStatus[]
).filter((status) => ISSUE_STATUS_TRANSITIONS[status].length === 0);

/** Membership test for {@link TERMINAL_ISSUE_STATUSES} — false means the pass can still move. */
export function isTerminalIssueStatus(status: IssueStatus): boolean {
  return TERMINAL_ISSUE_STATUSES.includes(status);
}

/**
 * What the request did to the admission queue — the *mutation*, not the intent. `enqueue`
 * is idempotent, so a re-import of an already-queued issue changes nothing; reporting that
 * as "queued" is how the CLI came to announce a queue action for a request that queued
 * nothing (NOT-141).
 */
export const QueueOutcome = z.enum(["enqueued", "already_queued", "not_queued"]);
export type QueueOutcome = z.infer<typeof QueueOutcome>;

/**
 * NOT-141: `POST /api/issues` answers with the issue *plus* what the server did with it.
 * `created: false` means the request matched a live issue for the same `(source,
 * externalId)` and re-enqueued it instead of making a second row — without these flags a
 * caller cannot tell an import from a no-op, and the CLI printed "Queued for admission" for
 * requests that queued nothing.
 */
export const CreateIssueResult = Issue.extend({
  created: z.boolean(),
  queue: QueueOutcome,
  /**
   * How many issues already existed for this `(source, externalId)` before the request (0
   * for a manual create). With `created: true` they are all terminal, so a non-zero count
   * means this import opened a *second* pass on a ticket dealer has already finished once —
   * callers should say that out loud instead of presenting it as a first import.
   */
  priorPasses: z.number().int().min(0),
});
export type CreateIssueResult = z.infer<typeof CreateIssueResult>;

/** 409 body when a re-import collides with a live issue — mirrors the runs promote path. */
export interface ExistingIssueConflict {
  error: string;
  existingIssueId: string;
  existingIssueStatus: IssueStatus;
}

/**
 * Issue-scoped artifact. Distinct from the legacy run-scoped `Artifact`: it is keyed
 * by `issueId` (+ optional `workerSessionId`), never a `runId`, so it validates on its
 * own terms rather than failing `Artifact.runId`'s UUID check.
 */
export const IssueArtifact = z.object({
  id: z.string(),
  issueId: z.string().nullable(),
  workerSessionId: z.string().nullable(),
  kind: z.string(),
  contentJson: z.string().nullable(),
  blobPath: z.string().nullable(),
  author: z.enum(["human", "agent", "system"]),
  createdAt: z.string(),
});
export type IssueArtifact = z.infer<typeof IssueArtifact>;
