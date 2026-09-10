import { z } from "zod";
import { Runtime } from "./runtime.js";
import { WorkerSessionRole } from "./worker-sessions.js";

/**
 * The effective capabilities a worker session may exercise at the runtime boundary
 * (ADR 0003 §Role permissions). Resolved once when the session is created and frozen
 * into `worker_sessions.profile_snapshot_json` — a later profile edit never changes a
 * queued or running session.
 *
 * Role defaults are the ceiling: a profile's `permissionPolicy` override may only
 * *tighten* a capability (turn it off), never grant one the role does not have.
 */
export const PermissionPolicy = z.object({
  /** developer only: read/write files in its own worktree. */
  worktreeWrite: z.boolean(),
  /** developer only: `git push` the issue branch. */
  push: z.boolean(),
  /** developer only: create / update the draft PR. */
  openPr: z.boolean(),
  /** never true in v1 — the coordinator, not the reviewer, publishes the review. */
  publishReview: z.boolean(),
  /** call outbound-mutation deck tools (`call_service_tool`). Off for both roles in v1. */
  outboundMutation: z.boolean(),
  /** resolve human actions / edit workflow topology. Always off for workers. */
  resolveHumanAction: z.boolean(),
});
export type PermissionPolicy = z.infer<typeof PermissionPolicy>;

/** The subset of a policy a profile may pin off. Absent field = use the role default. */
export const PermissionPolicyOverride = z
  .object({
    worktreeWrite: z.boolean().optional(),
    push: z.boolean().optional(),
    openPr: z.boolean().optional(),
    outboundMutation: z.boolean().optional(),
  })
  .strict();
export type PermissionPolicyOverride = z.infer<typeof PermissionPolicyOverride>;

export const DEVELOPER_ROLE_CEILING: PermissionPolicy = {
  worktreeWrite: true,
  push: true,
  openPr: true,
  publishReview: false,
  outboundMutation: false,
  resolveHumanAction: false,
};

export const REVIEWER_ROLE_CEILING: PermissionPolicy = {
  worktreeWrite: false,
  push: false,
  openPr: false,
  publishReview: false,
  outboundMutation: false,
  resolveHumanAction: false,
};

export function roleCeiling(role: z.infer<typeof WorkerSessionRole>): PermissionPolicy {
  return role === "developer" ? DEVELOPER_ROLE_CEILING : REVIEWER_ROLE_CEILING;
}

/**
 * The immutable execution contract snapshotted onto every `worker_session` at creation
 * (design §`agents` / §"Immutable execution-profile snapshot"). Transcripts, findings,
 * and usage stay owned by the issue/session — completing work never writes anything back
 * into the profile.
 */
export const ProfileSnapshot = z.object({
  /** Schema version so an in-flight session stays reconstructable across format changes. */
  version: z.literal(1),
  agentId: z.string().nullable(),
  role: WorkerSessionRole,
  runtime: Runtime.nullable(),
  model: z.string().nullable(),
  /** Serialized PhaseBudget; null = runtime default (no CLI caps). */
  budgetJson: z.string().nullable(),
  permissionPolicy: PermissionPolicy,
  deckId: z.string().nullable(),
  workspaceRoot: z.string().nullable(),
  playbookIds: z.array(z.string()),
  externalMemoryRefs: z.array(z.string()),
  purpose: z.string().nullable(),
  capturedAt: z.string(),
});
export type ProfileSnapshot = z.infer<typeof ProfileSnapshot>;

export function parseProfileSnapshot(json: string | null | undefined): ProfileSnapshot | null {
  if (!json?.trim()) return null;
  try {
    return ProfileSnapshot.parse(JSON.parse(json));
  } catch {
    return null;
  }
}

/** Serialized `string[]` helpers for the profile list columns. */
export function serializeStringList(list: readonly string[] | null | undefined): string | null {
  if (!list) return null;
  const cleaned = list.map((s) => s.trim()).filter(Boolean);
  return cleaned.length ? JSON.stringify(cleaned) : null;
}

export function parseStringList(json: string | null | undefined): string[] {
  if (!json?.trim()) return [];
  try {
    const parsed = JSON.parse(json);
    return z.array(z.string()).parse(parsed);
  } catch {
    return [];
  }
}

export function serializePermissionPolicyOverride(
  override: PermissionPolicyOverride | null | undefined
): string | null {
  if (!override) return null;
  const entries = Object.entries(override).filter(([, v]) => v !== undefined);
  return entries.length ? JSON.stringify(Object.fromEntries(entries)) : null;
}

export function parsePermissionPolicyOverride(
  json: string | null | undefined
): PermissionPolicyOverride | null {
  if (!json?.trim()) return null;
  try {
    return PermissionPolicyOverride.parse(JSON.parse(json));
  } catch {
    return null;
  }
}

/** Apply a profile override to a role ceiling. Override can only turn capabilities off. */
export function resolvePermissionPolicy(
  role: z.infer<typeof WorkerSessionRole>,
  override: PermissionPolicyOverride | null | undefined
): PermissionPolicy {
  const ceiling = roleCeiling(role);
  if (!override) return { ...ceiling };
  const resolved: PermissionPolicy = { ...ceiling };
  for (const key of ["worktreeWrite", "push", "openPr", "outboundMutation"] as const) {
    if (override[key] === false) resolved[key] = false;
    // override[key] === true can never raise the ceiling — ignored.
  }
  return resolved;
}
