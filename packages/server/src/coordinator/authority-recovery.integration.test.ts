// packages/server/src/coordinator/authority-recovery.integration.test.ts
//
// NOT-91's recovery/idempotency matrix: named acceptance scenarios for the durable
// execution-authority ledger (repository/authority-attempts.ts) and the shared acquire/
// release lifecycle (adapters/authority-lifecycle.ts) it backs. Each test proves one named
// scenario from the ticket and, together, they prove the suite's cross-cutting properties:
// no duplicate human actions, no duplicate provider effects, no leaked authority secrets,
// and no permanently occupied workers.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MintAuthorityInput, MintAuthorityResult } from "../adapters/execution-authority.js";
import type { DeliverOutboundResult } from "../adapters/outbound-delivery.js";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-authrecovery-"));
process.env.COORDINATOR_FAIL_BACKOFF_MS = "0";

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, getIssue } = await import("../repository/issues.js");
const { listWorkItemsForIssue, getWorkItem, claimWorkItem } = await import("../repository/work-items.js");
const { createHumanAction, listHumanActionsForIssue } = await import("../repository/human-actions.js");
const {
  createAuthorityAttempt,
  activateAuthorityAttempt,
  getAuthorityAttempt,
  listOpenAuthorityAttemptsForOwner,
  markAuthorityAttemptStale,
} = await import("../repository/authority-attempts.js");
const {
  acquireAuthorityForAttempt,
  reconcileAuthoritiesAtStartup,
  retryStaleAuthorityAttempts,
  resolveAcquiringAttempts,
} = await import("../adapters/authority-lifecycle.js");
const { startWorkflow, abortIssue, resolveHumanActionAndAdvance } = await import("./commands.js");
const { recoverCoordinator } = await import("./recovery.js");
const { updateAgent } = await import("../repository/agents.js");
const { createRun, addArtifact, transitionRun, updateRunFields, getRun } = await import("../repository/runs.js");
const { approveRunWithDeliver } = await import("../queue/approve-deliver.js");

before(() => {
  migrate();
  updateAgent(BUILTIN_AGENT_CLAUDE_ID, { workspaceRoot: process.env.AGENT_DEALER_HOME! });
});
beforeEach(() => {
  getDb().exec("DELETE FROM work_items");
  // The periodic-retry tests query listStaleAcquiringAuthorityAttempts() globally (unscoped
  // by owner) — a stale_at row left behind by an earlier test in this shared DB would leak
  // into that scan and inflate its result.
  getDb().exec("DELETE FROM authority_attempts");
});

const DECK = "6e825b59-13de-4ddd-ab7e-55ab5a1c279a";

function newIssue(): string {
  return createIssue({
    title: "NOT-91 recovery matrix",
    acceptanceCriteria: "It works",
    repo: "/repo",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
  }).id;
}

function mintOk(authoritySecret: string | null = "authzs_secret"): (input: MintAuthorityInput) => Promise<MintAuthorityResult> {
  return async (input) => ({
    ok: true,
    authority: {
      authorityId: `authz_${input.idempotencyKey}`,
      authoritySecret,
      deckId: input.deckId,
      audience: "dealer-worker",
      allowedServices: [],
      allowedTools: [],
      expiresAt: "2026-01-01T00:30:00Z",
    },
  });
}

test("scenario: cancellation revokes an in-flight attempt's execution authority", () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  const item = listWorkItemsForIssue(issueId)[0];

  const row = createAuthorityAttempt({
    ownerKind: item.kind,
    ownerId: `${issueId}:${item.kind}`,
    idempotencyKey: `${item.id}:1`,
    deckId: DECK,
    runId: item.id,
    attemptId: `${item.id}:1`,
    ttlMs: 60_000,
  });
  activateAuthorityAttempt(row.id, { authorityId: "authz_cancel", expiresAt: "2099-01-01T00:00:00Z" });

  const result = abortIssue(issueId, "tester");
  assert.equal(result.ok, true);

  // The ledger row is flipped synchronously inside abortIssue's own transaction — no
  // permanently-occupied slot, and nothing left live until TTL for a cancelled attempt.
  assert.equal(getAuthorityAttempt(row.id)!.status, "revoked");
});

