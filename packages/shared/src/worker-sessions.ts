import { z } from "zod";
import { Runtime } from "./runtime.js";

/** "legacy" is migration-only — the new coordinator never spawns it. */
export const WorkerSessionRole = z.enum(["developer", "reviewer", "legacy"]);
export type WorkerSessionRole = z.infer<typeof WorkerSessionRole>;

export const WorkerSessionStatus = z.enum([
  "queued",
  "running",
  "done",
  "failed",
  "timed_out",
  "cancelled",
]);
export type WorkerSessionStatus = z.infer<typeof WorkerSessionStatus>;

export const WorkerSession = z.object({
  id: z.string().uuid(),
  issueId: z.string().uuid(),
  role: WorkerSessionRole,
  round: z.number().int().min(1),
  agentId: z.string().uuid().nullable(),
  runtime: Runtime.nullable(),
  model: z.string().nullable(),
  budgetJson: z.string().nullable(),
  worktreePath: z.string().nullable(),
  /** Immutable SHA supplied to this session; required in practice for reviewer sessions. */
  inputSha: z.string().nullable(),
  status: WorkerSessionStatus,
  /** Runtime-native session id (e.g. Claude session_id) for resume/inspection. */
  sessionRef: z.string().nullable(),
  logPath: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  errorJson: z.string().nullable(),
  /** Migration/provider metadata (e.g. original legacy run id). */
  metadataJson: z.string().nullable(),
  /**
   * Immutable execution-profile snapshot (serialized ProfileSnapshot) frozen when the
   * session is created, so a later profile edit never rewrites this session's contract.
   */
  profileSnapshotJson: z.string().nullable(),
  /**
   * The spawned CLI's OS pid, the identity of the coordinator process that spawned it
   * (NOT-124), and that pid's OS-reported start time (NOT-131). All null until the CLI
   * actually starts, and for any session whose spawn never reports one.
   *
   * `processOwner` alone settles liveness for a pid this coordinator spawned. Across a
   * restart it no longer matches, and the pid on its own proves nothing — the OS recycles
   * pids, so `kill(pid, 0)` could succeed forever against an unrelated program.
   * `processStartedAt` is what keeps the evidence usable there: a recycled pid always
   * started later, so an exact match identifies the process and not merely the number. A
   * row written before NOT-131 has none and reads as "no evidence", never as alive.
   */
  processPid: z.number().int().nullable(),
  processOwner: z.string().nullable(),
  processStartedAt: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  heartbeatAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type WorkerSession = z.infer<typeof WorkerSession>;

export const CreateWorkerSessionInput = z.object({
  issueId: z.string().uuid(),
  role: WorkerSessionRole,
  round: z.number().int().min(1),
  agentId: z.string().uuid().nullable(),
  runtime: Runtime.nullable(),
  model: z.string().nullable().optional(),
  budgetJson: z.string().nullable().optional(),
  inputSha: z.string().nullable().optional(),
  metadataJson: z.string().nullable().optional(),
  profileSnapshotJson: z.string().nullable().optional(),
});
export type CreateWorkerSessionInput = z.infer<typeof CreateWorkerSessionInput>;
