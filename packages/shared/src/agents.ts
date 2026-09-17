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
  code: z.enum([
    "cli_missing",
    "runtime_auth",
    /**
     * Cursor macOS keychain stuck (errSecDuplicateItem / exit 45) — sessions die mid-run
     * even when status briefly looked logged-in (NOT-114 / NOT-103).
     */
    "cursor_keychain",
    "usage_capped",
    "deck_offline",
    "deck_unauthorized",
    "workspace_missing",
    "mcp_not_registered",
    /** GitHub CLI missing — issue workflows need `gh` to open/update draft PRs. */
    "github_cli_missing",
    /** `gh auth status` failed / token invalid — PR create will burn a developer round. */
    "github_auth",
  ]),
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
  /**
   * Legacy phase defaults, read-only since NOT-71: nothing writes these any more, but
   * profile-snapshot.ts still falls back to them so profiles saved before `defaultModel` /
   * `defaultBudgetJson` existed keep their configured model and caps.
   */
  defaultPlanModel: z.string().nullable(),
  defaultExecuteModel: z.string().nullable(),
  defaultPlanBudgetJson: z.string().nullable(),
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