test("scenario: cancelling an item whose authority attempt is still acquiring never terminalizes it inside the transaction on a guess", () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  const item = listWorkItemsForIssue(issueId)[0];

  // No authorityId yet — models a crash between "asked Deck for authority" and "this row
  // got activated." abortIssue's own transaction must not assume this is safe to revoke
  // directly (there is no authorityId to revoke, and no proof nothing was ever minted) — it
  // has to be resolved via its stored idempotencyKey afterward, not bulk-terminalized here
  // (NOT-91 review, round 3).
  const row = createAuthorityAttempt({
    ownerKind: item.kind,
    ownerId: `${issueId}:${item.kind}`,
    idempotencyKey: `${item.id}:1`,
    deckId: DECK,
    runId: item.id,
    attemptId: `${item.id}:1`,
    ttlMs: 60_000,
  });

  const result = abortIssue(issueId, "tester");
  assert.equal(result.ok, true);

  // Still `acquiring` immediately after abortIssue returns — the transaction only revoked
  // `active` rows synchronously; this one is left for the async, out-of-transaction resolve
  // step (fire-and-forget), never flipped to `revoked` on a guess.
  assert.equal(getAuthorityAttempt(row.id)!.status, "acquiring");
});

test("scenario: late approval after cancellation is recorded but cannot restart work", () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  const instance = listWorkItemsForIssue(issueId)[0];
  void instance;

  // A control-plane park exactly like acquireWorkerAuthority raises on INTERACTION_REQUIRED.
  const parked = createHumanAction({
    issueId,
    actionType: "deck_interaction_required",
    reason: "Approve the coordinator enrollment.",
    question: "Resume or close?",
    responseOptions: [{ choice: "resume" }, { choice: "close" }],
  });

  // The operator cancels the whole issue before ever looking at the queue...
  const aborted = abortIssue(issueId, "tester");
  assert.equal(aborted.ok, true);

  // ...and the parked action was auto-resolved by the abort itself (commands.ts's
  // abortIssue resolves every still-open human action as part of the same transaction).
  assert.equal(listHumanActionsForIssue(issueId).find((a) => a.id === parked.id)!.status, "resolved");

  // A late "resume" arriving after that (an operator who had the tab open) must be
  // rejected, never silently reopen the now-closed issue or enqueue new work.
  const late = resolveHumanActionAndAdvance(parked.id, "operator", "resume");
  assert.equal(late.ok, false);
  assert.equal(getIssue(issueId)!.status, "closed");
  const items = listWorkItemsForIssue(issueId);
  assert.equal(items.length, 1, "the late approval enqueued no additional work item");
  assert.equal(items[0].status, "cancelled");
});

test("scenario: duplicate callback/error for the same request id dedupes to one open human action under a race", () => {
  const issueId = newIssue();
  // Two "concurrent" duplicate INTERACTION_REQUIRED deliveries both call createHumanAction
  // directly (skipping the read-then-create check callers normally do first) — proving the
  // DB-level ON CONFLICT, not just the read-check, is what prevents the duplicate.
  const first = createHumanAction({
    issueId,
    actionType: "deck_interaction_required",
    reason: "Approve the coordinator enrollment.",
    question: "Resume or close?",
    responseOptions: [{ choice: "resume" }, { choice: "close" }],
    requestId: "req_dup_race",
  });
  const second = createHumanAction({
    issueId,
    actionType: "deck_interaction_required",
    reason: "Approve the coordinator enrollment (repeat delivery).",
    question: "Resume or close?",
    responseOptions: [{ choice: "resume" }, { choice: "close" }],
    requestId: "req_dup_race",
  });

  assert.equal(second.id, first.id, "the second insert must dedupe onto the first, not create a sibling row");
  assert.equal(
    listHumanActionsForIssue(issueId).filter((a) => a.actionType === "deck_interaction_required" && a.status === "open").length,
    1
  );
});

