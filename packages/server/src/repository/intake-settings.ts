import type {
  AgentDeckConfig,
  AgentDeckConfigPatch,
  LinearIntakeConfig,
  LinearIntakeConfigPatch,
  LinearIntakeConfigView,
  LinearRoutingRule,
} from "@agent-dealer/shared";
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

function parseStateFilterEnv(raw: string | undefined): string[] | null {
  if (!raw?.trim()) return null;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : null;
}

function linearEnvOverrides(): { stateFilter: boolean; teamId: boolean } {
  return {
    stateFilter: parseStateFilterEnv(process.env.LINEAR_STATE_FILTER) !== null,
    teamId: process.env.LINEAR_TEAM_ID !== undefined && process.env.LINEAR_TEAM_ID !== "",
  };
}

/** SQLite only — used when saving UI / PATCH. */
export function getPersistedLinearIntakeConfig(): LinearIntakeConfig {
  return {
    stateFilter: getJson<string[]>("linear.stateFilter", ["Todo"]),
    teamId: getJson<string | null>("linear.teamId", null),
    assigneeMe: getJson<boolean>("linear.assigneeMe", true),
    defaultAgentId: getJson<string | null>("linear.defaultAgentId", null),
    syncEnabled: getJson<boolean>("linear.syncEnabled", true),
    routingRules: getJson<LinearRoutingRule[]>("linear.routingRules", []),
  };
}

function applyEnvOverrides(config: LinearIntakeConfig): LinearIntakeConfig {
  const stateFromEnv = parseStateFilterEnv(process.env.LINEAR_STATE_FILTER);
  const teamFromEnv =
    process.env.LINEAR_TEAM_ID !== undefined && process.env.LINEAR_TEAM_ID !== ""
      ? process.env.LINEAR_TEAM_ID
      : null;

  return {
    ...config,
    ...(stateFromEnv ? { stateFilter: stateFromEnv } : {}),
    ...(teamFromEnv !== null ? { teamId: teamFromEnv } : {}),
  };
}

/** Effective config for inbox poll + sync (env overrides when set). */
export function getLinearIntakeConfig(): LinearIntakeConfig {
  return applyEnvOverrides(getPersistedLinearIntakeConfig());
}

export function getLinearIntakeConfigView(): LinearIntakeConfigView {
  const persisted = getPersistedLinearIntakeConfig();
  return {
    ...applyEnvOverrides(persisted),
    persisted,
    envOverrides: linearEnvOverrides(),
  };
}

export function patchLinearIntakeConfig(patch: LinearIntakeConfigPatch): LinearIntakeConfigView {
  const current = getPersistedLinearIntakeConfig();
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
  return getLinearIntakeConfigView();
}

function parseEnvAgentDeckUrl(): { host: string; port: number } | null {
  const raw = process.env.AGENT_DECK_API_URL;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    return { host: u.hostname, port };
  } catch {
    return null;
  }
}

export function getAgentDeckConfig(): AgentDeckConfig {
  const fromEnv = parseEnvAgentDeckUrl();
  return {
    host: getJson<string>("agentDeck.host", fromEnv?.host ?? "127.0.0.1"),
    port: getJson<number>("agentDeck.port", fromEnv?.port ?? 1111),
    envOverride: Boolean(process.env.AGENT_DECK_API_URL),
  };
}

export function patchAgentDeckConfig(patch: AgentDeckConfigPatch): AgentDeckConfig {
  if (process.env.AGENT_DECK_API_URL) {
    throw new Error("AGENT_DECK_API_URL is set in env — remove it to configure port in the UI");
  }
  const current = getAgentDeckConfig();
  const next: AgentDeckConfig = {
    host: patch.host?.trim() || current.host,
    port: patch.port ?? current.port,
    envOverride: false,
  };
  if (next.port < 1 || next.port > 65535) {
    throw new Error("Port must be between 1 and 65535");
  }
  setJson("agentDeck.host", next.host);
  setJson("agentDeck.port", next.port);
  return next;
}
