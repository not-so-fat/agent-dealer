import type { LinearIntakeConfig, LinearIntakeConfigPatch, LinearRoutingRule } from "@agent-dealer/shared";
import { getDb } from "../db/index.js";

function getJson<T>(key: string, fallback: T): T {
  const row = getDb()
    .prepare("SELECT value_json FROM intake_settings WHERE key = ?")
    .get(key) as { value_json: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return fallback;
  }
}

function setJson(key: string, value: unknown): void {
  getDb()
    .prepare(
      "INSERT INTO intake_settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json"
    )
    .run(key, JSON.stringify(value));
}

export function getLinearIntakeConfig(): LinearIntakeConfig {
  return {
    stateFilter: getJson<string[]>("linear.stateFilter", ["Todo"]),
    teamId: getJson<string | null>("linear.teamId", null),
    assigneeMe: getJson<boolean>("linear.assigneeMe", true),
    defaultAgentId: getJson<string | null>("linear.defaultAgentId", null),
    syncEnabled: getJson<boolean>("linear.syncEnabled", true),
    routingRules: getJson<LinearRoutingRule[]>("linear.routingRules", []),
  };
}

export function patchLinearIntakeConfig(patch: LinearIntakeConfigPatch): LinearIntakeConfig {
  const current = getLinearIntakeConfig();
  const next: LinearIntakeConfig = {
    stateFilter: patch.stateFilter ?? current.stateFilter,
    teamId: patch.teamId !== undefined ? patch.teamId : current.teamId,
    assigneeMe: patch.assigneeMe ?? current.assigneeMe,
    defaultAgentId:
      patch.defaultAgentId !== undefined ? patch.defaultAgentId : current.defaultAgentId,
    syncEnabled: patch.syncEnabled ?? current.syncEnabled,
    routingRules: patch.routingRules ?? current.routingRules,
  };
  setJson("linear.stateFilter", next.stateFilter);
  setJson("linear.teamId", next.teamId);
  setJson("linear.assigneeMe", next.assigneeMe);
  setJson("linear.defaultAgentId", next.defaultAgentId);
  setJson("linear.syncEnabled", next.syncEnabled);
  setJson("linear.routingRules", next.routingRules);
  return next;
}
