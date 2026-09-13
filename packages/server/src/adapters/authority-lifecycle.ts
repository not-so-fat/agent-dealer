// packages/server/src/adapters/authority-lifecycle.ts
//
// Shared mint/reuse/revoke lifecycle for every caller of execution-authority.ts (NOT-91):
// agent-deck-bind.ts (developer/reviewer worker attempts), reflect-trigger.ts (post-review
// reflection), and queue/approve-deliver.ts (outbound-draft delivery). Each of those used to
// call mintAuthority directly and hold the result only in a local variable for the duration
// of one async function — a crash anywhere in that window left a live, unrevoked authority
// with nothing durable to reconcile against. This module makes `authority_attempts`
// (repository/authority-attempts.ts) the one place that happens, so:
//
//   - a same-owner retry always revokes its predecessor's authority first ("revoke-before-
//     new-attempt" — a superseded attempt has no legitimate further use);
//   - an idempotent remint (Deck reuses a still-live authority for a repeated key and
//     returns no new secret, NOT-85 §7) is recovered from automatically — revoke the
//     orphaned authority, mint again under a derived key — instead of failing the caller's
//     whole attempt, as agent-deck-bind.ts / reflect-trigger.ts / approve-deliver.ts each
//     used to;
//   - AUTHORITY_EXPIRED (benign — the referenced authority merely aged out) auto-retries
//     under a fresh key, while AUTHORITY_REVOKED (an operator/policy decision) is never
//     silently retried — both fold into the same `interaction_required` outcome every
//     caller already parks on, so an explicit revoke gets a human decision before another
//     attempt, exactly like Deck's own INTERACTION_REQUIRED;
//   - recovery.ts / commands.ts's abortIssue can revoke whatever authority a dead/cancelled
//     owner still holds, and reconcileAuthoritiesAtStartup can sweep every attempt a crashed
//     coordinator left open, because the ledger — not a local variable — is authoritative.
import {
  activateAuthorityAttempt,
  closeAuthorityAttempt,
  createAuthorityAttempt,
  listAllOpenAuthorityAttempts,
  listOpenAcquiringAuthorityAttempts,
  listStaleAcquiringAuthorityAttempts,
  markAuthorityAttemptFailed,
  markAuthorityAttemptRevoked,
  markAuthorityAttemptStale,
  revokeOpenActiveAuthorityAttempts,
  type AuthorityAttempt,
  type AuthorityAttemptOwnerKind,
} from "../repository/authority-attempts.js";
import { listWorkItemsForIssue } from "../repository/work-items.js";
import {
  mintAuthority as defaultMintAuthority,
  revokeAuthority as defaultRevokeAuthority,
  type AllowedTool,
  type MintAuthorityInput,
  type MintAuthorityResult,
  type MintedAuthority,
} from "./execution-authority.js";

export type MintFn = (input: MintAuthorityInput) => Promise<MintAuthorityResult>;
export type RevokeFn = (authorityId: string) => Promise<void>;

export interface AcquireAuthorityAttemptInput {
  ownerKind: AuthorityAttemptOwnerKind;
  /** `${issueId}:${ownerKind}` (developer/reviewer — stable across that role's own work-item
   * retry rollover, never a work-item row's own UUID) | issue id (reflect) | run id
   * (outbound_delivery). */
  ownerId: string;
  runId: string;
  attemptId: string;
  deckId: string;
  /** Scoped to the physical attempt (e.g. `${workItemId}:${attemptCount}`) — reused only for
   * a genuine retry of the SAME attempt, never across attempts. */
  idempotencyKey: string;
  ttlMs: number;
  toolScopeHint?: AllowedTool[];
  mint?: MintFn;
  revoke?: RevokeFn;
}

export type AcquireAuthorityAttemptResult =
  | { ok: true; attemptRowId: string; authority: MintedAuthority }
  /** Deck's own INTERACTION_REQUIRED, or an explicit AUTHORITY_REVOKED — either way, a
   * human decision is required before another attempt; never auto-retried. */
  | { ok: false; kind: "interaction_required"; reason: string; requestId?: string }
  | { ok: false; kind: "infra_failure"; reason: string };

