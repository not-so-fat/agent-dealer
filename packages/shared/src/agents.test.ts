import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CreateAgentInput,
  UpdateAgentInput,
  resolveProfileBudgetJson,
  resolveProfileModel,
  type AgentProfile,
} from "./agents.js";

const deckId = "00000000-0000-4000-a000-000000000099";

function profile(partial: Partial<AgentProfile>): AgentProfile {
  return {
    id: "00000000-0000-4000-a000-000000000001",
    name: "test",
    runtime: "claude_code",
    workspaceRoot: null,
    deckId,
    deckName: "test-deck",
    playbookId: null,
    defaultPlanModel: null,
    defaultExecuteModel: null,
    defaultPlanBudgetJson: null,
    defaultExecuteBudgetJson: null,
    defaultModel: null,
    defaultEffort: null,
    defaultBudgetJson: null,
    purpose: null,
    playbookIdsJson: null,
    externalMemoryRefsJson: null,
    permissionPolicyJson: null,
    isBuiltin: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

test("NOT-80: create/update agent inputs only accept role-neutral model/budget fields", () => {
  const created = CreateAgentInput.parse({
    name: "dev",
    runtime: "claude_code",
    deckId,
    defaultModel: "claude-sonnet-5",
    defaultBudget: { maxTurns: 40, maxBudgetUsd: 5 },
    // Legacy plan/execute keys must not be writable through the agent API.
    defaultPlanModel: "should-be-stripped",
    defaultExecuteModel: "should-be-stripped",
    defaultPlanBudget: { maxTurns: 1 },
    defaultExecuteBudget: { maxTurns: 1 },
  } as unknown);
  assert.equal(created.defaultModel, "claude-sonnet-5");
  assert.equal("defaultPlanModel" in created, false);
  assert.equal("defaultExecuteModel" in created, false);
  assert.equal("defaultPlanBudget" in created, false);
  assert.equal("defaultExecuteBudget" in created, false);

  const updated = UpdateAgentInput.parse({
    defaultModel: "claude-opus-5",
    defaultPlanModel: "ignored",
    defaultExecuteModel: "ignored",
  } as unknown);
  assert.equal(updated.defaultModel, "claude-opus-5");
  assert.equal("defaultPlanModel" in updated, false);
  assert.equal("defaultExecuteModel" in updated, false);
});

test("NOT-80: resolveProfileModel prefers role-neutral, then execute, then plan", () => {
  assert.equal(
    resolveProfileModel(
      profile({
        defaultModel: "neutral",
        defaultExecuteModel: "execute",
        defaultPlanModel: "plan",
      })
    ),
    "neutral"
  );
  assert.equal(
    resolveProfileModel(profile({ defaultExecuteModel: "execute", defaultPlanModel: "plan" })),
    "execute"
  );
  assert.equal(resolveProfileModel(profile({ defaultPlanModel: "plan" })), "plan");
  assert.equal(resolveProfileModel(profile({})), null);
});

test("NOT-80: resolveProfileBudgetJson uses the same fallback order", () => {
  assert.equal(
    resolveProfileBudgetJson(
      profile({
        defaultBudgetJson: JSON.stringify({ maxTurns: 9 }),
        defaultExecuteBudgetJson: JSON.stringify({ maxTurns: 2 }),
        defaultPlanBudgetJson: JSON.stringify({ maxTurns: 1 }),
      })
    ),
    JSON.stringify({ maxTurns: 9 })
  );
  assert.equal(
    resolveProfileBudgetJson(
      profile({
        defaultExecuteBudgetJson: JSON.stringify({ maxTurns: 2 }),
        defaultPlanBudgetJson: JSON.stringify({ maxTurns: 1 }),
      })
    ),
    JSON.stringify({ maxTurns: 2 })
  );
  assert.equal(
    resolveProfileBudgetJson(profile({ defaultPlanBudgetJson: JSON.stringify({ maxTurns: 1 }) })),
    JSON.stringify({ maxTurns: 1 })
  );
});
