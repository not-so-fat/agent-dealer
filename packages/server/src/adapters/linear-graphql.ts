// packages/server/src/adapters/linear-graphql.ts
//
// Shared Linear GraphQL POST helper (NOT-152): log HTTP failures with rate-limit
// headers, and surface a structured error so NOT-104 can back off until reset.
//
// NOT-159: always-on per-operation success/error counters + last rate-limit headers,
// so a burn to requests-remaining=0 is diagnosable without enabling per-call trace.

export const LINEAR_API = "https://api.linear.app/graphql";

const BODY_SNIPPET_MAX = 300;

/** Bounded default when Linear returns 429 without a usable reset / Retry-After. */
export const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000;

/** How often to emit a `[linear-usage]` summary when traffic > 0 since the last line. */
export const LINEAR_USAGE_SUMMARY_INTERVAL_MS = 60_000;

export type LinearRateLimitHeaders = {
  requestsLimit?: string;
  requestsRemaining?: string;
  requestsReset?: string;
  complexityLimit?: string;
  complexityRemaining?: string;
  complexityReset?: string;
  complexity?: string;
  retryAfter?: string;
};

export type LinearHttpErrorInit = {
  status: number;
  operation: string;
  rateLimit: LinearRateLimitHeaders;
  bodySnippet: string;
  retryAfterMs: number | null;
};

export class LinearHttpError extends Error {
  readonly status: number;
  readonly operation: string;
  readonly rateLimit: LinearRateLimitHeaders;
  readonly bodySnippet: string;
  /** ms until the rate-limit window reopens; null when not a rate-limit / unknown. */
  readonly retryAfterMs: number | null;

  constructor(init: LinearHttpErrorInit) {
    const remaining = init.rateLimit.requestsRemaining;
    const reset = init.rateLimit.requestsReset;
    const parts = [
      `Linear HTTP ${init.status}`,
      `operation=${init.operation}`,
      remaining != null ? `requests-remaining=${remaining}` : null,
      reset != null ? `requests-reset=${reset}` : null,
    ].filter(Boolean);
    super(parts.join(" "));
    this.name = "LinearHttpError";
    this.status = init.status;
    this.operation = init.operation;
    this.rateLimit = init.rateLimit;
    this.bodySnippet = init.bodySnippet;
    this.retryAfterMs = init.retryAfterMs;
  }
}

export function parseLinearRateLimitHeaders(headers: Headers): LinearRateLimitHeaders {
  const out: LinearRateLimitHeaders = {};
  const set = (key: keyof LinearRateLimitHeaders, name: string) => {
    const v = headers.get(name);
    if (v != null && v !== "") out[key] = v;
  };
  set("requestsLimit", "x-ratelimit-requests-limit");
  set("requestsRemaining", "x-ratelimit-requests-remaining");
  set("requestsReset", "x-ratelimit-requests-reset");
  set("complexityLimit", "x-ratelimit-complexity-limit");
  set("complexityRemaining", "x-ratelimit-complexity-remaining");
  set("complexityReset", "x-ratelimit-complexity-reset");
  set("complexity", "x-complexity");
  set("retryAfter", "retry-after");
  return out;
}

/**
 * How long to wait before retrying a rate-limited call.
 * Linear's `X-RateLimit-Requests-Reset` is UTC epoch **milliseconds**.
 * Prefer that reset header when present (NOT-152); Retry-After / default are fallbacks.
 */
export function computeRetryAfterMs(
  status: number,
  rateLimit: LinearRateLimitHeaders,
  nowMs = Date.now()
): number | null {
  if (status !== 429 && rateLimit.requestsRemaining !== "0") return null;

  if (rateLimit.requestsReset) {
    const resetMs = Number(rateLimit.requestsReset);
    if (Number.isFinite(resetMs) && resetMs > 0) {
      // Accept seconds-epoch (10 digits) in case a proxy rewrites the header.
      const absolute = resetMs < 1e12 ? resetMs * 1000 : resetMs;
      return Math.max(0, absolute - nowMs);
    }
  }

  if (rateLimit.retryAfter) {
    const seconds = Number(rateLimit.retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  }

  if (status === 429) return DEFAULT_RATE_LIMIT_BACKOFF_MS;
  return null;
}

export function formatLinearFailureLog(err: LinearHttpError): string {
  const rl = err.rateLimit;
  const bits = [
    `[linear] ${err.operation} failed`,
    `status=${err.status}`,
    rl.requestsRemaining != null ? `requests-remaining=${rl.requestsRemaining}` : null,
    rl.requestsReset != null ? `requests-reset=${rl.requestsReset}` : null,
    rl.requestsLimit != null ? `requests-limit=${rl.requestsLimit}` : null,
    rl.complexityRemaining != null ? `complexity-remaining=${rl.complexityRemaining}` : null,
    rl.complexityReset != null ? `complexity-reset=${rl.complexityReset}` : null,
    rl.complexity != null ? `complexity=${rl.complexity}` : null,
    err.bodySnippet ? `body=${err.bodySnippet}` : null,
  ].filter(Boolean);
  return bits.join(" ");
}

function truncateBody(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= BODY_SNIPPET_MAX) return oneLine;
  return `${oneLine.slice(0, BODY_SNIPPET_MAX)}…`;
}

