// packages/server/src/adapters/linear-graphql.ts
//
// Shared Linear GraphQL POST helper (NOT-152): log HTTP failures with rate-limit
// headers, and surface a structured error so NOT-104 can back off until reset.

export const LINEAR_API = "https://api.linear.app/graphql";

const BODY_SNIPPET_MAX = 300;

/** Bounded default when Linear returns 429 without a usable reset / Retry-After. */
export const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000;

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
 */
export function computeRetryAfterMs(
  status: number,
  rateLimit: LinearRateLimitHeaders,
  nowMs = Date.now()
): number | null {
  if (status !== 429 && rateLimit.requestsRemaining !== "0") return null;

  if (rateLimit.retryAfter) {
    const seconds = Number(rateLimit.retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  }

  if (rateLimit.requestsReset) {
    const resetMs = Number(rateLimit.requestsReset);
    if (Number.isFinite(resetMs) && resetMs > 0) {
      // Accept seconds-epoch (10 digits) in case a proxy rewrites the header.
      const absolute = resetMs < 1e12 ? resetMs * 1000 : resetMs;
      return Math.max(0, absolute - nowMs);
    }
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

/**
 * POST to Linear GraphQL. On non-OK HTTP (and GraphQL RATELIMITED), logs once and throws
 * {@link LinearHttpError}. Callers keep their own catch for user-facing 502s.
 */
export async function linearGraphqlRequest(opts: LinearGraphqlRequestOpts): Promise<unknown> {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new Error("LINEAR_API_KEY not set");

  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: key },
    body: JSON.stringify({ query: opts.query, variables: opts.variables }),
    ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
  });

  const rateLimit = parseLinearRateLimitHeaders(
    res.headers instanceof Headers ? res.headers : new Headers()
  );
  const rawBody =
    typeof res.text === "function"
      ? await res.text()
      : JSON.stringify(await (res as { json: () => Promise<unknown> }).json());
  const bodySnippet = truncateBody(rawBody);

  if (!res.ok) {
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
    throw new Error(JSON.stringify(json.errors));
  }

  return json.data;
}
