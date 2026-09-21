// packages/server/src/repository/admission-settings.ts
//
// NOT-215: persisted operator setting for active-issue admission concurrency
// (`maxActiveIssues`, default 1, first slice 1–2). Stored in intake_settings so it
// survives server restart; read fresh from the DB on every tick so restart
// recovery and the coordinator loop observe it without any in-memory reload.

import { DEFAULT_MAX_ACTIVE_ISSUES, MAX_ACTIVE_ISSUES_HARD_MAX } from "@agent-dealer/shared";
import { getDb } from "../db/index.js";

export const ADMISSION_MAX_ACTIVE_ISSUES_KEY = "admission.maxActiveIssues";

export { DEFAULT_MAX_ACTIVE_ISSUES, MAX_ACTIVE_ISSUES_HARD_MAX };

const num = (name: string, dflt: number): number => Number(process.env[name] ?? dflt);

/**
 * Effective internal worker/spawn ceiling: the lower of the coordinator
 * dispatcher bound (worker-loop `coordinatorConfig.maxConcurrency`) and the
 * process-spawn bound (process-registry `maxConcurrentSpawns`). Mirrors both
 * defaults here so admission never depends on worker-loop (which imports
 * admission — a direct import would be a module cycle).
 */
export function workerSpawnCeiling(): number {
  const coordinator = num("MAX_COORDINATOR_CONCURRENCY", 2);
  const spawns = num("MAX_CONCURRENT_RUNS", 2);
  const safe = (n: number): number => (Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);
  return Math.min(safe(coordinator), safe(spawns));
}

/** Values the UI may offer — 1..HARD_MAX, never above the effective ceiling. */
export function admissionLimitOptions(): number[] {
  const ceiling = workerSpawnCeiling();
  const options: number[] = [];
  for (let v = 1; v <= MAX_ACTIVE_ISSUES_HARD_MAX; v++) {
    if (v <= ceiling) options.push(v);
  }
  return options;
}

/** Raw persisted operator setting; falls back to the default when missing/invalid. */
export function getMaxActiveIssues(): number {
  const row = getDb()
    .prepare("SELECT value_json FROM intake_settings WHERE key = ?")
    .get(ADMISSION_MAX_ACTIVE_ISSUES_KEY) as { value_json: string } | undefined;
  if (!row) return DEFAULT_MAX_ACTIVE_ISSUES;
  try {
    const value = JSON.parse(row.value_json) as unknown;
    if (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 1 &&
      value <= MAX_ACTIVE_ISSUES_HARD_MAX
    ) {
      return value;
    }
    return DEFAULT_MAX_ACTIVE_ISSUES;
  } catch {
    return DEFAULT_MAX_ACTIVE_ISSUES;
  }
}

/**
 * Effective admission limit: persisted setting clamped to the worker/spawn
 * ceiling, so a selected value is always real executable concurrency. Never
 * preempts or interrupts — callers (admission) simply stop admitting while
 * occupancy is at/above this.
 */
export function getEffectiveMaxActiveIssues(): number {
  return Math.min(getMaxActiveIssues(), workerSpawnCeiling());
}

/**
 * Persist a new operator limit. Rejects non-integers, values outside 1..2, and
 * values above the effective worker/spawn ceiling (those could never execute).
 * Throws `{ code: 400 }` for route handling.
 */
export function setMaxActiveIssues(value: unknown): number {
  const parsed =
    typeof value === "string" && value.trim() !== "" ? Number(value) : (value as number);
  if (typeof parsed !== "number" || !Number.isInteger(parsed)) {
    throw Object.assign(new Error("maxActiveIssues must be an integer"), { code: 400 });
  }
  if (parsed < 1 || parsed > MAX_ACTIVE_ISSUES_HARD_MAX) {
    throw Object.assign(
      new Error(`maxActiveIssues must be between 1 and ${MAX_ACTIVE_ISSUES_HARD_MAX}`),
      { code: 400 }
    );
  }
  const ceiling = workerSpawnCeiling();
  if (parsed > ceiling) {
    throw Object.assign(
      new Error(
        `maxActiveIssues ${parsed} exceeds the effective worker/spawn ceiling of ${ceiling}`
      ),
      { code: 400 }
    );
  }
  getDb()
    .prepare(
      "INSERT INTO intake_settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json"
    )
    .run(ADMISSION_MAX_ACTIVE_ISSUES_KEY, JSON.stringify(parsed));
  return parsed;
}