function isGraphqlRateLimited(errors: unknown[]): boolean {
  return errors.some((e) => {
    if (!e || typeof e !== "object") return false;
    const ext = (e as { extensions?: { code?: unknown } }).extensions;
    return ext?.code === "RATELIMITED";
  });
}

export type LinearGraphqlRequestOpts = {
  operation: string;
  query: string;
  variables?: Record<string, unknown>;
  timeoutMs?: number;
};

// --- NOT-159: process-lifetime usage accounting ---------------------------------

export type LinearOpCounts = { ok: number; error: number };

export type LinearUsageSnapshot = {
  /** ISO time when counters started (process boot / last test reset). */
  since: string;
  totalOk: number;
  totalError: number;
  byOperation: Record<string, LinearOpCounts>;
  /** Last observed rate-limit headers from any response (success or failure). */
  lastRateLimit: LinearRateLimitHeaders | null;
  lastOperation: string | null;
  lastAt: string | null;
};

type OpBucket = { ok: number; error: number };

let usageSinceMs = Date.now();
const usageByOp = new Map<string, OpBucket>();
let lastRateLimit: LinearRateLimitHeaders | null = null;
let lastOperation: string | null = null;
let lastAtMs: number | null = null;
let usageSummaryTimer: ReturnType<typeof setInterval> | null = null;
let loggedTotalAtLastSummary = 0;

function bumpUsage(operation: string, kind: "ok" | "error", rateLimit?: LinearRateLimitHeaders): void {
  let bucket = usageByOp.get(operation);
  if (!bucket) {
    bucket = { ok: 0, error: 0 };
    usageByOp.set(operation, bucket);
  }
  bucket[kind] += 1;
  lastOperation = operation;
  lastAtMs = Date.now();
  if (rateLimit) lastRateLimit = { ...rateLimit };
  ensureUsageSummaryTimer();
}

function usageTotals(): { ok: number; error: number } {
  let ok = 0;
  let error = 0;
  for (const b of usageByOp.values()) {
    ok += b.ok;
    error += b.error;
  }
  return { ok, error };
}