test("scenario: coordinator restart revokes every attempt a crashed process left open, and only those", async () => {
  // A DIFFERENT item IS still leased — a live claim outstanding when the process boots. Its
  // authority must be left alone here; recovery.ts's own lease-expiry reclaim is what
  // eventually revokes it, not the startup sweep (revoking a live attempt out from under a
  // genuinely still-running worker would be the leak this suite exists to prevent). Claimed
  // first (while it's the only pending item) so `claimWorkItem`'s oldest-pending pick can't
  // grab the "stale" item created below instead.
  const liveIssueId = newIssue();
  startWorkflow(liveIssueId);
  const liveItem = listWorkItemsForIssue(liveIssueId)[0];
  claimWorkItem("leaseholder", { leaseMs: 600_000 });
  assert.equal(getWorkItem(liveItem.id)!.status, "leased");
  const liveActive = createAuthorityAttempt({
    ownerKind: liveItem.kind,
    ownerId: `${liveIssueId}:${liveItem.kind}`,
    idempotencyKey: `${liveItem.id}:1`,
    deckId: DECK,
    runId: liveItem.id,
    attemptId: `${liveItem.id}:1`,
    ttlMs: 60_000,
  });
  activateAuthorityAttempt(liveActive.id, { authorityId: "authz_live", expiresAt: "2099-01-01T00:00:00Z" });

  // Item is `pending`, not `leased` — simulates "the coordinator crashed before this
  // attempt's worker was ever claimed/spawned."
  const staleIssueId = newIssue();
  startWorkflow(staleIssueId);
  const staleItem = listWorkItemsForIssue(staleIssueId)[0];
  assert.equal(getWorkItem(staleItem.id)!.status, "pending");
  const staleActive = createAuthorityAttempt({
    ownerKind: staleItem.kind,
    ownerId: `${staleIssueId}:${staleItem.kind}`,
    idempotencyKey: `${staleItem.id}:1`,
    deckId: DECK,
    runId: staleItem.id,
    attemptId: `${staleItem.id}:1`,
    ttlMs: 60_000,
  });
  activateAuthorityAttempt(staleActive.id, { authorityId: "authz_stale", expiresAt: "2099-01-01T00:00:00Z" });

  // Still `acquiring` with no ledger authorityId — models a crash between "Deck committed
  // the mint" and "this row got activated." Reconciliation must not assume there's nothing
  // to revoke just because the ledger never recorded an id; it must resolve by replaying the
  // stored idempotencyKey, discover the live authority the mint stub hands back, and revoke
  // that instead of silently dropping it (NOT-91 review).
  const stillAcquiring = createAuthorityAttempt({
    ownerKind: "reflect",
    ownerId: staleIssueId,
    idempotencyKey: "reflect-1",
    deckId: DECK,
    runId: staleIssueId,
    attemptId: "reflect-1",
    ttlMs: 60_000,
  });

  const revokedIds: string[] = [];
  const result = await reconcileAuthoritiesAtStartup({
    revoke: async (id) => void revokedIds.push(id),
    mint: async () => ({
      ok: true,
      authority: {
        authorityId: "authz_resolved_reflect",
        authoritySecret: null,
        deckId: DECK,
        audience: "dealer-worker",
        allowedServices: [],
        allowedTools: [],
        expiresAt: "2099-01-01T00:00:00Z",
      },
    }),
  });

  assert.ok(result.revoked.includes(staleActive.id));
  assert.ok(result.revoked.includes(stillAcquiring.id));
  assert.ok(!result.revoked.includes(liveActive.id), "a still-leased owner's authority must not be revoked by the startup sweep");
  assert.deepEqual(
    new Set(revokedIds),
    new Set(["authz_stale", "authz_resolved_reflect"]),
    "an acquiring row with no ledger authorityId is resolved via its idempotency key before being terminalized, not skipped"
  );
  assert.equal(getAuthorityAttempt(staleActive.id)!.status, "revoked");
  assert.equal(getAuthorityAttempt(stillAcquiring.id)!.status, "revoked");
  assert.equal(getAuthorityAttempt(liveActive.id)!.status, "active");
});

