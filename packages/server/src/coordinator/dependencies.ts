// packages/server/src/coordinator/dependencies.ts
//
// NOT-104: dependency readiness from *declared* Linear blockers.
//
// Dealer never infers a dependency graph — no file overlap, no same-repo ordering. The only
// edge that gates admission is an explicit `blocks` relation a human wrote in Linear. This
// module owns the three pieces the `blockedByDependency` rule needs:
//
//   1. a batched, TTL-cached, injectable provider that turns queued issues into a snapshot
//      of their declared blockers (`blockerSnapshotFor`),
//   2. the per-blocker satisfaction rule (dealer `done` beats Linear's "Done"),
//   3. the operator-facing wait reason.
//
// There is no `issue_dependencies` table: a dealer-linked blocker is a pure local join and is
// always live, so only the edge itself and the Linear state of *unlinked* blockers are remote.
// A persisted table can replace the provider later without touching the rule.

import { isTerminalIssueStatus, type Issue } from "@agent-dealer/shared";
import { fetchLinearBlockers, type LinearBlockerNode } from "../adapters/linear-inbox.js";
import { listIssuesByExternalId } from "../repository/issues.js";

export type BlockerState = LinearBlockerNode;

/**
 * Declared blockers per Linear issue id, as of this `admitNext()`.
 *
 * A **missing key means "unknown", not "none"** — that is the whole fail-closed posture. A
 * fetch failure, a hung API, a cold cache or an issue Linear would not return all leave the
 * id out, and the rule parks the entry with `dependency state unavailable` rather than
 * running work that a silent dependency dooms.
 */
export type BlockerSnapshot = ReadonlyMap<string, BlockerState[]>;

/** Injectable for tests, mirroring `setAdmissionHealthCheckerForTests`. May throw / hang. */
export type BlockersProvider = (issues: Issue[]) => Promise<BlockerSnapshot>;

/** Fetch the whole batch, not one call per queued entry. */
export type LinearBlockerFetcher = (issueIds: string[]) => Promise<Map<string, BlockerState[]>>;

const EMPTY_SNAPSHOT: BlockerSnapshot = new Map();

const DEFAULT_CACHE_TTL_MS = 60_000;

/**
 * Admission runs inside the ~3s coordinator tick and this is the first remote call in that
 * path, so it is hard-bounded: a hanging Linear API degrades to "unavailable" (everything
 * parks, nothing is dropped) instead of stalling every worker dispatch behind it. The budget
 * plus both graces below stays under that tick — a healthy Linear answers in well under a
 * second, and one slow read must not cost the loop a whole cycle.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 1_500;

/** Grace on top of the per-request budget, so the request's own error wins over the wrapper. */
const TIMEOUT_GRACE_MS = 250;

/**
 * After a failed fetch, wait this long before asking Linear again. Only *successes* are
 * cached, so without this the 3s coordinator tick retries an outage ~1200 times an hour —
 * against a 1500/hr personal-key limit that the inbox poller and status write-back share.
 * Entries stay parked either way; recovery is just delayed by at most this window.
 */
const FAILURE_BACKOFF_MS = 10_000;

let cacheTtlMs = DEFAULT_CACHE_TTL_MS;
let fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS;
let failureBackoffMs = FAILURE_BACKOFF_MS;
let blockersProvider: BlockersProvider | null = null;
let linearFetcher: LinearBlockerFetcher | null = null;

const cache = new Map<string, { at: number; blockers: BlockerState[] }>();
let backoffUntil = 0;
let inFlight: Promise<Map<string, BlockerState[]>> | null = null;
let lastLoggedError: string | null = null;

/** Tests inject a pure provider so admission never reaches the network. */
export function setBlockersProviderForTests(provider: BlockersProvider | null): void {
  blockersProvider = provider;
}

/** Narrower seam: keeps the real caching/TTL policy, replaces only the Linear call. */
export function setLinearBlockerFetcherForTests(fetcher: LinearBlockerFetcher | null): void {
  linearFetcher = fetcher;
}

export function setBlockerCacheTtlForTests(ms: number | null): void {
  cacheTtlMs = ms ?? DEFAULT_CACHE_TTL_MS;
}

export function setBlockerFetchTimeoutForTests(ms: number | null): void {
  fetchTimeoutMs = ms ?? DEFAULT_FETCH_TIMEOUT_MS;
}

