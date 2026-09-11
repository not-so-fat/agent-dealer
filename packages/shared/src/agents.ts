import { z } from "zod";
import { PhaseBudget } from "./budget.js";
import { Runtime } from "./runtime.js";
import { PermissionPolicyOverride } from "./profile-snapshot.js";

/** Built-in agent IDs — stable across installs. */
export const BUILTIN_AGENT_CLAUDE_ID = "00000000-0000-4000-a000-000000000001";
export const BUILTIN_AGENT_CURSOR_ID = "00000000-0000-4000-a000-000000000002";
export const BUILTIN_AGENT_CODEX_ID = "00000000-0000-4000-a000-000000000003";

/** Cursor CLI model id for Auto + Composer subscription pool (not IDE default). */
export const CURSOR_DEFAULT_MODEL = "auto";

/** Cursor models that draw from the Auto + Composer pool on individual Pro plans. */
export const CURSOR_SUBSCRIPTION_MODEL_IDS = ["auto", "composer-2.5", "composer-2.5-fast"] as const;

export const AgentHealthIssue = z.object({
  code: z.enum(["cli_missing", "runtime_auth", "deck_offline", "workspace_missing", "mcp_not_registered"]),
  message: z.string(),
});
export type AgentHealthIssue = z.infer<typeof AgentHealthIssue>;

export const AgentProfile = z.object({
  id: z.string().uuid(),
  name: z.string(),
  runtime: Runtime,
  workspaceRoot: z.string().nullable(),
  deckId: z.string().uuid().nullable(),
  deckName: z.string().nullable(),
  playbookId: z.string().nullable(),
  /** CLI model id for planning; null = runtime default */
  defaultPlanModel: z.string().nullable(),
  /** CLI model id for execution; null = runtime default */
  defaultExecuteModel: z.string().nullable(),
  /** Serialized PhaseBudget; null = runtime default (no CLI caps) */
  defaultPlanBudgetJson: z.string().nullable(),
  /** Serialized PhaseBudget; null = runtime default (no CLI caps) */
  defaultExecuteBudgetJson: z.string().nullable(),
  /** Role-neutral CLI model id for issue-centric developer/reviewer sessions; null = runtime default. */
  defaultModel: z.string().nullable(),
  /** Serialized PhaseBudget for issue-centric sessions; null = runtime default. */
  defaultBudgetJson: z.string().nullable(),
  /** Free-text description of what this profile is for (shown in the picker, snapshotted). */
  purpose: z.string().nullable(),
  /** Serialized string[] of Agent Deck playbook ids the worker may load. */
  playbookIdsJson: z.string().nullable(),
  /** Serialized string[] of external-memory references (vault paths, doc urls). */
  externalMemoryRefsJson: z.string().nullable(),
  /** Serialized PermissionPolicyOverride — may only tighten the role's capabilities. */
  permissionPolicyJson: z.string().nullable(),
  isBuiltin: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgentProfile = z.infer<typeof AgentProfile>;

export const AgentWithHealth = AgentProfile.extend({
  healthy: z.boolean(),
  issues: z.array(AgentHealthIssue),
});
export type AgentWithHealth = z.infer<typeof AgentWithHealth>;

export const CreateAgentInput = z.object({
  name: z.string().min(1),
  runtime: Runtime,
  workspaceRoot: z.string().min(1),
  deckId: z.string().uuid().optional(),
  playbookId: z.string().optional(),
  defaultPlanModel: z.string().nullable().optional(),
  defaultExecuteModel: z.string().nullable().optional(),
  defaultPlanBudget: PhaseBudget.nullable().optional(),
  defaultExecuteBudget: PhaseBudget.nullable().optional(),
  defaultModel: z.string().nullable().optional(),
  defaultBudget: PhaseBudget.nullable().optional(),
  purpose: z.string().nullable().optional(),
  playbookIds: z.array(z.string()).nullable().optional(),
  externalMemoryRefs: z.array(z.string()).nullable().optional(),
  permissionPolicy: PermissionPolicyOverride.nullable().optional(),
});
export type CreateAgentInput = z.infer<typeof CreateAgentInput>;

export const UpdateAgentInput = z.object({
  name: z.string().min(1).optional(),
  runtime: Runtime.optional(),
  workspaceRoot: z.string().nullable().optional(),
  deckId: z.string().uuid().nullable().optional(),
  playbookId: z.string().nullable().optional(),
  defaultPlanModel: z.string().nullable().optional(),
  defaultExecuteModel: z.string().nullable().optional(),
  defaultPlanBudget: PhaseBudget.nullable().optional(),
  defaultExecuteBudget: PhaseBudget.nullable().optional(),
  defaultModel: z.string().nullable().optional(),
  defaultBudget: PhaseBudget.nullable().optional(),
  purpose: z.string().nullable().optional(),
  playbookIds: z.array(z.string()).nullable().optional(),
  externalMemoryRefs: z.array(z.string()).nullable().optional(),
  permissionPolicy: PermissionPolicyOverride.nullable().optional(),
});
export type UpdateAgentInput = z.infer<typeof UpdateAgentInput>;

export const AgentsSnapshot = z.object({
  agents: z.array(AgentWithHealth),
  issueCount: z.number(),
});
export type AgentsSnapshot = z.infer<typeof AgentsSnapshot>;