test("scenario: coordinator restart leaves an unresolved acquiring attempt open when Deck is unreachable, rather than guessing it's safe to drop", async () => {
  const issueId = newIssue();
  const row = createAuthorityAttempt({
    ownerKind: "reflect",
    ownerId: issueId,
    idempotencyKey: "reflect-unreachable",
    deckId: DECK,
    runId: issueId,
    attemptId: "reflect-unreachable",
    ttlMs: 60_000,
  });

  const result = await reconcileAuthoritiesAtStartup({
    revoke: async () => {},
    mint: async () => ({ ok: false, code: "DECK_UNAVAILABLE", message: "ECONNREFUSED" }),
  });

  assert.ok(result.unresolved.includes(row.id));
  assert.ok(!result.revoked.includes(row.id));
  assert.equal(
    getAuthorityAttempt(row.id)!.status,
    "acquiring",
    "left open for a later sweep instead of being guessed-terminalized while Deck is unreachable"
  );
});

test("scenario: coordinator restart leaves an acquiring attempt open on a local enrollment error too, not just DECK_UNAVAILABLE", async () => {
  // COORDINATOR_NOT_ENROLLED/RESOURCE_OUT_OF_SCOPE can both be produced without the resolve
  // replay ever proving whether Deck committed the original mint — only AUTHORITY_EXPIRED/
  // AUTHORITY_REVOKED positively prove nothing is left to revoke (NOT-91 review, round 3).
  const issueId = newIssue();
  const row = createAuthorityAttempt({
    ownerKind: "reflect",
    ownerId: issueId,
    idempotencyKey: "reflect-not-enrolled",
    deckId: DECK,
    runId: issueId,
    attemptId: "reflect-not-enrolled",
    ttlMs: 60_000,
  });

  const result = await reconcileAuthoritiesAtStartup({
    revoke: async () => {},
    mint: async () => ({ ok: false, code: "COORDINATOR_NOT_ENROLLED", message: "no bearer configured" }),
  });

  assert.ok(result.unresolved.includes(row.id));
  assert.ok(!result.revoked.includes(row.id));
  assert.equal(getAuthorityAttempt(row.id)!.status, "acquiring");
});

test("scenario: worker death (lease expiry) revokes the attempt's authority and returns the item to pending, never permanently occupied", () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  const item = listWorkItemsForIssue(issueId)[0];
  claimWorkItem("crashed-worker", { leaseMs: 1 });

  const row = createAuthorityAttempt({
    ownerKind: item.kind,
    ownerId: `${issueId}:${item.kind}`,
    idempotencyKey: `${item.id}:1`,
    deckId: DECK,
    runId: item.id,
    attemptId: `${item.id}:1`,
    ttlMs: 60_000,
  });
  activateAuthorityAttempt(row.id, { authorityId: "authz_deadworker", expiresAt: "2099-01-01T00:00:00Z" });

  const res = recoverCoordinator({ now: Date.now() + 3_600_000 });
  assert.deepEqual(res.reclaimed, [item.id]);
  assert.equal(getWorkItem(item.id)!.status, "pending", "the worker slot is freed, never left occupied by the dead attempt");
  assert.equal(getAuthorityAttempt(row.id)!.status, "revoked");
});

test("scenario: worker death never terminalizes a still-acquiring attempt inside the reclaim itself, only via async resolve", () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  const item = listWorkItemsForIssue(issueId)[0];
  claimWorkItem("crashed-worker-2", { leaseMs: 1 });

  // No authorityId yet — same ambiguous case as the cancellation regression above, but via
  // the lease-expiry reclaim path (recovery.ts's revokeStaleAuthoritiesForItem).
  const row = createAuthorityAttempt({
    ownerKind: item.kind,
    ownerId: `${issueId}:${item.kind}`,
    idempotencyKey: `${item.id}:1`,
    deckId: DECK,
    runId: item.id,
    attemptId: `${item.id}:1`,
    ttlMs: 60_000,
  });

  const res = recoverCoordinator({ now: Date.now() + 3_600_000 });
  assert.deepEqual(res.reclaimed, [item.id]);
  assert.equal(
    getAuthorityAttempt(row.id)!.status,
    "acquiring",
    "left for the async, out-of-loop resolve step — recovery's own synchronous CAS never guesses this is safe to revoke"
  );
});

