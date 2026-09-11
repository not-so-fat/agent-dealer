import { z } from "zod";

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
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Issue = z.infer<typeof Issue>;

export const CreateIssueInput = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  acceptanceCriteria: z.string().optional(),
  repo: z.string().min(1),
  baseBranch: z.string().min(1).default("main"),
  developerAgentId: z.string().uuid(),
  reviewerAgentId: z.string().uuid(),
  maxReviewRounds: z.number().int().min(1).default(3),
  maxInfraAttempts: z.number().int().min(0).default(3),
  source: IssueSource.default("manual"),
  externalId: z.string().optional(),
  externalLabel: z.string().optional(),
  externalUrl: z.string().optional(),
});
export type CreateIssueInput = z.infer<typeof CreateIssueInput>;

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
  needs_human: ["developing", "repairing", "final_review", "done", "closed"],
  final_review: ["done", "repairing", "needs_human", "closed"],
  done: [],
  closed: [],
};

export function canTransitionIssue(from: IssueStatus, to: IssueStatus): boolean {
  return ISSUE_STATUS_TRANSITIONS[from].includes(to);
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
