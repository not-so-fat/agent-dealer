import type { LinearCandidate, LinearIntakeConfig } from "@agent-dealer/shared";
import { listAgentsWithHealth } from "../adapters/agent-health.js";
import { listAgents } from "../repository/agents.js";

export interface AgentResolution {
  agentId: string;
  reason: string;
}

export async function resolveAgentForIssue(
  issue: LinearCandidate,
  settings: LinearIntakeConfig,
  explicitAgentId?: string
): Promise<AgentResolution> {
  if (explicitAgentId) {
    return { agentId: explicitAgentId, reason: "explicit agentId on promote" };
  }

  const issueLabels = new Set((issue.labels ?? []).map((l) => l.toLowerCase()));
  for (const rule of settings.routingRules) {
    if (issueLabels.has(rule.label.toLowerCase())) {
      return {
        agentId: rule.agentId,
        reason: `label:${rule.label} → configured agent`,
      };
    }
  }

  if (settings.defaultAgentId) {
    return {
      agentId: settings.defaultAgentId,
      reason: "linear.defaultAgentId",
    };
  }

  const agents = await listAgentsWithHealth(listAgents());
  const healthyWithWorkspace = agents.filter((a) => a.healthy && a.workspaceRoot);
  if (healthyWithWorkspace.length > 0) {
    const pick = healthyWithWorkspace[0]!;
    return {
      agentId: pick.id,
      reason: `first healthy agent with workspace (${pick.name})`,
    };
  }

  throw new Error(
    "No agent available — set defaultAgentId, routing rules, or configure a healthy agent with workspace"
  );
}
