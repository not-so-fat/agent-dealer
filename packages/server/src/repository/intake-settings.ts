import type {
  AgentDeckConfig,
  LinearIntakeConfig,
  LinearIntakeConfigPatch,
  LinearIntakeConfigView,
  LinearIntakePickerConfig,
} from "@agent-dealer/shared";
import { normalizeLinearIntakePickerPatch } from "@agent-dealer/shared";
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

function toPickerConfig(config: LinearIntakeConfig): LinearIntakePickerConfig {
  return {
    stateFilter: config.stateFilter,
    teamId: config.teamId,
    assigneeMe: config.assigneeMe,
  };
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

/** NOT-361: effective picker filters + persisted values + which env vars win. */
export function getLinearIntakeConfigView(): LinearIntakeConfigView {
  const persistedFull = getPersistedLinearIntakeConfig();
  const effective = applyEnvOverrides(persistedFull);
  return {
    ...toPickerConfig(effective),
    persisted: toPickerConfig(persistedFull),
    envOverrides: linearEnvOverrides(),
  };
}

/**
 * NOT-361: persist picker fields only (Team / Assignee / Status).
 * Never touches syncEnabled or the deleted routing/default-agent rows.
 */
export function patchLinearIntakeConfig(patch: LinearIntakeConfigPatch): LinearIntakeConfigView {
  const normalized = normalizeLinearIntakePickerPatch(patch);
  const current = getPersistedLinearIntakeConfig();
  const nextPicker: LinearIntakePickerConfig = {
    stateFilter: normalized.stateFilter ?? current.stateFilter,
    teamId: normalized.teamId !== undefined ? normalized.teamId : current.teamId,
    assigneeMe: normalized.assigneeMe !== undefined ? normalized.assigneeMe : current.assigneeMe,
  };
  // Re-validate the merged picker shape (empty status list is rejected above).
  if (nextPicker.stateFilter.length === 0) {
    throw new Error("Select at least one workflow status");
  }
  setJson("linear.stateFilter", nextPicker.stateFilter);
  setJson("linear.teamId", nextPicker.teamId);
  setJson("linear.assigneeMe", nextPicker.assigneeMe);
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
