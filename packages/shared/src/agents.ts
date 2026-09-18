import { z } from "zod";
import { PhaseBudget, parsePhaseBudget, serializePhaseBudget } from "./budget.js";
import { Runtime } from "./runtime.js";
import { PermissionPolicyOverride, ReasoningEffort } from "./profile-snapshot.js";

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
    /** @deprecated NOT-149 — no longer emitted; workspace is not an Agent concept. */
    "workspace_missing",
    /** Agent has no Deck — Dealer workers are fail-closed without one (NOT-149). */
    "deck_missing",
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
  /**
   * Dead legacy storage (NOT-149). Retained so existing rows migrate safely; never shown
   * in UI, never required by health/admission, and never copied into new profile snapshots.
   */
  workspaceRoot: z.string().nullable(),
  /** Required for any Agent used for execution — Dealer never starts without a Deck. */
  deckId: z.string().uuid().nullable(),
  deckName: z.string().nullable(),
  /** Dead legacy storage (NOT-149) — playbooks are chosen dynamically inside the Deck. */
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
  /**
   * Default reasoning effort (NOT-81). Null = runtime default. Applied only for runtimes
   * that expose a CLI-level effort control (Codex / Claude Code); Cursor ignores it.
   */
  defaultEffort: ReasoningEffort.nullable(),
  /** Serialized PhaseBudget for issue-centric sessions; null = runtime default. */
  defaultBudgetJson: z.string().nullable(),
  /** Free-text description of what this profile is for (shown in the picker, snapshotted). */
  purpose: z.string().nullable(),
  /** Dead legacy storage (NOT-149). */
  playbookIdsJson: z.string().nullable(),
  /** Dead legacy storage (NOT-149). */
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
  /** Exactly one Agent Deck — required; workers never start in no-Deck/degraded mode. */
  deckId: z.string().uuid(),
  defaultModel: z.string().nullable().optional(),
  defaultEffort: ReasoningEffort.nullable().optional(),
  defaultBudget: PhaseBudget.nullable().optional(),
  purpose: z.string().nullable().optional(),
  permissionPolicy: PermissionPolicyOverride.nullable().optional(),
});
export type CreateAgentInput = z.infer<typeof CreateAgentInput>;

export const UpdateAgentInput = z.object({
  name: z.string().min(1).optional(),
  runtime: Runtime.optional(),
  /** Null clears the deck (unhealthy until set again); omit leaves unchanged. */
  deckId: z.string().uuid().nullable().optional(),
  defaultModel: z.string().nullable().optional(),
  defaultEffort: ReasoningEffort.nullable().optional(),
  defaultBudget: PhaseBudget.nullable().optional(),
  purpose: z.string().nullable().optional(),
  permissionPolicy: PermissionPolicyOverride.nullable().optional(),
});
export type UpdateAgentInput = z.infer<typeof UpdateAgentInput>;

export const AgentsSnapshot = z.object({
  agents: z.array(AgentWithHealth),
  issueCount: z.number(),
});
export type AgentsSnapshot = z.infer<typeof AgentsSnapshot>;

// The effective execution defaults for a profile.
//
// NOT-71 collapsed the plan/execute pair into one role-neutral column, but profiles
// persisted before that still carry values only in the legacy columns. This is the
// narrow read-compatibility path for those rows: it is the single definition of
// "what this profile actually runs with", shared by the snapshot builder and the
// agent edit form so the UI can never show blank while a hidden legacy value is in
// force. updateAgent() normalizes the legacy columns away on the next write, so a
// profile only takes this fallback until it is next edited.

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