/** One bounded auto-retry (AUTHORITY_EXPIRED or a secret-less idempotent remint) beyond the
 * genuine first attempt — enough to recover from a benign, single stale-key collision
 * without looping forever against a persistently misbehaving Deck. */
const MAX_MINT_ATTEMPTS = 2;

export async function acquireAuthorityForAttempt(
  input: AcquireAuthorityAttemptInput
): Promise<AcquireAuthorityAttemptResult> {
  const mint = input.mint ?? defaultMintAuthority;
  const revoke = input.revoke ?? defaultRevokeAuthority;

  // Revoke-before-new-attempt: this idempotencyKey is a fresh attempt for this owner, so any
  // authority still open under a *different* key belonged to a superseded one.
  const closed = await closeOpenAuthorityAttemptsForOwner(input.ownerKind, input.ownerId, { mint, revoke });
  if (closed.unresolved.length > 0) {
    // A predecessor's live/dead state is genuinely unknown (Deck unreachable, an
    // enrollment/policy error, ...) — minting a new authority beside it would risk two live
    // authorities for the same owner if the predecessor turns out to have been live all
    // along. Fail closed: the caller's own infra-retry policy tries again once the
    // predecessor is reconciled (by this same check on the next attempt, the startup sweep,
    // or the periodic retry), instead of proceeding beside an authority of unknown state
    // (NOT-91 review, round 4).
    return {
      ok: false,
      kind: "infra_failure",
      reason:
        "a predecessor execution-authority attempt for this owner could not be resolved (still acquiring, Deck unreachable or an enrollment/policy error) — refusing to mint a new one until it is reconciled",
    };
  }

  let idempotencyKey = input.idempotencyKey;
  for (let attempt = 1; attempt <= MAX_MINT_ATTEMPTS; attempt++) {
    const row = createAuthorityAttempt({
      ownerKind: input.ownerKind,
      ownerId: input.ownerId,
      idempotencyKey,
      deckId: input.deckId,
      runId: input.runId,
      attemptId: input.attemptId,
      ttlMs: input.ttlMs,
      toolScopeHint: input.toolScopeHint,
    });

    const minted = await mint({
      runId: input.runId,
      attemptId: input.attemptId,
      deckId: input.deckId,
      ttlMs: input.ttlMs,
      idempotencyKey,
      ...(input.toolScopeHint ? { toolScopeHint: input.toolScopeHint } : {}),
    });

    if (!minted.ok) {
      markAuthorityAttemptFailed(row.id);
      if (minted.code === "AUTHORITY_EXPIRED" && attempt < MAX_MINT_ATTEMPTS) {
        // Benign — the authority this key used to reference simply aged out. A fresh key
        // mints a genuinely new one; never surfaced to the caller as a failure.
        idempotencyKey = `${input.idempotencyKey}::retry${attempt}`;
        continue;
      }
      if (minted.code === "INTERACTION_REQUIRED" || minted.code === "AUTHORITY_REVOKED") {
        return {
          ok: false,
          kind: "interaction_required",
          reason: minted.message || "Agent Deck requires a control-plane decision before this attempt can continue.",
          requestId: minted.requestId,
        };
      }
      return { ok: false, kind: "infra_failure", reason: `${minted.code}: ${minted.message}` };
    }

    const { authority } = minted;
    if (!authority.authoritySecret) {
      // Idempotent remint of a still-live authority under a reused key (NOT-85 §7) — this
      // caller has no secret to use it with. Revoke the orphaned authority and mint again
      // under a derived key rather than fail the whole attempt.
      await revoke(authority.authorityId);
      markAuthorityAttemptFailed(row.id);
      if (attempt < MAX_MINT_ATTEMPTS) {
        idempotencyKey = `${input.idempotencyKey}::retry${attempt}`;
        continue;
      }
      return {
        ok: false,
        kind: "infra_failure",
        reason: `authority ${authority.authorityId} minted without a secret (idempotent remint) twice in a row`,
      };
    }

    const activated = activateAuthorityAttempt(row.id, {
      authorityId: authority.authorityId,
      expiresAt: authority.expiresAt,
    });
    if (!activated) {
      // Revoked out from under us between mint and activate (e.g. a concurrent abort) —
      // never hand the caller an authority the ledger no longer considers open.
      await revoke(authority.authorityId);
      return { ok: false, kind: "infra_failure", reason: "attempt was cancelled while its authority was being minted" };
    }
    return { ok: true, attemptRowId: row.id, authority };
  }
  /* istanbul ignore next -- the loop always returns from within its body */
  return { ok: false, kind: "infra_failure", reason: "authority acquisition exhausted its bounded retry" };
}