/** Also re-scales a window already running, so a test can lapse one without sleeping it out. */
export function setBlockerFailureBackoffForTests(ms: number | null): void {
  failureBackoffMs = ms ?? FAILURE_BACKOFF_MS;
  backoffUntil = Math.min(backoffUntil, Date.now() + failureBackoffMs);
}

export function clearBlockerCacheForTests(): void {
  cache.clear();
  backoffUntil = 0;
  inFlight = null;
  lastLoggedError = null;
}

export function resetDependenciesForTests(): void {
  blockersProvider = null;
  linearFetcher = null;
  cacheTtlMs = DEFAULT_CACHE_TTL_MS;
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS;
  failureBackoffMs = FAILURE_BACKOFF_MS;
  clearBlockerCacheForTests();
}

/** Only a Linear-sourced issue carries declared dependencies; manual issues are a no-op. */
export function isDependencyTracked(issue: Issue): issue is Issue & { externalId: string } {
  return issue.source === "linear" && Boolean(issue.externalId);
}

/**
 * The default provider: one batched Linear query per `admitNext()` that finds a free slot,
 * memoized per issue id for `cacheTtlMs`.
 *
 * **No stale-while-error.** An entry past its TTL is dropped rather than reused when the
 * refresh fails — a dependency declared *during* a Linear outage would otherwise be
 * invisible for as long as the outage lasts, which is exactly the doomed run this prevents.
 */
export async function blockersFor(issues: Issue[]): Promise<BlockerSnapshot> {
  const ids = [...new Set(issues.filter(isDependencyTracked).map((i) => i.externalId))];
  const snapshot = new Map<string, BlockerState[]>();
  const now = Date.now();
  const stale: string[] = [];

  // Expired rows are never served, so drop them outright — otherwise every Linear issue ever
  // queued stays in the map for the life of the process.
  for (const [id, hit] of cache) if (now - hit.at >= cacheTtlMs) cache.delete(id);

  for (const id of ids) {
    const hit = cache.get(id);
    if (hit) snapshot.set(id, hit.blockers);
    else stale.push(id);
  }
  if (stale.length === 0) return snapshot;
  if (now < backoffUntil) throw new Error("blocker fetch backing off after a recent failure");
  // Ticks overlap (the 3s loop plus a Manual Start): the second one parks rather than opening
  // a second connection to an API that is, by definition, slower than a tick right now.
  if (inFlight) throw new Error("blocker fetch already in flight");

  // Throwing (rather than falling back to the expired rows) is what makes the TTL a hard
  // edge: the caller turns a throw into "unavailable", never into "no blockers".
  const pending = withTimeout(
    (linearFetcher ?? defaultLinearFetcher)(stale),
    fetchTimeoutMs + TIMEOUT_GRACE_MS
  );
  inFlight = pending;
  let fetched: Map<string, BlockerState[]>;
  try {
    fetched = await pending;
  } catch (err) {
    backoffUntil = Date.now() + failureBackoffMs;
    throw err;
  } finally {
    if (inFlight === pending) inFlight = null;
  }
  backoffUntil = 0;
  lastLoggedError = null; // a later recurrence is news again
  const fetchedAt = Date.now();
  for (const id of stale) {
    const blockers = fetched.get(id);
    // An id Linear did not return is unknowable, not unblocked: leave it out of the
    // snapshot (→ unavailable) and out of the cache so the next tick retries it.
    if (!blockers) {
      cache.delete(id);
      continue;
    }
    cache.set(id, { at: fetchedAt, blockers });
    snapshot.set(id, blockers);
  }
  return snapshot;
}

