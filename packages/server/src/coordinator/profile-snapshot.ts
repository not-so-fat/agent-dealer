// packages/server/src/coordinator/profile-snapshot.ts
//
// Freezes a reusable agent profile into the immutable per-session execution contract
// that gets stored on worker_sessions.profile_snapshot_json when the session is created.
// A later edit to the profile never changes a queued or running session (design
// §"Immutable execution-profile snapshot" / NOT-60 acceptance criteria).
import type { AgentProfile, ProfileSnapshot, WorkerSessionRole } from "@agent-dealer/shared";
import { parsePhaseBudget, parseStringList, serializePhaseBudget } from "@agent-dealer/shared";
import { resolveSessionPermissionPolicy } from "./permissions.js";

/** Role-neutral model, falling back through the legacy phase columns (execute → plan). */
export function resolveProfileModel(agent: AgentProfile): string | null {
  return agent.defaultModel ?? agent.defaultExecuteModel ?? agent.defaultPlanModel ?? null;
}

/** Role-neutral budget JSON, same fallback order as the model. */
export function resolveProfileBudgetJson(agent: AgentProfile): string | null {
  const budget =
    parsePhaseBudget(agent.defaultBudgetJson) ??
    parsePhaseBudget(agent.defaultExecuteBudgetJson) ??
    parsePhaseBudget(agent.defaultPlanBudgetJson);
  return serializePhaseBudget(budget);
}

export function buildProfileSnapshot(agent: AgentProfile, role: WorkerSessionRole): ProfileSnapshot {
  return {
    version: 1,
    agentId: agent.id,
    role,
    runtime: agent.runtime,
    model: resolveProfileModel(agent),
    budgetJson: resolveProfileBudgetJson(agent),
    permissionPolicy: resolveSessionPermissionPolicy(role, agent.permissionPolicyJson),
    deckId: agent.deckId,
    workspaceRoot: agent.workspaceRoot,
    playbookIds: profilePlaybookIds(agent),
    externalMemoryRefs: parseStringList(agent.externalMemoryRefsJson),
    purpose: agent.purpose,
    capturedAt: new Date().toISOString(),
  };
}

/** The multi-playbook list, falling back to the single legacy playbook_id if unset. */
function profilePlaybookIds(agent: AgentProfile): string[] {
  const list = parseStringList(agent.playbookIdsJson);
  if (list.length) return list;
  return agent.playbookId ? [agent.playbookId] : [];
}

export function serializeProfileSnapshot(snapshot: ProfileSnapshot): string {
  return JSON.stringify(snapshot);
}