/** Normal end-of-use — one mint, one use, one revoke. */
export async function releaseAuthority(attemptRowId: string, authorityId: string, revoke: RevokeFn = defaultRevokeAuthority): Promise<void> {
  await revoke(authorityId);
  closeAuthorityAttempt(attemptRowId);
}

/** Verify/materialize/delivery failed after a successful mint — the authority has no
 * further legitimate use. */
export async function failAuthority(
  attemptRowId: string,
  authorityId: string | null,
  revoke: RevokeFn = defaultRevokeAuthority
): Promise<void> {
  if (authorityId) await revoke(authorityId);
  markAuthorityAttemptFailed(attemptRowId);
}

export interface ResolveAcquiringResult {
  revoked: string[];
  /** Rows Deck couldn't positively resolve one way or the other (DECK_UNAVAILABLE, an
   * enrollment/policy/scope error, an unexpected INTERACTION_REQUIRED on a resolve replay,
   * ...) — left `acquiring` rather than guessed-terminalized, so a later sweep can still find
   * and close them once the ambiguity clears. */
  unresolved: string[];
}

/** Mint failure codes that *positively prove* no live authority remains for the replayed key
 * — safe to terminalize with nothing left to revoke. Every other code (DECK_UNAVAILABLE, an
 * enrollment/policy/scope error, ...) proves nothing about whether Deck actually committed the
 * original mint, so it must never be treated as "safe to drop" (NOT-91 review, round 3). */
const RESOLVED_NO_LIVE_AUTHORITY_CODES = new Set(["AUTHORITY_EXPIRED", "AUTHORITY_REVOKED"]);

/**
 * Closes one `acquiring` row that has no ledger `authorityId` — the one ambiguous case in this
 * whole lifecycle: a coordinator can crash after Deck committed a mint but before that row was
 * activated with the resulting id, so the ledger alone can't tell "nothing was ever minted"
 * from "a live authority exists that only this row's idempotencyKey can still find." Resolves
 * it the same way a live caller recovers from a secret-less idempotent remint (NOT-85 §7):
 * replay the original mint request under its stored idempotencyKey/runId/attemptId/ttlMs/
 * toolScopeHint. A mint success means a live authority exists (the original, or one this
 * replay just freshly minted) — revoke it. Only `AUTHORITY_EXPIRED`/`AUTHORITY_REVOKED`
 * positively prove nothing is left to revoke; every other failure leaves the row open.
 */
async function resolveAcquiringAttempt(
  row: AuthorityAttempt,
  mint: MintFn,
  revoke: RevokeFn
): Promise<"revoked" | "unresolved"> {
  // Durably flags the row as needing resolution — see schema.sql's `stale_at` comment. If
  // this replay doesn't manage to resolve it (returns "unresolved" below), the stamp is what
  // makes it visible to `retryStaleAuthorityAttempts`'s next periodic tick, regardless of
  // which of the four call sites (startup sweep, cancellation, worker-death reclaim, revoke-
  // before-new-attempt) got here first (NOT-91 review, round 5).
  markAuthorityAttemptStale(row.id);
  const resolved = await mint({
    runId: row.runId,
    attemptId: row.attemptId,
    deckId: row.deckId,
    ttlMs: row.ttlMs,
    idempotencyKey: row.idempotencyKey,
    ...(row.toolScopeHint ? { toolScopeHint: row.toolScopeHint } : {}),
  });
  if (resolved.ok) {
    await revoke(resolved.authority.authorityId);
    markAuthorityAttemptRevoked(row.id);
    return "revoked";
  }
  if (RESOLVED_NO_LIVE_AUTHORITY_CODES.has(resolved.code)) {
    markAuthorityAttemptRevoked(row.id);
    return "revoked";
  }
  return "unresolved";
}

