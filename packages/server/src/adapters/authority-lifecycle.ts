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
  markAuthorityAttemptFailed,
  markAuthorityAttemptRevoked,
  markOpenAuthorityAttemptsRevoked,
  type AuthorityAttemptOwnerKind,
} from "../repository/authority-attempts.js";
import { getWorkItem } from "../repository/work-items.js";
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
  /** work_item id (developer/reviewer) | issue id (reflect) | run id (outbound_delivery). */
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
  for (const stale of markOpenAuthorityAttemptsRevoked(input.ownerKind, input.ownerId)) {
    if (stale.authorityId) await revoke(stale.authorityId);
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

export interface ReconcileAuthoritiesResult {
  revoked: string[];
  /** `acquiring` rows with no ledger `authorityId` that Deck couldn't resolve right now
   * (DECK_UNAVAILABLE) — left open rather than guessed-terminalized, so a later sweep can
   * still find and close them once Deck is reachable again. */
  unresolved: string[];
}

/**
 * Startup-only sweep (called once from index.ts, alongside recoverCoordinator()): revokes
 * every `authority_attempts` row a crashed coordinator left open.
 *
 * - `acquiring` never legitimately survives a process boundary (it is a sub-second
 *   pre-mint state) — always stale.
 * - `developer`/`reviewer` rows are stale unless their owning work item is still `leased`;
 *   a live lease means recovery.ts's own reclaim/dead-letter path (which already revokes on
 *   its own trigger) is the one to eventually close it, not this sweep — closing it here too
 *   would race a still-legitimately-running worker.
 * - `reflect`/`outbound_delivery` rows are always one-shot, coordinator-process-local calls
 *   with no lease of their own — if one is still open at startup, the process that opened it
 *   is definitionally gone.
 *
 * A stale `acquiring` row with no `authorityId` is the one ambiguous case: a coordinator can
 * crash after Deck committed the mint but before this row was activated with the resulting
 * id, so the ledger alone can't tell "nothing was ever minted" from "a live authority exists
 * that only this row's idempotencyKey can still find." Resolve it the same way a live caller
 * recovers from a secret-less idempotent remint (NOT-85 §7): replay the original mint request
 * under its stored idempotencyKey/runId/attemptId/ttlMs/toolScopeHint. A mint success means a
 * live authority exists (whether it's the original or one just freshly minted by this replay)
 * — revoke it. Every typed mint failure other than DECK_UNAVAILABLE means Deck has nothing
 * live to hand back under this key, so the row is safe to terminalize. DECK_UNAVAILABLE alone
 * leaves the row `acquiring` rather than guessing — terminalizing it would be exactly the
 * leak this sweep exists to close.
 */
export async function reconcileAuthoritiesAtStartup(deps?: {
  revoke?: RevokeFn;
  mint?: MintFn;
  isWorkItemLeased?: (workItemId: string) => boolean;
}): Promise<ReconcileAuthoritiesResult> {
  const revoke = deps?.revoke ?? defaultRevokeAuthority;
  const mint = deps?.mint ?? defaultMintAuthority;
  const isWorkItemLeased = deps?.isWorkItemLeased ?? ((id: string) => getWorkItem(id)?.status === "leased");

  const revoked: string[] = [];
  const unresolved: string[] = [];
  for (const row of listAllOpenAuthorityAttempts()) {
    const stale =
      row.status === "acquiring" ||
      (row.ownerKind === "developer" || row.ownerKind === "reviewer" ? !isWorkItemLeased(row.ownerId) : true);
    if (!stale) continue;

    if (row.status === "acquiring" && !row.authorityId) {
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
        revoked.push(row.id);
      } else if (resolved.code === "DECK_UNAVAILABLE") {
        unresolved.push(row.id);
      } else {
        markAuthorityAttemptRevoked(row.id);
        revoked.push(row.id);
      }
      continue;
    }

    if (row.authorityId) await revoke(row.authorityId);
    markAuthorityAttemptRevoked(row.id);
    revoked.push(row.id);
  }
  return { revoked, unresolved };
}
