import { z } from "zod";
import { Runtime } from "./runtime.js";

/** Built-in agent IDs — stable across installs. */
export const BUILTIN_AGENT_CLAUDE_ID = "00000000-0000-4000-a000-000000000001";
export const BUILTIN_AGENT_CURSOR_ID = "00000000-0000-4000-a000-000000000002";

export const AgentHealthIssue = z.object({
  code: z.enum(["cli_missing", "runtime_auth", "deck_offline", "workspace_missing"]),
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
});
export type CreateAgentInput = z.infer<typeof CreateAgentInput>;

export const UpdateAgentInput = z.object({
  name: z.string().min(1).optional(),
  runtime: Runtime.optional(),
  workspaceRoot: z.string().nullable().optional(),
  deckId: z.string().uuid().nullable().optional(),
  playbookId: z.string().nullable().optional(),
});
export type UpdateAgentInput = z.infer<typeof UpdateAgentInput>;

export const AgentsSnapshot = z.object({
  agents: z.array(AgentWithHealth),
  issueCount: z.number(),
});
export type AgentsSnapshot = z.infer<typeof AgentsSnapshot>;