/** Resolves a batch of `acquiring`/no-`authorityId` rows (e.g. gathered inside a cancellation
 * or worker-death-reclaim transaction, before that transaction's synchronous DB work commits)
 * — the async counterpart callers run afterward, outside any surrounding transaction. */
export async function resolveAcquiringAttempts(
  rows: AuthorityAttempt[],
  deps?: { mint?: MintFn; revoke?: RevokeFn }
): Promise<ResolveAcquiringResult> {
  const mint = deps?.mint ?? defaultMintAuthority;
  const revoke = deps?.revoke ?? defaultRevokeAuthority;
  const revoked: string[] = [];
  const unresolved: string[] = [];
  for (const row of rows) {
    const outcome = await resolveAcquiringAttempt(row, mint, revoke);
    (outcome === "revoked" ? revoked : unresolved).push(row.id);
  }
  return { revoked, unresolved };
}

/**
 * Closes every open `authority_attempts` row for one owner: an `active` row (known
 * `authorityId`) is revoked immediately; an `acquiring` row with none yet is resolved via
 * `resolveAcquiringAttempts` instead of being terminalized on a guess. Used by
 * `acquireAuthorityForAttempt`'s revoke-before-new-attempt step, which isn't itself inside a
 * surrounding DB transaction, so it can freely await both steps in one call.
 */
export async function closeOpenAuthorityAttemptsForOwner(
  ownerKind: AuthorityAttemptOwnerKind,
  ownerId: string,
  deps?: { mint?: MintFn; revoke?: RevokeFn }
): Promise<ResolveAcquiringResult> {
  const revoke = deps?.revoke ?? defaultRevokeAuthority;
  const revoked: string[] = [];
  for (const row of revokeOpenActiveAuthorityAttempts(ownerKind, ownerId)) {
    if (row.authorityId) await revoke(row.authorityId);
    revoked.push(row.id);
  }
  const acquiring = listOpenAcquiringAuthorityAttempts(ownerKind, ownerId);
  const resolvedAcquiring = await resolveAcquiringAttempts(acquiring, deps);
  return { revoked: [...revoked, ...resolvedAcquiring.revoked], unresolved: resolvedAcquiring.unresolved };
}

export interface ReconcileAuthoritiesResult {
  revoked: string[];
  /** `acquiring` rows with no ledger `authorityId` that couldn't be positively resolved this
   * sweep — left open (but durably flagged `stale_at`, so `retryStaleAuthorityAttempts`'s
   * periodic query will keep finding and retrying them) rather than guessed-terminalized. */
  unresolved: string[];
}

/** A developer/reviewer owner_id is `${issueId}:${ownerKind}` — stable across that role's own
 * work-item retry rollover (NOT-91 review, round 5), never a work-item row's own UUID. Parses
 * it back out to look up whether *any* work item currently filling that role for that issue is
 * `leased` — a live lease means recovery.ts's own reclaim/dead-letter path (which already
 * revokes on its own trigger) is the one to eventually close this row, not a sweep here. */
function defaultIsOwnerLeased(ownerKind: AuthorityAttemptOwnerKind, ownerId: string): boolean {
  if (ownerKind !== "developer" && ownerKind !== "reviewer") return false;
  const suffix = `:${ownerKind}`;
  if (!ownerId.endsWith(suffix)) return false;
  const issueId = ownerId.slice(0, -suffix.length);
  return listWorkItemsForIssue(issueId).some((item) => item.kind === ownerKind && item.status === "leased");
}

export type IsOwnerLeasedFn = (ownerKind: AuthorityAttemptOwnerKind, ownerId: string) => boolean;