/** Process-lifetime counters for every GraphQL op that went through {@link linearGraphqlRequest}. */
export function getLinearUsageSnapshot(): LinearUsageSnapshot {
  const byOperation: Record<string, LinearOpCounts> = {};
  for (const [op, b] of [...usageByOp.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    byOperation[op] = { ok: b.ok, error: b.error };
  }
  const totals = usageTotals();
  return {
    since: new Date(usageSinceMs).toISOString(),
    totalOk: totals.ok,
    totalError: totals.error,
    byOperation,
    lastRateLimit: lastRateLimit ? { ...lastRateLimit } : null,
    lastOperation,
    lastAt: lastAtMs != null ? new Date(lastAtMs).toISOString() : null,
  };
}

export function resetLinearUsageForTests(): void {
  usageByOp.clear();
  lastRateLimit = null;
  lastOperation = null;
  lastAtMs = null;
  usageSinceMs = Date.now();
  loggedTotalAtLastSummary = 0;
  stopLinearUsageSummary();
}

function formatUsageSummaryLine(): string {
  const snap = getLinearUsageSnapshot();
  const parts = Object.entries(snap.byOperation).map(
    ([op, c]) => `${op}:${c.ok}/${c.error}`
  );
  const rl = snap.lastRateLimit;
  const bits = [
    "[linear-usage]",
    `ok=${snap.totalOk}`,
    `error=${snap.totalError}`,
    parts.length ? `ops=${parts.join(",")}` : null,
    rl?.requestsRemaining != null ? `requests-remaining=${rl.requestsRemaining}` : null,
    rl?.requestsLimit != null ? `requests-limit=${rl.requestsLimit}` : null,
    rl?.requestsReset != null ? `requests-reset=${rl.requestsReset}` : null,
    snap.lastOperation ? `last=${snap.lastOperation}` : null,
  ].filter(Boolean);
  return bits.join(" ");
}

function maybeLogUsageSummary(): void {
  const totals = usageTotals();
  const total = totals.ok + totals.error;
  if (total <= loggedTotalAtLastSummary) return;
  loggedTotalAtLastSummary = total;
  console.error(formatUsageSummaryLine());
}

function ensureUsageSummaryTimer(): void {
  if (usageSummaryTimer) return;
  usageSummaryTimer = setInterval(maybeLogUsageSummary, LINEAR_USAGE_SUMMARY_INTERVAL_MS);
  // Do not keep the process alive solely for the summary ticker.
  if (typeof usageSummaryTimer === "object" && "unref" in usageSummaryTimer) {
    usageSummaryTimer.unref();
  }
}

/** Start the once-per-minute summary logger (idempotent). Called from server boot. */
export function startLinearUsageSummary(): void {
  ensureUsageSummaryTimer();
}

export function stopLinearUsageSummary(): void {
  if (!usageSummaryTimer) return;
  clearInterval(usageSummaryTimer);
  usageSummaryTimer = null;
}

/** Set `AGENT_DEALER_LINEAR_TRACE=1` to log every GraphQL call (success + failure). */
function linearTraceEnabled(): boolean {
  const v = process.env.AGENT_DEALER_LINEAR_TRACE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

let linearTraceSeq = 0;

function logLinearTrace(operation: string, status: number, rateLimit: LinearRateLimitHeaders): void {
  if (!linearTraceEnabled()) return;
  linearTraceSeq += 1;
  const bits = [
    `[linear-trace] #${linearTraceSeq}`,
    `operation=${operation}`,
    `status=${status}`,
    rateLimit.requestsRemaining != null ? `requests-remaining=${rateLimit.requestsRemaining}` : null,
    rateLimit.requestsLimit != null ? `requests-limit=${rateLimit.requestsLimit}` : null,
    rateLimit.complexityRemaining != null
      ? `complexity-remaining=${rateLimit.complexityRemaining}`
      : null,
  ].filter(Boolean);
  console.error(bits.join(" "));
}

/**
 * POST to Linear GraphQL. On non-OK HTTP (and GraphQL RATELIMITED), logs once and throws
 * {@link LinearHttpError}. Callers keep their own catch for user-facing 502s.
 */
export async function linearGraphqlRequest(opts: LinearGraphqlRequestOpts): Promise<unknown> {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new Error("LINEAR_API_KEY not set");

  let res: Response;
  try {
    res = await fetch(LINEAR_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify({ query: opts.query, variables: opts.variables }),
      ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
    });
  } catch (err) {
    bumpUsage(opts.operation, "error");
    throw err;
  }

  const rateLimit = parseLinearRateLimitHeaders(
    res.headers instanceof Headers ? res.headers : new Headers()
  );
  logLinearTrace(opts.operation, res.status, rateLimit);
  const rawBody =
    typeof res.text === "function"
      ? await res.text()
      : JSON.stringify(await (res as { json: () => Promise<unknown> }).json());
  const bodySnippet = truncateBody(rawBody);

  if (!res.ok) {
    bumpUsage(opts.operation, "error", rateLimit);
    const err = new LinearHttpError({
      status: res.status,
      operation: opts.operation,
      rateLimit,
      bodySnippet,
      retryAfterMs: computeRetryAfterMs(res.status, rateLimit),
    });
    console.error(formatLinearFailureLog(err));
    throw err;
  }

  let json: { data?: unknown; errors?: unknown[] };
  try {
    json = JSON.parse(rawBody) as { data?: unknown; errors?: unknown[] };
  } catch {
    bumpUsage(opts.operation, "error", rateLimit);
    const err = new LinearHttpError({
      status: res.status,
      operation: opts.operation,
      rateLimit,
      bodySnippet,
      retryAfterMs: null,
    });
    console.error(formatLinearFailureLog(err));
    throw new Error(`Linear GraphQL returned non-JSON for ${opts.operation}`);
  }

  if (json.errors?.length) {
    if (isGraphqlRateLimited(json.errors) || rateLimit.requestsRemaining === "0") {
      bumpUsage(opts.operation, "error", rateLimit);
      const err = new LinearHttpError({
        status: 429,
        operation: opts.operation,
        rateLimit,
        bodySnippet,
        retryAfterMs: computeRetryAfterMs(429, rateLimit),
      });
      console.error(formatLinearFailureLog(err));
      throw err;
    }
    bumpUsage(opts.operation, "error", rateLimit);
    throw new Error(JSON.stringify(json.errors));
  }

  bumpUsage(opts.operation, "ok", rateLimit);
  return json.data;
}
