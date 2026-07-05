import type { AgentProfile, CreateAgentInput, Runtime, UpdateAgentInput } from "@agent-dealer/shared";
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
  is_builtin: number;
  created_at: string;
  updated_at: string;
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
    defaultPlanModel: row.default_plan_model,
    defaultExecuteModel: row.default_execute_model,
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
    INSERT INTO agents (id, name, runtime, deck_id, deck_name, playbook_id, workspace_root, default_plan_model, default_execute_model, is_builtin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    id,
    input.name.trim(),
    input.runtime,
    input.deckId ?? null,
    deckName ?? null,
    input.playbookId ?? null,
    input.workspaceRoot.trim(),
    input.defaultPlanModel ?? null,
    input.defaultExecuteModel ?? null,
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
  const defaultPlanModel =
    input.defaultPlanModel !== undefined ? input.defaultPlanModel : existing.defaultPlanModel;
  const defaultExecuteModel =
    input.defaultExecuteModel !== undefined ? input.defaultExecuteModel : existing.defaultExecuteModel;
  const resolvedDeckName =
    input.deckId !== undefined ? (input.deckId ? (deckName ?? null) : null) : existing.deckName;

  getDb()
    .prepare(`
      UPDATE agents SET name = ?, runtime = ?, deck_id = ?, deck_name = ?, playbook_id = ?, workspace_root = ?,
        default_plan_model = ?, default_execute_model = ?, updated_at = ?
      WHERE id = ?
    `)
    .run(
      name,
      runtime,
      deckId,
      resolvedDeckName,
      playbookId,
      workspaceRoot,
      defaultPlanModel,
      defaultExecuteModel,
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
