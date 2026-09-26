// packages/server/src/capacity/cursor-individual-credentials.ts
//
// NOT-250: isolated credential lookup for the experimental Cursor Individual
// dashboard adapter. NOT-267: the desktop Cursor login is the primary
// source, the Cursor Agent auth file the fallback.
//
// The dashboard endpoints this feature calls are undocumented: the only
// credential available is the existing local Cursor login, whose storage
// locations and shapes are themselves not a supported contract and may
// change without notice. All of that risk lives in this one module:
//
// - Resolution order: Cursor desktop `state.vscdb` first (read-only,
//   single allowlisted key), then the Cursor Agent `auth.json` allowlisted
//   token shapes. The first usable source wins; Agent auth unchanged.
// - Accepted JSON shapes are an explicit allowlist below — anything else
//   reads `unparsable` (changed format), never a guess.
// - `cursorIndividualCredentialStatus()` (the diagnostics surface) returns
//   presence/source/path/format ONLY — never secret material.
// - `loadCursorIndividualCredential()` additionally returns an in-memory
//   `authHeader` for the dashboard HTTP call. The header value must never be
//   persisted, returned to the browser, or logged — the adapter, repository,
//   and route layers enforce that, and tests pin it.
//
// No silent opt-in or credential migration lives here: this module only
// *finds* credentials; whether they may be *used* is decided by the
// explicit `AGENT_DEALER_CURSOR_INDIVIDUAL_CAPACITY=experimental` opt-in in
// cursor-individual.ts, which short-circuits before touching this module.
// Nothing here writes Cursor's database, refreshes tokens, or touches the
// Keychain or auth files — all reads are read-only.

import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Explicit credential-file override (tests point this at tmp fixtures). */
export const CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV = "CURSOR_INDIVIDUAL_CREDENTIAL_FILE";

/** Home-directory override for tests (mirrors how OS home resolution works). */
export const CURSOR_INDIVIDUAL_HOME_ENV = "CURSOR_INDIVIDUAL_HOME";

/** Explicit desktop-state database override (tests point this at tmp fixtures). */
export const CURSOR_INDIVIDUAL_DESKTOP_STATE_FILE_ENV = "CURSOR_INDIVIDUAL_DESKTOP_STATE_FILE";

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

/**
 * Accepted top-level WorkOS user-id keys. The dashboard's session cookie is
 * `<userId>%3A%3A<token>` (see `cursorIndividualAuthHeader`) — a bare token
 * is not enough. Same allowlist discipline as the token keys: an explicit
 * field here wins; otherwise the id is derived from the token's own JWT
 * `sub` claim (see `decodeJwtSubject`). Either source is normalized through
 * `normalizeWorkosUserId` to strip a provider prefix.
 */
export const CURSOR_INDIVIDUAL_USER_ID_KEYS = [
  "userId",
  "user_id",
  "workosUserId",
  "workos_user_id",
  "sub",
] as const;

/** Nested objects tolerated one level deep (same key allowlists apply). */
const NESTED_KEYS = ["auth", "data", "user"] as const;

export type CredentialStatus = "found" | "absent" | "unparsable";

/** Which local login answered: the desktop app state or the Agent auth file. */
export type CursorIndividualCredentialSource = "desktop" | "agent";

export interface CursorIndividualCredential {
  status: CredentialStatus;
  /** Which local login answered (null unless `found`). */
  source: CursorIndividualCredentialSource | null;
  /** Candidate file that answered (null when no file was readable). */
  path: string | null;
  /**
   * Which accepted shape matched (`desktop:cursorAuth/accessToken`,
   * `token`, `auth.accessToken`, …; null otherwise).
   */
  format: string | null;
  /**
   * In-memory dashboard auth header. Present ONLY on `found` — and only
   * here: status surfaces must strip it before returning.
   */
  authHeader?: string;
}