function defaultLinearFetcher(issueIds: string[]): Promise<Map<string, BlockerState[]>> {
  return fetchLinearBlockers(issueIds, { timeoutMs: fetchTimeoutMs });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`blocker fetch timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}

/**
 * What `admitNext()` calls: the active provider, hard-bounded in time and guaranteed not to
 * throw into the coordinator tick. Zero Linear traffic when nothing Linear-sourced is queued
 * (and none at all on a tick with no free slot — `admitNext` returns before reaching here).
 */
export async function blockerSnapshotFor(issues: Issue[]): Promise<BlockerSnapshot> {
  const tracked = issues.filter(isDependencyTracked);
  if (tracked.length === 0) return EMPTY_SNAPSHOT;
  try {
    // Backstop over the batch's own bound, so an injected provider cannot stall the tick either.
    return await withTimeout(
      (blockersProvider ?? blockersFor)(tracked),
      fetchTimeoutMs + 2 * TIMEOUT_GRACE_MS
    );
  } catch (err) {
    // The operator only ever sees the one constant reason, so the *cause* — missing API key,
    // an id Linear does not know, HTTP 500, timeout — has to reach the log or a permanent
    // misconfiguration is indistinguishable from a passing blip. Logged on change only, the
    // same discipline wait_reason uses: an outage is one line, not one per 3s tick.
    const message = err instanceof Error ? err.message : String(err);
    if (message !== lastLoggedError) {
      lastLoggedError = message;
      console.error("[coordinator] blocker fetch", err);
    }
    // Fail closed *and* park: an empty snapshot marks every Linear-sourced entry unavailable,
    // which writes a wait reason and leaves the entry `queued`. Nothing is dequeued, failed
    // or canceled, and the next successful fetch admits it with no operator action.
    return EMPTY_SNAPSHOT;
  }
}

/** Linear state types that mean "this work will never land in a form we must wait for". */
const SATISFIED_STATE_TYPES = new Set(["completed", "canceled"]);

export type BlockerVerdict = { satisfied: boolean; state: string };

/**
 * Decision 2. Resolve the blocker against `issues.external_id`:
 *
 * - **dealer-linked** → satisfied only once the dealer issue is `done`, i.e. the PR actually
 *   merged. Linear status alone is not enough; issues get marked Done at PR-approval time,
 *   before the code lands, which is precisely the doomed run this rule prevents. A ticket may
 *   hold several dealer passes (NOT-141); the live one decides, terminal ones only when none
 *   is live.
 * - **unlinked** → satisfied when the Linear state type is `completed` or `canceled`.
 *
 * Once a blocker resolves to a dealer issue, dealer status is the *only* answer — a Linear
 * `canceled` on a ticket dealer is still developing would admit the dependent onto a base
 * without that work. Canceling remains decision 6's escape hatch for a blocker dealer never
 * picked up; for one it did, the fix is to drop the `blocks` relation.
 */
export function blockerVerdict(blocker: BlockerState): BlockerVerdict {
  // NOT-141: a ticket may have several dealer passes (newest first) once a terminal one no
  // longer blocks a re-import. The *live* pass is authoritative whenever there is one: a
  // regression or follow-up pass reopened on a merged ticket is work the dependent must
  // still wait for, exactly as for a first pass. Only when every pass has ended do the
  // historical ones answer — and a merged one stays merged, so an abandoned follow-up
  // (`closed`, never landed) cannot un-satisfy a blocker whose code is already in.
  const dealerPasses = blocker.id ? listIssuesByExternalId("linear", blocker.id) : [];
  if (dealerPasses.length > 0) {
    const active = dealerPasses.find((issue) => !isTerminalIssueStatus(issue.status));
    // The dealer status is the honest answer to "why am I still waiting" — a blocker
    // sitting at `waiting on NOT-123 (Done)` reads like a bug. An active pass is never
    // `done`, so naming it is always naming the pass that still has to land.
    if (active) return { satisfied: false, state: active.status };
    const merged = dealerPasses.find((issue) => issue.status === "done");
    return { satisfied: merged != null, state: (merged ?? dealerPasses[0]).status };
  }
  return { satisfied: SATISFIED_STATE_TYPES.has(blocker.stateType), state: blocker.stateName };
}

/** `waiting on NOT-123 (In Progress)` — names every unsatisfied blocker and its state. */
export function unsatisfiedBlockerReason(blockers: BlockerState[]): string | null {
  const unsatisfied = blockers
    .map((b) => ({ blocker: b, verdict: blockerVerdict(b) }))
    .filter((x) => !x.verdict.satisfied);
  if (unsatisfied.length === 0) return null;
  return `waiting on ${unsatisfied
    .map(({ blocker, verdict }) => `${blocker.identifier} (${verdict.state})`)
    .join(", ")}`;
}

export const DEPENDENCY_STATE_UNAVAILABLE = "dependency state unavailable";
