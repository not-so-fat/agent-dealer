// packages/server/src/coordinator/profile-snapshot.ts
//
// Freezes a reusable agent profile into the immutable per-session execution contract
// that gets stored on worker_sessions.profile_snapshot_json when the session is created.
// A later edit to the profile never changes a queued or running session (design
// §"Immutable execution-profile snapshot" / NOT-60 acceptance criteria).
import type { AgentProfile, ProfileSnapshot, WorkerSessionRole } from "@agent-dealer/shared";
import {
  resolveProfileBudgetJson,
  resolveProfileModel,
} from "@agent-dealer/shared";
import { resolveSessionPermissionPolicy } from "./permissions.js";

export function buildProfileSnapshot(agent: AgentProfile, role: WorkerSessionRole): ProfileSnapshot {
  return {
    version: 1,
    agentId: agent.id,
    role,
    runtime: agent.runtime,
    model: resolveProfileModel(agent),
    effort: agent.defaultEffort,
    budgetJson: resolveProfileBudgetJson(agent),
    permissionPolicy: resolveSessionPermissionPolicy(role, agent.permissionPolicyJson),
    deckId: agent.deckId,
    purpose: agent.purpose,
    capturedAt: new Date().toISOString(),
  };
}

export function serializeProfileSnapshot(snapshot: ProfileSnapshot): string {
  return JSON.stringify(snapshot);
}