/** Operator-safe diagnostics: presence, source, path, matched shape — no secret. */
export interface CursorIndividualCredentialStatus {
  present: boolean;
  source: CursorIndividualCredentialSource | null;
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

// ---------------------------------------------------------------------------
// Cursor desktop login (NOT-267, primary source).
//
// Cursor desktop keeps its login in the standard VS Code global-storage
// SQLite database (`state.vscdb`), under the key
// `cursorAuth/accessToken`. Community tools (ai-usagebar and ports) read
// that same key first and fall back to a Cursor Agent `auth.json` — this
// module follows the same order.
// ---------------------------------------------------------------------------

/** The ONLY desktop-state key this module ever reads — never anything else. */
export const CURSOR_DESKTOP_ACCESS_TOKEN_KEY = "cursorAuth/accessToken";

/** Format label for a credential answered by the desktop state database. */
export const CURSOR_DESKTOP_FORMAT = "desktop:cursorAuth/accessToken";

export interface DesktopStatePathOpts {
  /** Defaults to `process.platform` — tests pass each OS explicitly. */
  platform?: string;
  /** Defaults to the (overridable) home directory. */
  home?: string;
  /** Windows roaming-app-data root; defaults to `process.env.APPDATA`. */
  appData?: string;
}

/**
 * Ordered desktop-state database candidates: exactly one default path per
 * OS (plus the explicit file override when set). The module never hunts
 * beyond these — an absent database degrades to the Agent auth fallback,
 * never to a scan of unrelated files.
 *
 * - macOS: `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
 * - Windows: `%APPDATA%/Cursor/User/globalStorage/state.vscdb`
 * - Linux (and anything else): `~/.config/Cursor/User/globalStorage/state.vscdb`
 */
export function cursorIndividualDesktopStateCandidates(opts: DesktopStatePathOpts = {}): string[] {
  const override = process.env[CURSOR_INDIVIDUAL_DESKTOP_STATE_FILE_ENV]?.trim();
  if (override) return [override];
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homeDir();
  if (platform === "win32") {
    const appData =
      opts.appData ?? process.env.APPDATA?.trim() ?? path.join(home, "AppData", "Roaming");
    if (!appData) return [];
    return [path.join(appData, "Cursor", "User", "globalStorage", "state.vscdb")];
  }
  if (platform === "darwin") {
    return [
      path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
    ];
  }
  return [path.join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb")];
}

/**
 * Normalize one raw desktop-state value to a token. Cursor stores the
 * access token as a plain-text JWT; a JSON-quoted wrapping is tolerated
 * (same bytes, quoted), anything else is unusable — never a guess.
 */
export function normalizeDesktopTokenValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('"')) {
    try {
      const inner: unknown = JSON.parse(trimmed);
      return typeof inner === "string" && inner.trim() ? inner.trim() : null;
    } catch {
      return null;
    }
  }
  return trimmed;
}

/** Read-only single-key desktop database read, injectable for tests. */
export type DesktopTokenReader = (dbPath: string) => string | null;

/**
 * Open the desktop state database READ-ONLY and read ONLY the allowlisted
 * access-token key. Never throws: a missing/locked database, a missing key,
 * or an unusable value all read null. The database is never copied, never
 * written, and no unrelated key is ever selected.
 */
export function defaultReadDesktopAccessToken(dbPath: string): string | null {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get(CURSOR_DESKTOP_ACCESS_TOKEN_KEY) as { value: unknown } | undefined;
    if (!row) return null;
    return normalizeDesktopTokenValue(row.value);
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Read-only handle cleanup is best-effort; the read verdict stands.
    }
  }
}

/**
 * Build a dashboard auth header from a desktop access token. The desktop
 * store carries no separate user-id field, so the id is derived from the
 * token's own JWT `sub` claim through the existing normalization — a token
 * with no derivable id is unusable (null), never a Bearer-only guess.
 */
export function desktopTokenToAuthHeader(token: string): string | null {
  const rawUserId = decodeJwtSubject(token);
  if (!rawUserId) return null;
  const userId = normalizeWorkosUserId(rawUserId);
  if (!userId) return null;
  return cursorIndividualAuthHeader(userId, token);
}

