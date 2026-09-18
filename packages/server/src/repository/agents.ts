import type { AgentProfile, CreateAgentInput, ReasoningEffort, Runtime, UpdateAgentInput } from "@agent-dealer/shared";
import {
  ReasoningEffort as ReasoningEffortSchema,
  resolveProfileBudgetJson,
  resolveProfileModel,
  serializePermissionPolicyOverride,
  serializePhaseBudget,
  serializeStringList,
} from "@agent-dealer/shared";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";

interface AgentRow {
  id: string;
  name: string;
  runtime: string;
  deck_id: string | null;
  deck_name: string | null;
  playbook_id: string | null;
  workspace_root: string | null;
  default_plan_model: string | null;
  default_execute_model: string | null;
  default_plan_budget_json: string | null;
  default_execute_budget_json: string | null;
  default_model: string | null;
  default_effort: string | null;
  default_budget_json: string | null;
  purpose: string | null;
  playbook_ids_json: string | null;
  external_memory_refs_json: string | null;
  permission_policy_json: string | null;
  is_builtin: number;
  created_at: string;
  updated_at: string;
}

function parseStoredEffort(raw: string | null | undefined): ReasoningEffort | null {
  if (!raw) return null;
  const parsed = ReasoningEffortSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function rowToAgent(row: AgentRow): AgentProfile {
  return {
    id: row.id,
    name: row.name,
    runtime: row.runtime as Runtime,
    workspaceRoot: row.workspace_root,
    deckId: row.deck_id,
    deckName: row.deck_name,
    playbookId: row.playbook_id,
    // Read-only legacy compatibility (NOT-71): no write path sets these any more, but
    // profile-snapshot.ts falls back to them for profiles saved before default_model /
    // default_budget_json existed, so dropping them here would silently change the model
    // and caps those sessions run under.
    defaultPlanModel: row.default_plan_model,
    defaultExecuteModel: row.default_execute_model,
    defaultPlanBudgetJson: row.default_plan_budget_json,
    defaultExecuteBudgetJson: row.default_execute_budget_json,
    defaultModel: row.default_model,
    defaultEffort: parseStoredEffort(row.default_effort),
    defaultBudgetJson: row.default_budget_json,
    purpose: row.purpose,
    playbookIdsJson: row.playbook_ids_json,
    externalMemoryRefsJson: row.external_memory_refs_json,
    permissionPolicyJson: row.permission_policy_json,
    isBuiltin: row.is_builtin === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listAgents(): AgentProfile[] {
  const rows = getDb()
    .prepare("SELECT * FROM agents ORDER BY name ASC")
    .all() as AgentRow[];
  return rows.map(rowToAgent);
}

export function getAgent(id: string): AgentProfile | null {
  const row = getDb().prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
  return row ? rowToAgent(row) : null;
}

export function createAgent(input: CreateAgentInput, deckName?: string | null): AgentProfile {
  const db = getDb();
  const now = new Date().toISOString();
  const id = uuid();
  db.prepare(`
    INSERT INTO agents (
      id, name, runtime, deck_id, deck_name, playbook_id, workspace_root,
      default_model, default_effort, default_budget_json, purpose, playbook_ids_json, external_memory_refs_json, permission_policy_json,
      is_builtin, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    id,
    input.name.trim(),
    input.runtime,
    input.deckId ?? null,
    deckName ?? null,
    input.playbookId ?? null,
    input.workspaceRoot.trim(),
    input.defaultModel ?? null,
    input.defaultEffort ?? null,
    serializePhaseBudget(input.defaultBudget),
    input.purpose?.trim() || null,
    serializeStringList(input.playbookIds),
    serializeStringList(input.externalMemoryRefs),
    serializePermissionPolicyOverride(input.permissionPolicy),
    now,
    now
  );
  return getAgent(id)!;
}

export function updateAgent(id: string, input: UpdateAgentInput, deckName?: string | null): AgentProfile | null {
  const existing = getAgent(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const name = input.name?.trim() ?? existing.name;
  const runtime = input.runtime ?? existing.runtime;
  const workspaceRoot =
    input.workspaceRoot !== undefined ? input.workspaceRoot?.trim() || null : existing.workspaceRoot;
  const deckId = input.deckId !== undefined ? input.deckId : existing.deckId;
  const playbookId = input.playbookId !== undefined ? input.playbookId : existing.playbookId;
  // Collapse the pre-NOT-71 plan/execute columns into the role-neutral one on every write,
  // and clear them below. Reading them back (resolveProfile*) is deliberate compatibility for
  // rows written before the migration; continuing to *keep* them is not. Without this, editing
  // a legacy profile saved a null role-neutral model while the legacy column kept winning the
  // fallback — so the form showed blank while the session still ran the hidden value, and
  // switching runtime carried the old runtime's model into the new one's snapshot.
  const defaultModel =
    input.defaultModel !== undefined ? input.defaultModel : resolveProfileModel(existing);
  const defaultEffort =
    input.defaultEffort !== undefined ? input.defaultEffort : existing.defaultEffort;
  const defaultBudgetJson =
    input.defaultBudget !== undefined
      ? serializePhaseBudget(input.defaultBudget)
      : resolveProfileBudgetJson(existing);
  const purpose =
    input.purpose !== undefined ? input.purpose?.trim() || null : existing.purpose;
  const playbookIdsJson =
    input.playbookIds !== undefined ? serializeStringList(input.playbookIds) : existing.playbookIdsJson;
  const externalMemoryRefsJson =
    input.externalMemoryRefs !== undefined
      ? serializeStringList(input.externalMemoryRefs)
      : existing.externalMemoryRefsJson;
  const permissionPolicyJson =
    input.permissionPolicy !== undefined
      ? serializePermissionPolicyOverride(input.permissionPolicy)
      : existing.permissionPolicyJson;
  const resolvedDeckName =
    input.deckId !== undefined ? (input.deckId ? (deckName ?? null) : null) : existing.deckName;

  getDb()
    .prepare(`
      UPDATE agents SET name = ?, runtime = ?, deck_id = ?, deck_name = ?, playbook_id = ?, workspace_root = ?,
        default_model = ?, default_effort = ?, default_budget_json = ?, purpose = ?, playbook_ids_json = ?, external_memory_refs_json = ?, permission_policy_json = ?,
        default_plan_model = NULL, default_execute_model = NULL,
        default_plan_budget_json = NULL, default_execute_budget_json = NULL,
        updated_at = ?
      WHERE id = ?
    `)
    .run(
      name,
      runtime,
      deckId,
      resolvedDeckName,
      playbookId,
      workspaceRoot,
      defaultModel,
      defaultEffort,
      defaultBudgetJson,
      purpose,
      playbookIdsJson,
      externalMemoryRefsJson,
      permissionPolicyJson,
      now,
      id
    );

  return getAgent(id);
}

export function deleteAgent(id: string): boolean {
  const agent = getAgent(id);
  if (!agent) return false;
  getDb().prepare("DELETE FROM agents WHERE id = ?").run(id);
  return true;
}

export type ResolvedAgent = {
  agentId: string;
  agentName: string;
  runtime: Runtime;
  workspaceRoot?: string;
  deckId?: string;
  deckName?: string | null;
  playbookId?: string;
};

export function resolveAgent(agentId: string): ResolvedAgent {
  const agent = getAgent(agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);
  return {
    agentId: agent.id,
    agentName: agent.name,
    runtime: agent.runtime,
    workspaceRoot: agent.workspaceRoot ?? undefined,
    deckId: agent.deckId ?? undefined,
    deckName: agent.deckName,
    playbookId: agent.playbookId ?? undefined,
  };
}