test("scenario: Agent Deck outage is a bounded, typed failure — no infinite retry, no ledger row stuck open", async () => {
  let mintCalls = 0;
  const result = await acquireAuthorityForAttempt({
    ownerKind: "developer",
    ownerId: "wi-outage",
    runId: "run-outage",
    attemptId: "wi-outage",
    deckId: DECK,
    ttlMs: 60_000,
    idempotencyKey: "wi-outage:1",
    mint: async () => {
      mintCalls += 1;
      return { ok: false, code: "DECK_UNAVAILABLE", message: "ECONNREFUSED" };
    },
    revoke: async () => {},
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.kind, "infra_failure");
  assert.equal(mintCalls, 1, "an outright connection failure is not the bounded auto-retry's job — it surfaces immediately to the caller's own infra-retry policy");
  assert.equal(listOpenAuthorityAttemptsForOwner("developer", "wi-outage").length, 0, "the failed ledger row is closed out, not left acquiring forever");
});

test("scenario: authority expiry mid-attempt auto-recovers under a fresh key, distinct from an explicit revoke", async () => {
  let call = 0;
  const seenKeys: string[] = [];
  const result = await acquireAuthorityForAttempt({
    ownerKind: "developer",
    ownerId: "wi-expiry",
    runId: "run-expiry",
    attemptId: "wi-expiry",
    deckId: DECK,
    ttlMs: 60_000,
    idempotencyKey: "wi-expiry:1",
    mint: async (input) => {
      call += 1;
      seenKeys.push(input.idempotencyKey);
      if (call === 1) return { ok: false, code: "AUTHORITY_EXPIRED", message: "expired" };
      return mintOk()(input);
    },
    revoke: async () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(call, 2, "expiry is recovered from transparently — never surfaced as a caller-visible failure");
  assert.notEqual(seenKeys[0], seenKeys[1], "the retry after expiry must use a fresh idempotency key, not repeat the dead one");

  // An explicit AUTHORITY_REVOKED, by contrast, is never auto-retried — it parks.
  const revokedResult = await acquireAuthorityForAttempt({
    ownerKind: "developer",
    ownerId: "wi-revoked",
    runId: "run-revoked",
    attemptId: "wi-revoked",
    deckId: DECK,
    ttlMs: 60_000,
    idempotencyKey: "wi-revoked:1",
    mint: async () => ({ ok: false, code: "AUTHORITY_REVOKED", message: "revoked by operator", requestId: "req_revoked" }),
    revoke: async () => {},
  });
  assert.equal(revokedResult.ok, false);
  if (!revokedResult.ok) {
    assert.equal(revokedResult.kind, "interaction_required", "a revoke is an operator/policy decision — it must wait for a human, not silently remint");
    assert.equal(revokedResult.requestId, "req_revoked");
  }
});

test("scenario: an ambiguous downstream result (timeout) is parked for a human decision, never silently auto-retried", async () => {
  const { deliverOutboundDraft } = await import("../adapters/outbound-delivery.js");
  const result = await deliverOutboundDraft(DECK, { serviceName: "slack", toolName: "chat_postMessage", arguments: {} }, {
    callTool: async () => {
      throw new Error("Outbound deliver timed out after 60000ms");
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.kind, "ambiguous");

  const run = createRun({ title: "Ambiguous delivery", taskCategory: "communication", status: "plan_pending", agentId: BUILTIN_AGENT_CLAUDE_ID });
  updateRunFields(run.id, { deck_id: DECK });
  transitionRun(run.id, "plan_approved");
  transitionRun(run.id, "running");
  transitionRun(run.id, "review");
  addArtifact(
    run.id,
    "slack_draft",
    {
      draft: { actionType: "slack_message", summary: { target: "#test", body: "hi" }, toolCall: { serviceName: "slack", toolName: "chat_postMessage", arguments: {} } },
      status: "pending",
    },
    "agent"
  );

  const approveRes = await approveRunWithDeliver(run.id, {
    deliver: async (): Promise<DeliverOutboundResult> => ({ ok: false, kind: "ambiguous", reason: "timed out — unknown" }),
  });
  assert.equal(approveRes.ok, false);
  if (!approveRes.ok) assert.equal(approveRes.errorCode, "AMBIGUOUS_RESULT");

  const { listHumanActionsForRun } = await import("../repository/human-actions.js");
  const parked = listHumanActionsForRun(run.id).find((a) => a.actionType === "outbound_delivery_interaction_required" && a.status === "open");
  assert.ok(parked, "an ambiguous result must raise an explicit retry/reject decision, not disappear as an ordinary failure");
  assert.equal(getRun(run.id)!.status, "review", "still blocked on the human decision, never silently advanced");
});

test("scenario: same-attempt idempotent remint recovers instead of failing the whole attempt, and revokes the orphaned secret-less authority", async () => {
  const revoked: string[] = [];
  const result = await acquireAuthorityForAttempt({
    ownerKind: "outbound_delivery",
    ownerId: "run-remint",
    runId: "run-remint",
    attemptId: "draft-1",
    deckId: DECK,
    ttlMs: 60_000,
    idempotencyKey: "draft-1:1",
    mint: mintOk(null), // every mint in this test "succeeds" but never issues a secret
    revoke: async (id) => void revoked.push(id),
  });
  // Both the genuine attempt and its one bounded retry hit the same secret-less remint —
  // the second failure is the one that finally surfaces, but neither ever leaked a
  // usable secret to the caller.
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.kind, "infra_failure");
  assert.equal(revoked.length, 2, "every secret-less authority Deck ever handed back was revoked, not left live");

  // The success path: the first mint is a secret-less remint, the second (fresh key) is real.
  let call = 0;
  const recovered = await acquireAuthorityForAttempt({
    ownerKind: "outbound_delivery",
    ownerId: "run-remint-2",
    runId: "run-remint-2",
    attemptId: "draft-2",
    deckId: DECK,
    ttlMs: 60_000,
    idempotencyKey: "draft-2:1",
    mint: async (input) => {
      call += 1;
      return mintOk(call === 1 ? null : "authzs_real")(input);
    },
    revoke: async (id) => void revoked.push(id),
  });
  assert.equal(recovered.ok, true);
  if (recovered.ok) assert.equal(recovered.authority.authoritySecret, "authzs_real");
});

test("scenario: revoke-before-new-attempt — a fresh attempt for the same owner revokes its predecessor's still-open authority first", async () => {
  const ownerId = "wi-supersede";
  const revoked: string[] = [];
  const first = await acquireAuthorityForAttempt({
    ownerKind: "developer",
    ownerId,
    runId: "run-supersede",
    attemptId: ownerId,
    deckId: DECK,
    ttlMs: 60_000,
    idempotencyKey: `${ownerId}:1`,
    mint: mintOk(),
    revoke: async (id) => void revoked.push(id),
  });
  assert.equal(first.ok, true);

  // A retry of the SAME owner under a NEW idempotencyKey (e.g. a reclaimed lease bumped
  // attempt_count) — the first attempt's authority was never explicitly released (the
  // crash this scenario models), so it is still `active` in the ledger.
  assert.equal(listOpenAuthorityAttemptsForOwner("developer", ownerId).length, 1);

  const second = await acquireAuthorityForAttempt({
    ownerKind: "developer",
    ownerId,
    runId: "run-supersede",
    attemptId: ownerId,
    deckId: DECK,
    ttlMs: 60_000,
    idempotencyKey: `${ownerId}:2`,
    mint: mintOk(),
    revoke: async (id) => void revoked.push(id),
  });
  assert.equal(second.ok, true);
  if (first.ok) assert.ok(revoked.includes(first.authority.authorityId), "the superseded attempt's authority must be revoked, not left live until TTL");
  assert.equal(listOpenAuthorityAttemptsForOwner("developer", ownerId).length, 1, "exactly the new attempt is open — no leaked duplicate authority for one owner");
});

test("scenario: revoke-before-new-attempt resolves an acquiring (no authorityId yet) predecessor via replay, not a guess", async () => {
  const ownerId = "wi-supersede-acquiring";
  const revoked: string[] = [];

  // The predecessor never got past `acquiring` — models a crash between "asked Deck for
  // authority" and "this row got activated." This used to be bulk-terminalized by a fresh
  // attempt without ever attempting to resolve it (NOT-91 review, round 3's exact repro).
  const stalePredecessor = createAuthorityAttempt({
    ownerKind: "developer",
    ownerId,
    idempotencyKey: `${ownerId}:1`,
    deckId: DECK,
    runId: "run-supersede-acquiring",
    attemptId: ownerId,
    ttlMs: 60_000,
  });

  let mintCalls = 0;
  const second = await acquireAuthorityForAttempt({
    ownerKind: "developer",
    ownerId,
    runId: "run-supersede-acquiring",
    attemptId: ownerId,
    deckId: DECK,
    ttlMs: 60_000,
    idempotencyKey: `${ownerId}:2`,
    mint: async (input) => {
      mintCalls += 1;
      // Replaying the predecessor's own key hands back the live authority Deck actually
      // committed before the crash (an idempotent remint — no new secret); the real
      // second-attempt mint, under its own key, succeeds normally.
      if (input.idempotencyKey === `${ownerId}:1`) return mintOk(null)(input);
      return mintOk()(input);
    },
    revoke: async (id) => void revoked.push(id),
  });

  assert.equal(second.ok, true);
  assert.ok(mintCalls >= 2, "the predecessor's key was replayed to resolve it, not skipped");
  assert.ok(
    revoked.includes(`authz_${ownerId}:1`),
    "the live authority discovered behind the acquiring predecessor was revoked, not left until TTL"
  );
  assert.equal(getAuthorityAttempt(stalePredecessor.id)!.status, "revoked");
});

test("scenario: a fresh attempt fails closed rather than minting beside an unresolved predecessor", async () => {
  const ownerId = "wi-supersede-unresolved";
  const revoked: string[] = [];
  let newKeyMintCalls = 0;

  const stalePredecessor = createAuthorityAttempt({
    ownerKind: "developer",
    ownerId,
    idempotencyKey: `${ownerId}:1`,
    deckId: DECK,
    runId: "run-supersede-unresolved",
    attemptId: ownerId,
    ttlMs: 60_000,
  });

  const second = await acquireAuthorityForAttempt({
    ownerKind: "developer",
    ownerId,
    runId: "run-supersede-unresolved",
    attemptId: ownerId,
    deckId: DECK,
    ttlMs: 60_000,
    idempotencyKey: `${ownerId}:2`,
    mint: async (input) => {
      // COORDINATOR_NOT_ENROLLED can be produced locally (missing bearer) before any
      // request reaches Deck — it proves nothing about whether the original mint
      // committed, unlike AUTHORITY_EXPIRED/AUTHORITY_REVOKED (NOT-91 review, round 3).
      if (input.idempotencyKey === `${ownerId}:1`) {
        return { ok: false, code: "COORDINATOR_NOT_ENROLLED", message: "no bearer" };
      }
      newKeyMintCalls += 1;
      return mintOk()(input);
    },
    revoke: async (id) => void revoked.push(id),
  });

  // An unresolved predecessor's live/dead state is unknown — minting a new authority beside
  // it would risk two live authorities for the same owner if it turns out to have been live
  // all along. Must fail closed instead of proceeding (NOT-91 review, round 4).
  assert.equal(second.ok, false, "must not mint a new authority while a predecessor's state is unknown");
  if (!second.ok) assert.equal(second.kind, "infra_failure");
  assert.equal(newKeyMintCalls, 0, "no new authority was minted beside the unresolved predecessor");
  assert.equal(
    getAuthorityAttempt(stalePredecessor.id)!.status,
    "acquiring",
    "an enrollment error proves nothing about whether Deck actually committed the original mint — must not be terminalized on a guess"
  );
  assert.equal(revoked.length, 0, "nothing was revoked for a row that was never positively resolved");
});

test("scenario: the periodic retry only ever finds rows durably flagged stale — a live active row is never even a candidate", async () => {
  const revoked: string[] = [];

  const liveRow = createAuthorityAttempt({
    ownerKind: "reflect",
    ownerId: "issue-live-reflect",
    idempotencyKey: "reflect-live",
    deckId: DECK,
    runId: "issue-live-reflect",
    attemptId: "reflect-live",
    ttlMs: 60_000,
  });
  activateAuthorityAttempt(liveRow.id, { authorityId: "authz_live_reflect", expiresAt: "2099-01-01T00:00:00Z" });

  // Nothing ever flagged this row `stale_at` (unlike an unresolved row from
  // reconcileAuthoritiesAtStartup/abort/reclaim/revoke-before-new-attempt, all of which go
  // through resolveAcquiringAttempt's stamp) — retryStaleAuthorityAttempts's DB query for
  // `status='acquiring' AND stale_at IS NOT NULL` structurally excludes it, whether or not it
  // is `active` (NOT-91 review, round 5).
  const result = await retryStaleAuthorityAttempts({ revoke: async (id) => void revoked.push(id) });

  assert.deepEqual(result.revoked, []);
  assert.deepEqual(result.unresolved, []);
  assert.equal(revoked.length, 0);
  assert.equal(getAuthorityAttempt(liveRow.id)!.status, "active", "a live active row must never be revoked by the periodic retry");
});

test("scenario: the periodic retry's defensive lease check still applies even if a row were somehow flagged stale while genuinely live", async () => {
  const issueId = newIssue();
  startWorkflow(issueId);
  const item = listWorkItemsForIssue(issueId)[0];
  claimWorkItem("live-leaseholder", { leaseMs: 600_000 });
  assert.equal(getWorkItem(item.id)!.status, "leased");

  const ownerId = `${issueId}:${item.kind}`;
  const liveAcquiring = createAuthorityAttempt({
    ownerKind: item.kind,
    ownerId,
    idempotencyKey: `${item.id}:1`,
    deckId: DECK,
    runId: item.id,
    attemptId: `${item.id}:1`,
    ttlMs: 60_000,
  });
  // Simulates a row wrongly flagged stale (in reality, nothing flags a developer/reviewer row
  // stale while its item is still leased — reconcileAuthoritiesAtStartup's own `isOwnerLeased`
  // check filters it out first) — the retry's own lease check is defense in depth for exactly
  // this case (NOT-91 review, round 5).
  markAuthorityAttemptStale(liveAcquiring.id);

  let mintCalls = 0;
  const result = await retryStaleAuthorityAttempts({
    mint: async () => {
      mintCalls += 1;
      return { ok: false, code: "DECK_UNAVAILABLE", message: "should never be called" };
    },
    revoke: async () => {},
  });

  assert.deepEqual(result.revoked, []);
  assert.deepEqual(result.unresolved, []);
  assert.equal(mintCalls, 0, "a still-leased owner's row must never be resolved, even once flagged stale");
  assert.equal(getAuthorityAttempt(liveAcquiring.id)!.status, "acquiring");
});

test("scenario: the periodic retry finds a row that only became unresolved outside the startup sweep, e.g. via a cancellation while Deck was unreachable", async () => {
  const row = createAuthorityAttempt({
    ownerKind: "reflect",
    ownerId: "issue-post-startup-cancel",
    idempotencyKey: "reflect-post-startup-cancel",
    deckId: DECK,
    runId: "issue-post-startup-cancel",
    attemptId: "reflect-post-startup-cancel",
    ttlMs: 60_000,
  });

  // Models what abortIssue's fire-and-forget resolve does when Deck happens to be
  // unreachable at cancel time: resolveAcquiringAttempts durably flags the row `stale_at`
  // (via resolveAcquiringAttempt) even though it can't resolve it this call. No startup
  // sweep ever ran on this row — it only exists because of a cancellation that happened
  // during normal runtime, well after boot (NOT-91 review, round 5).
  const firstAttempt = await resolveAcquiringAttempts([row], {
    mint: async () => ({ ok: false, code: "DECK_UNAVAILABLE", message: "ECONNREFUSED" }),
    revoke: async () => {},
  });
  assert.deepEqual(firstAttempt.unresolved, [row.id]);
  assert.equal(getAuthorityAttempt(row.id)!.status, "acquiring");

  let mintCalls = 0;
  const result = await retryStaleAuthorityAttempts({
    mint: async (input) => {
      mintCalls += 1;
      return mintOk()(input);
    },
    revoke: async () => {},
  });

  assert.equal(mintCalls, 1, "the periodic sweep found the row via its durable stale_at flag, with no in-memory list carrying it forward");
  assert.deepEqual(result.revoked, [row.id]);
  assert.equal(getAuthorityAttempt(row.id)!.status, "revoked");
});