function pickByKeys(
  obj: Record<string, unknown>,
  keys: readonly string[]
): { key: string; value: string } | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return { key, value: value.trim() };
  }
  for (const nest of NESTED_KEYS) {
    const inner = obj[nest];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      for (const key of keys) {
        const value = (inner as Record<string, unknown>)[key];
        if (typeof value === "string" && value.trim()) {
          return { key: `${nest}.${key}`, value: value.trim() };
        }
      }
    }
  }
  return null;
}

function pickToken(obj: Record<string, unknown>): { key: string; token: string } | null {
  const picked = pickByKeys(obj, CURSOR_INDIVIDUAL_TOKEN_KEYS);
  return picked ? { key: picked.key, token: picked.value } : null;
}

function pickUserId(obj: Record<string, unknown>): string | null {
  return pickByKeys(obj, CURSOR_INDIVIDUAL_USER_ID_KEYS)?.value ?? null;
}

function base64UrlDecode(segment: string): string | null {
  try {
    const padded = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "=");
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * The WorkOS session id is normally the JWT's own `sub` claim — decoded
 * locally (no network, no signature verification: this only *reads* an id
 * already present in a credential the caller trusts) so a plain access-token
 * file still yields a usable id without a separate stored field. WorkOS
 * subjects are commonly provider-prefixed (e.g. `google-oauth2|user_abc`);
 * the raw claim is returned as-is here — `normalizeWorkosUserId` strips the
 * prefix, applied uniformly to both this and an explicit `userId` field so
 * either source lands on the same bare id.
 */
export function decodeJwtSubject(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const json = base64UrlDecode(parts[1]);
  if (json === null) return null;
  try {
    const payload = JSON.parse(json) as unknown;
    if (!payload || typeof payload !== "object") return null;
    const sub = (payload as Record<string, unknown>).sub;
    return typeof sub === "string" && sub.trim() ? sub.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Strips a WorkOS connection-type prefix (`google-oauth2|user_abc` →
 * `user_abc`): the dashboard's own session cookie carries the bare id after
 * the final `|`, never the provider-qualified subject.
 */
export function normalizeWorkosUserId(id: string): string {
  const at = id.lastIndexOf("|");
  return at === -1 ? id : id.slice(at + 1);
}

/**
 * Dashboard auth scheme: a `WorkosCursorSessionToken` cookie of
 * `<userId>%3A%3A<token>` (community-observed: cursor-pulse, oh-my-pi,
 * vct-core) — the dashboard rejects a Bearer `Authorization` header, and the
 * `::` delimiter itself is percent-encoded in the live cookie value, not
 * sent literally. The scheme is part of the undocumented surface and may
 * drift (drift reads `unparsable`/`forbidden` at the HTTP layer, never a
 * credential guess here). Returns the `Cookie` header VALUE (the caller
 * sends it under the `Cookie` header name).
 */
export function cursorIndividualAuthHeader(userId: string, token: string): string {
  return `WorkosCursorSessionToken=${userId}%3A%3A${token}`;
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
 * Find a usable local Cursor credential, desktop first, Agent auth as the
 * fallback. Never throws: unreadable files, invalid JSON, unknown shapes,
 * and unusable desktop tokens all map to `absent`/`unparsable`.
 * The raw token leaves this module only inside `authHeader`, held in memory
 * for the single dashboard call the adapter makes with it.
 *
 * When `CURSOR_INDIVIDUAL_CREDENTIAL_FILE` pins an explicit file, ONLY that
 * file is consulted (legacy single-source behavior for fixtures); otherwise
 * the desktop state database is tried first and the Agent auth file second.
 */
export function loadCursorIndividualCredential(
  readFile: ReadFileImpl = defaultReadFile,
  readDesktopToken: DesktopTokenReader = defaultReadDesktopAccessToken
): CursorIndividualCredential {
  const explicitFile = process.env[CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV]?.trim();
  // A present-but-unusable desktop login is remembered (not returned yet):
  // the Agent fallback still gets its chance — any usable credential wins
  // over a precise-but-unusable verdict. When nothing is usable, the
  // desktop verdict is the most precise diagnostic, so it wins over the
  // Agent one.
  let desktopUnparsable: CursorIndividualCredential | null = null;
  if (!explicitFile) {
    const desktop = loadDesktopCredential(readDesktopToken);
    if (desktop?.found) return desktop.found;
    desktopUnparsable = desktop?.unparsable ?? null;
  }
  const agentUnparsable = (candidate: string, format: string | null): CursorIndividualCredential =>
    desktopUnparsable ?? { status: "unparsable", source: null, path: candidate, format };
  for (const candidate of cursorIndividualCredentialCandidates()) {
    const raw = readFile(candidate);
    if (raw === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return agentUnparsable(candidate, null);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return agentUnparsable(candidate, null);
    }
    const picked = pickToken(parsed as Record<string, unknown>);
    if (!picked) return agentUnparsable(candidate, null);
    // The cookie needs a user id too — an explicit field wins; otherwise
    // derive it from the token's own JWT `sub` claim. Neither present means
    // this credential cannot build a usable session, same as any other
    // format drift. Either source may be provider-prefixed
    // (`google-oauth2|user_abc`) — normalize both the same way.
    const rawUserId = pickUserId(parsed as Record<string, unknown>) ?? decodeJwtSubject(picked.token);
    if (!rawUserId) return agentUnparsable(candidate, picked.key);
    // Re-check AFTER normalization: an id ending in `|` (e.g. a bare
    // `"google-oauth2|"` with nothing after it) is non-empty here but
    // normalizes to "" — that must degrade too, not build a cookie with an
    // empty user id.
    const userId = normalizeWorkosUserId(rawUserId);
    if (!userId) return agentUnparsable(candidate, picked.key);
    return {
      status: "found",
      source: "agent",
      path: candidate,
      format: picked.key,
      authHeader: cursorIndividualAuthHeader(userId, picked.token),
    };
  }
  return desktopUnparsable ?? { status: "absent", source: null, path: null, format: null };
}

/**
 * Try the desktop state database. Returns null when no desktop database
 * was readable at all (fall through to Agent auth); otherwise the desktop
 * verdict — `found` when the access token yields a usable session, or an
 * `unparsable` diagnostic when the database answered but the token cannot
 * (missing key, empty value, no derivable user id). A present-but-unusable
 * desktop login is format drift, not absence — but the Agent fallback still
 * gets its chance via the caller, which prefers any usable credential.
 */
function loadDesktopCredential(
  readDesktopToken: DesktopTokenReader
): { found: CursorIndividualCredential | null; unparsable: CursorIndividualCredential | null } | null {
  let sawDatabase = false;
  let unparsable: CursorIndividualCredential | null = null;
  for (const dbPath of cursorIndividualDesktopStateCandidates()) {
    let token: string | null;
    try {
      token = readDesktopToken(dbPath);
    } catch {
      continue;
    }
    if (token === null) continue;
    sawDatabase = true;
    const authHeader = desktopTokenToAuthHeader(token);
    if (authHeader) {
      return {
        found: {
          status: "found",
          source: "desktop",
          path: dbPath,
          format: CURSOR_DESKTOP_FORMAT,
          authHeader,
        },
        unparsable: null,
      };
    }
    // Token present but no derivable user id — same verdict as an Agent
    // token with no id: changed format, never a Bearer-only guess.
    if (!unparsable) {
      unparsable = { status: "unparsable", source: null, path: dbPath, format: CURSOR_DESKTOP_FORMAT };
    }
  }
  if (!sawDatabase && !unparsable) return null;
  return { found: null, unparsable };
}

/**
 * Diagnostics-safe credential presence: delegates to the loader, then
 * strips the in-memory secret. Safe to expose via logs and API responses.
 */
export function cursorIndividualCredentialStatus(
  readFile: ReadFileImpl = defaultReadFile,
  readDesktopToken: DesktopTokenReader = defaultReadDesktopAccessToken
): CursorIndividualCredentialStatus {
  const credential = loadCursorIndividualCredential(readFile, readDesktopToken);
  return {
    present: credential.status === "found",
    source: credential.source,
    path: credential.path,
    format: credential.format,
  };
}
