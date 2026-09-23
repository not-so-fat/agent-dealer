import type { LinearRepositoryMapping } from "@agent-dealer/shared";
import { normalizeRepositoryMappings } from "@agent-dealer/shared";
import { getDb } from "../db/index.js";

/** Storage key inside the existing `intake_settings` table — no migration needed. */
export const REPOSITORY_MAPPINGS_KEY = "linear.repositoryMappings";

function readRaw(): unknown {
  const row = getDb()
    .prepare("SELECT value_json FROM intake_settings WHERE key = ?")
    .get(REPOSITORY_MAPPINGS_KEY) as { value_json: string } | undefined;
  if (!row) return [];
  try {
    return JSON.parse(row.value_json);
  } catch {
    return [];
  }
}

/**
 * NOT-260: list saved label → repository mappings. A fresh install returns
 * `[]`; a corrupt row reads as `[]` rather than throwing.
 */
export function listRepositoryMappings(): LinearRepositoryMapping[] {
  const raw = readRaw();
  const rows = Array.isArray(raw) ? raw : (raw as { mappings?: unknown })?.mappings;
  if (!Array.isArray(rows)) return [];
  try {
    return normalizeRepositoryMappings({ mappings: rows as Array<{ label: string; repository: string }> });
  } catch {
    return [];
  }
}

/**
 * NOT-260: atomically replace all mappings. Normalizes labels/repositories
 * before writing; editing the repository for an existing unique label
 * overwrites its prior value. Empty labels, invalid repositories, duplicate
 * normalized labels, or >100 rows throw without changing the last valid array.
 */
export function replaceRepositoryMappings(input: {
  mappings: Array<{ label: string; repository: string }>;
}): LinearRepositoryMapping[] {
  const normalized = normalizeRepositoryMappings(input);
  getDb()
    .prepare(
      "INSERT INTO intake_settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json"
    )
    .run(REPOSITORY_MAPPINGS_KEY, JSON.stringify(normalized));
  return normalized;
}
