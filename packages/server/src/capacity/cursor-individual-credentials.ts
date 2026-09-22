// packages/server/src/capacity/cursor-individual-credentials.ts
//
// NOT-250: isolated credential lookup for the experimental Cursor Individual
// dashboard adapter.
//
// The dashboard endpoints this feature calls are undocumented: the only
// credential available is the existing local Cursor login, whose file
// location and JSON shape are themselves not a supported contract and may
// change without notice. All of that risk lives in this one module:
//
// - Candidate files are tried in order; the first readable file wins.
// - Accepted JSON shapes are an explicit allowlist below — anything else
//   reads `unparsable` (changed format), never a guess.
// - `cursorIndividualCredentialStatus()` (the diagnostics surface) returns
//   presence/path/format ONLY — never secret material.
// - `loadCursorIndividualCredential()` additionally returns an in-memory
//   `authHeader` for the dashboard HTTP call. The header value must never be
//   persisted, returned to the browser, or logged — the adapter, repository,
//   and route layers enforce that, and tests pin it.
//
// No silent opt-in or credential migration lives here: this module only
// *finds* credentials; whether they may be *used* is decided by the
// explicit `AGENT_DEALER_CURSOR_INDIVIDUAL_CAPACITY=experimental` opt-in in
// cursor-individual.ts, which short-circuits before touching this module.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Explicit credential-file override (tests point this at tmp fixtures). */
export const CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV = "CURSOR_INDIVIDUAL_CREDENTIAL_FILE";

/** Home-directory override for tests (mirrors how OS home resolution works). */
export const CURSOR_INDIVIDUAL_HOME_ENV = "CURSOR_INDIVIDUAL_HOME";

/**
 * Community-observed local Cursor login file. The location is undocumented
 * and may move — when it does, reads degrade to `absent`/`unparsable`, never
 * to a scan of unrelated files. Exactly one default candidate is listed on
 * purpose: this module must not go hunting through the home directory.
 */
export const CURSOR_INDIVIDUAL_DEFAULT_RELATIVE_PATH = path.join(".cursor", "auth.json");

/**
 * Accepted top-level token keys. The credential format is undocumented, so
 * both camelCase and snake_case spellings are tolerated — but ONLY these
 * keys. An object with none of them is a changed format (`unparsable`).
 */
export const CURSOR_INDIVIDUAL_TOKEN_KEYS = [
  "token",
  "accessToken",
  "access_token",
  "sessionToken",
  "session_token",
  "authToken",
  "auth_token",
  "apiKey",
  "api_key",
  "jwt",
] as const;

/** Nested objects tolerated one level deep (same key allowlist applies). */
const NESTED_KEYS = ["auth", "data", "user"] as const;

export type CredentialStatus = "found" | "absent" | "unparsable";

export interface CursorIndividualCredential {
  status: CredentialStatus;
  /** Candidate file that answered (null when no file was readable). */
  path: string | null;
  /** Which accepted shape matched (`token`, `auth.accessToken`, …; null otherwise). */
  format: string | null;
  /**
   * In-memory dashboard auth header. Present ONLY on `found` — and only
   * here: status surfaces must strip it before returning.
   */
  authHeader?: string;
}

/** Operator-safe diagnostics: presence, path, and matched shape — no secret. */
export interface CursorIndividualCredentialStatus {
  present: boolean;
  path: string | null;
  format: string | null;
}

function homeDir(): string {
  const override = process.env[CURSOR_INDIVIDUAL_HOME_ENV]?.trim();
  if (override) return override;
  return os.homedir();
}

/** Ordered candidate files: explicit override first, then the local login. */
export function cursorIndividualCredentialCandidates(): string[] {
  const override = process.env[CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV]?.trim();
  if (override) return [override];
  return [path.join(homeDir(), CURSOR_INDIVIDUAL_DEFAULT_RELATIVE_PATH)];
}

function pickToken(obj: Record<string, unknown>): { key: string; token: string } | null {
  for (const key of CURSOR_INDIVIDUAL_TOKEN_KEYS) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return { key, token: value.trim() };
  }
  for (const nest of NESTED_KEYS) {
    const inner = obj[nest];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      for (const key of CURSOR_INDIVIDUAL_TOKEN_KEYS) {
        const value = (inner as Record<string, unknown>)[key];
        if (typeof value === "string" && value.trim()) {
          return { key: `${nest}.${key}`, token: value.trim() };
        }
      }
    }
  }
  return null;
}

/**
 * Dashboard auth scheme. Community tools commonly present the local login
 * token as a Bearer token against Cursor dashboard origins; the scheme is
 * part of the undocumented surface and may drift (drift reads `unparsable`
 * at the HTTP layer, never a credential guess here).
 */
export function cursorIndividualAuthHeader(token: string): string {
  return `Bearer ${token}`;
}

export interface ReadFileImpl {
  (filePath: string): string | null;
}

function defaultReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Find a usable local Cursor credential. Never throws: unreadable files,
 * invalid JSON, and unknown shapes all map to `absent`/`unparsable`.
 * The raw token leaves this module only inside `authHeader`, held in memory
 * for the single dashboard call the adapter makes with it.
 */
export function loadCursorIndividualCredential(
  readFile: ReadFileImpl = defaultReadFile
): CursorIndividualCredential {
  for (const candidate of cursorIndividualCredentialCandidates()) {
    const raw = readFile(candidate);
    if (raw === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: "unparsable", path: candidate, format: null };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { status: "unparsable", path: candidate, format: null };
    }
    const picked = pickToken(parsed as Record<string, unknown>);
    if (!picked) return { status: "unparsable", path: candidate, format: null };
    return {
      status: "found",
      path: candidate,
      format: picked.key,
      authHeader: cursorIndividualAuthHeader(picked.token),
    };
  }
  return { status: "absent", path: null, format: null };
}

/**
 * Diagnostics-safe credential presence: delegates to the loader, then
 * strips the in-memory secret. Safe to expose via logs and API responses.
 */
export function cursorIndividualCredentialStatus(
  readFile: ReadFileImpl = defaultReadFile
): CursorIndividualCredentialStatus {
  const credential = loadCursorIndividualCredential(readFile);
  return {
    present: credential.status === "found",
    path: credential.path,
    format: credential.format,
  };
}
