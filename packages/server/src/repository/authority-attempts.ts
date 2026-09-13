// packages/server/src/repository/authority-attempts.ts
//
// Durable checkout ledger for short-lived Agent Deck execution authority (NOT-91). A row is
// written BEFORE the mint call (status `acquiring`) so a crash between "asked Deck for
// authority" and "released it" leaves something for restart reconciliation
// (authority-lifecycle.ts's reconcileAuthoritiesAtStartup) and worker-death recovery
// (coordinator/recovery.ts) to revoke against, instead of an authority that only ever lived
// in one in-process async call's local variables.
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";

export type AuthorityAttemptOwnerKind = "developer" | "reviewer" | "reflect" | "outbound_delivery";
export type AuthorityAttemptStatus = "acquiring" | "active" | "closed" | "revoked" | "failed";

export interface AuthorityAttemptToolScopeHint {
  serviceId: string;
  toolName: string;
}

export interface AuthorityAttempt {
  id: string;
  ownerKind: AuthorityAttemptOwnerKind;
  ownerId: string;
  idempotencyKey: string;
  authorityId: string | null;
  deckId: string;
  runId: string;
  attemptId: string;
  ttlMs: number;
  toolScopeHint: AuthorityAttemptToolScopeHint[] | null;
  status: AuthorityAttemptStatus;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AuthorityAttemptRow {
  id: string;
  owner_kind: string;
  owner_id: string;
  idempotency_key: string;
  authority_id: string | null;
  deck_id: string;
  run_id: string;
  attempt_id: string;
  ttl_ms: number;
  tool_scope_hint_json: string | null;
  status: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToAttempt(row: AuthorityAttemptRow): AuthorityAttempt {
  return {
    id: row.id,
    ownerKind: row.owner_kind as AuthorityAttemptOwnerKind,
    ownerId: row.owner_id,
    idempotencyKey: row.idempotency_key,
    authorityId: row.authority_id,
    deckId: row.deck_id,
    runId: row.run_id,
    attemptId: row.attempt_id,
    ttlMs: row.ttl_ms,
    toolScopeHint: row.tool_scope_hint_json ? JSON.parse(row.tool_scope_hint_json) : null,
    status: row.status as AuthorityAttemptStatus,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateAuthorityAttemptInput {
  ownerKind: AuthorityAttemptOwnerKind;
  ownerId: string;
  idempotencyKey: string;
  deckId: string;
  /** Stored verbatim so a row stuck `acquiring` with no authorityId (a crash between "Deck
   * committed the mint" and "this row was activated") can be resolved on restart by replaying
   * the exact original mint request under the same idempotencyKey, instead of being
   * terminalized on a guess (NOT-91 review). */
  runId: string;
  attemptId: string;
  ttlMs: number;
  toolScopeHint?: AuthorityAttemptToolScopeHint[];
}

/** Inserted BEFORE the mint call — `acquiring` must never survive a process boundary. */
export function createAuthorityAttempt(input: CreateAuthorityAttemptInput): AuthorityAttempt {
  const now = new Date().toISOString();
  const row: AuthorityAttemptRow = {
    id: uuid(),
    owner_kind: input.ownerKind,
    owner_id: input.ownerId,
    idempotency_key: input.idempotencyKey,
    authority_id: null,
    deck_id: input.deckId,
    run_id: input.runId,
    attempt_id: input.attemptId,
    ttl_ms: input.ttlMs,
    tool_scope_hint_json: input.toolScopeHint ? JSON.stringify(input.toolScopeHint) : null,
    status: "acquiring",
    expires_at: null,
    created_at: now,
    updated_at: now,
  };
  getDb()
    .prepare(`
      INSERT INTO authority_attempts (
        id, owner_kind, owner_id, idempotency_key, authority_id, deck_id, run_id, attempt_id,
        ttl_ms, tool_scope_hint_json, status, expires_at, created_at, updated_at
      ) VALUES (
        @id, @owner_kind, @owner_id, @idempotency_key, @authority_id, @deck_id, @run_id, @attempt_id,
        @ttl_ms, @tool_scope_hint_json, @status, @expires_at, @created_at, @updated_at
      )
    `)
    .run(row);
  return rowToAttempt(row);
}

/** `acquiring` → `active`, once mint + verify + materialize all succeed. CAS-fenced on the
 * row still being `acquiring` — a no-op if it was already revoked out from under this call
 * (e.g. a concurrent abort). Returns the updated row, or null if the CAS missed. */
export function activateAuthorityAttempt(
  id: string,
  input: { authorityId: string; expiresAt: string }
): AuthorityAttempt | null {
  const now = new Date().toISOString();
  const row = getDb()
    .prepare(`
      UPDATE authority_attempts SET
        status = 'active', authority_id = @authority_id, expires_at = @expires_at, updated_at = @now
      WHERE id = @id AND status = 'acquiring'
      RETURNING *
    `)
    .get({ id, authority_id: input.authorityId, expires_at: input.expiresAt, now }) as
    | AuthorityAttemptRow
    | undefined;
  return row ? rowToAttempt(row) : null;
}

function setTerminalStatus(id: string, status: "closed" | "revoked" | "failed"): AuthorityAttempt | null {
  const now = new Date().toISOString();
  const row = getDb()
    .prepare(`
      UPDATE authority_attempts SET status = @status, updated_at = @now
      WHERE id = @id AND status IN ('acquiring', 'active')
      RETURNING *
    `)
    .get({ id, status, now }) as AuthorityAttemptRow | undefined;
  return row ? rowToAttempt(row) : null;
}

/** Normal end-of-use — the caller already revoked (or is about to revoke) the authority on
 * Deck's side; this just closes the ledger row. */
export function closeAuthorityAttempt(id: string): AuthorityAttempt | null {
  return setTerminalStatus(id, "closed");
}

/** Mint/verify/materialize failed — the caller already revoked (or has nothing to revoke,
 * e.g. mint itself never returned an authorityId). */
export function markAuthorityAttemptFailed(id: string): AuthorityAttempt | null {
  return setTerminalStatus(id, "failed");
}

/** One row, by id — the per-row counterpart to `revokeOpenActiveAuthorityAttempts`'s
 * per-owner bulk flip, and what a resolved `acquiring` row is set to. */
export function markAuthorityAttemptRevoked(id: string): AuthorityAttempt | null {
  return setTerminalStatus(id, "revoked");
}

export function getAuthorityAttempt(id: string): AuthorityAttempt | null {
  const row = getDb().prepare("SELECT * FROM authority_attempts WHERE id = ?").get(id) as
    | AuthorityAttemptRow
    | undefined;
  return row ? rowToAttempt(row) : null;
}

/** Every row for this owner still `acquiring`/`active` — a fresh attempt (a new
 * idempotencyKey for the same owner) revokes these first (NOT-91's "revoke-before-new-
 * attempt"): a prior attempt's authority has no legitimate further use once a new one
 * starts. */
export function listOpenAuthorityAttemptsForOwner(
  ownerKind: AuthorityAttemptOwnerKind,
  ownerId: string
): AuthorityAttempt[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM authority_attempts WHERE owner_kind = ? AND owner_id = ? AND status IN ('acquiring', 'active') ORDER BY created_at ASC"
    )
    .all(ownerKind, ownerId) as AuthorityAttemptRow[];
  return rows.map(rowToAttempt);
}

/**
 * DB-only CAS: flips every `active` row for this owner (a known `authorityId`) to `revoked`
 * and returns them, so the caller can best-effort revoke each on Deck's side. Synchronous and
 * side-effect-free on Deck, so it is safe to call from inside a `better-sqlite3` transaction
 * (recovery.ts's reclaim/dead-letter, commands.ts's abortIssue) — the actual network revoke
 * happens only after that transaction commits.
 *
 * Deliberately excludes `acquiring` rows (no `authorityId` yet): a coordinator can crash
 * after Deck committed a mint but before that row was activated with the resulting id, so an
 * `acquiring` row alone can't be assumed to have nothing live behind it. Terminalizing it here
 * on a guess is exactly the leak NOT-91's review caught — it must instead be resolved by
 * replaying its stored idempotencyKey (authority-lifecycle.ts's `resolveAcquiringAttempts`),
 * which needs an async mint() call this synchronous DB-only helper can't make. Callers pair
 * this with `listOpenAcquiringAuthorityAttempts` for that owner and resolve those separately,
 * outside any surrounding transaction.
 */
export function revokeOpenActiveAuthorityAttempts(
  ownerKind: AuthorityAttemptOwnerKind,
  ownerId: string
): AuthorityAttempt[] {
  const now = new Date().toISOString();
  const rows = getDb()
    .prepare(`
      UPDATE authority_attempts SET status = 'revoked', updated_at = @now
      WHERE owner_kind = @owner_kind AND owner_id = @owner_id AND status = 'active'
      RETURNING *
    `)
    .all({ owner_kind: ownerKind, owner_id: ownerId, now }) as AuthorityAttemptRow[];
  return rows.map(rowToAttempt);
}

/** Read-only: every `acquiring` row for this owner (no `authorityId` yet) — the counterpart
 * to `revokeOpenActiveAuthorityAttempts` a caller resolves separately, asynchronously, via
 * `authority-lifecycle.ts`'s `resolveAcquiringAttempts`. Never mutates status itself, so it is
 * safe to call from inside a `better-sqlite3` transaction alongside the active-row revoke. */
export function listOpenAcquiringAuthorityAttempts(
  ownerKind: AuthorityAttemptOwnerKind,
  ownerId: string
): AuthorityAttempt[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM authority_attempts WHERE owner_kind = ? AND owner_id = ? AND status = 'acquiring' ORDER BY created_at ASC"
    )
    .all(ownerKind, ownerId) as AuthorityAttemptRow[];
  return rows.map(rowToAttempt);
}

/** Every row still `acquiring`/`active` for any owner — the startup sweep's input
 * (authority-lifecycle.ts's reconcileAuthoritiesAtStartup). */
export function listAllOpenAuthorityAttempts(): AuthorityAttempt[] {
  const rows = getDb()
    .prepare("SELECT * FROM authority_attempts WHERE status IN ('acquiring', 'active') ORDER BY created_at ASC")
    .all() as AuthorityAttemptRow[];
  return rows.map(rowToAttempt);
}