/**
 * Startup-only (index.ts calls this exactly once, alongside recoverCoordinator(), before
 * anything else can create a new `authority_attempts` row): revokes every row a crashed
 * coordinator left open.
 *
 * This whole sweep's premise — "every `acquiring` row and every `reflect`/`outbound_delivery`
 * row is stale" — is true only at a genuine process boundary. Calling this again while the
 * *same* process keeps running would revoke a legitimately in-flight mint or a live
 * reflect/outbound-delivery call out from under it (NOT-91 review, round 4) — that is exactly
 * why the periodic path is a separate function, `retryStaleAuthorityAttempts`, that never
 * rescans every open row and instead only ever retries rows durably flagged `stale_at`.
 *
 * - `acquiring` never legitimately survives a process boundary (it is a sub-second
 *   pre-mint state) — always stale here.
 * - `developer`/`reviewer` rows are stale unless their owning role is still `leased` for that
 *   issue (`defaultIsOwnerLeased`) — closing one here too would race a still-legitimately-
 *   running worker.
 * - `reflect`/`outbound_delivery` rows are always one-shot, coordinator-process-local calls
 *   with no lease of their own — at a genuine process boundary, if one is still open, the
 *   process that opened it is definitionally gone.
 *
 * A stale `acquiring` row with no `authorityId` goes through `resolveAcquiringAttempts`
 * rather than being terminalized directly — see its doc comment for why.
 */
export async function reconcileAuthoritiesAtStartup(deps?: {
  revoke?: RevokeFn;
  mint?: MintFn;
  isOwnerLeased?: IsOwnerLeasedFn;
}): Promise<ReconcileAuthoritiesResult> {
  const revoke = deps?.revoke ?? defaultRevokeAuthority;
  const mint = deps?.mint ?? defaultMintAuthority;
  const isOwnerLeased = deps?.isOwnerLeased ?? defaultIsOwnerLeased;

  const revoked: string[] = [];
  const acquiringToResolve: AuthorityAttempt[] = [];
  for (const row of listAllOpenAuthorityAttempts()) {
    const stale =
      row.status === "acquiring" ||
      (row.ownerKind === "developer" || row.ownerKind === "reviewer" ? !isOwnerLeased(row.ownerKind, row.ownerId) : true);
    if (!stale) continue;

    if (row.status === "acquiring" && !row.authorityId) {
      acquiringToResolve.push(row);
      continue;
    }

    if (row.authorityId) await revoke(row.authorityId);
    markAuthorityAttemptRevoked(row.id);
    revoked.push(row.id);
  }
  const resolvedAcquiring = await resolveAcquiringAttempts(acquiringToResolve, { mint, revoke });
  return { revoked: [...revoked, ...resolvedAcquiring.revoked], unresolved: resolvedAcquiring.unresolved };
}

/**
 * The periodic counterpart to `reconcileAuthoritiesAtStartup` (index.ts calls this on a
 * bounded interval — no state threaded between ticks). Never rescans
 * `listAllOpenAuthorityAttempts()`: unlike the one-time startup sweep, this runs while the
 * process is still live, so re-deriving "every acquiring/process-local row is stale" would
 * revoke a legitimately in-flight mint or a live reflect/outbound-delivery call (NOT-91
 * review, round 4). Instead queries `listStaleAcquiringAuthorityAttempts()` — rows durably
 * flagged `stale_at` by `resolveAcquiringAttempt`, from *any* of the four call sites (startup
 * sweep, cancellation, worker-death reclaim, revoke-before-new-attempt), not just what the
 * startup sweep itself found (NOT-91 review, round 5: a row that only became stale after
 * startup, e.g. via a later cancellation, used to have no path back into the periodic retry
 * at all). A defensive lease check still applies before resolving any of them, in case a row
 * were ever (incorrectly) flagged stale while still genuinely live.
 */
export async function retryStaleAuthorityAttempts(deps?: {
  mint?: MintFn;
  revoke?: RevokeFn;
  isOwnerLeased?: IsOwnerLeasedFn;
}): Promise<ResolveAcquiringResult> {
  const isOwnerLeased = deps?.isOwnerLeased ?? defaultIsOwnerLeased;
  const rows = listStaleAcquiringAuthorityAttempts().filter(
    (row) => !((row.ownerKind === "developer" || row.ownerKind === "reviewer") && isOwnerLeased(row.ownerKind, row.ownerId))
  );
  return resolveAcquiringAttempts(rows, deps);
}
