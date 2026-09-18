import type { AgentDeckConfig, LinearIntakeConfig } from "@agent-dealer/shared";
import { getDb } from "../db/index.js";

/** Open workflow states — exclude terminal Done / Canceled. Shared with linear-inbox seed. */
export const DEFAULT_LINEAR_STATE_FILTER = ["Backlog", "Todo", "In Progress", "In Review"] as const;

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

function parseStateFilterEnv(raw: string | undefined): string[] | null {
  if (!raw?.trim()) return null;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : null;
}

/** Persisted-only view of the Linear intake config (env overrides applied separately). */
export function getPersistedLinearIntakeConfig(): LinearIntakeConfig {
  return {
    stateFilter: getJson<string[]>("linear.stateFilter", [...DEFAULT_LINEAR_STATE_FILTER]),
    teamId: getJson<string | null>("linear.teamId", null),
    assigneeMe: getJson<boolean>("linear.assigneeMe", false),
    syncEnabled: getJson<boolean>("linear.syncEnabled", true),
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
