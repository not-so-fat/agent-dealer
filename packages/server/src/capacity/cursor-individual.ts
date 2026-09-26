// packages/server/src/capacity/cursor-individual.ts
//
// NOT-250: Cursor Individual capacity over an opt-in EXPERIMENTAL dashboard
// adapter.
//
// Cursor documents monthly individual usage and exposes it in the Spending
// dashboard, but the supported CLI exposes no usage surface. Community tools
// commonly call authenticated dashboard endpoints (usage-summary /
// current-period routes) using the existing local Cursor login. Those
// endpoints and credential formats are NOT a supported public contract and
// may change without notice — so this adapter is:
//
// - DISABLED BY DEFAULT behind the explicit opt-in
//   `AGENT_DEALER_CURSOR_INDIVIDUAL_CAPACITY=experimental`. Any other value
//   (including unset) short-circuits BEFORE any credential file is read and
//   before any HTTP is attempted, and serves `enabled: false` N/A.
// - Labeled `experimental_api` everywhere it surfaces (API source,
//   diagnostics, UI badge, docs).
// - Minimal-credential: the raw token lives only in one in-memory auth
//   header for the single dashboard call. It is never persisted (see
//   repository/cursor-individual-billing.ts), never returned to the browser,
//   and never logged — tests pin all three.
// - Bounded: strict origin/path allowlisting, manual redirect handling that
//   rejects unknown origins, per-request timeout, response-size cap, and
//   response-schema validation. A broken endpoint degrades to N/A with an
//   explicit reason; it never throws out of read(), never touches
//   `runtime_availability` (NOT-111 health), and never breaks job execution.
// - Forward-compatible: `supportedReader` is checked FIRST — if Cursor ships
//   a supported Individual usage surface, wiring its reader as the default
//   below makes the dashboard path the fallback automatically, with no
//   operator action and no opt-in change.
//
// Billing-cycle values only (label/start/end, reported usage, remaining
// percent): no 5H/1W-style windows are invented from monthly data, and money
// is never rendered as a token percentage.

import type {
  CapacityUnavailableReason,
  CursorIndividualBilling,
  Runtime,
} from "@agent-dealer/shared";
import { remainingPercentFromFraction, remainingPercentFromUsedPercent } from "@agent-dealer/shared";
import { DEFAULT_EXPIRES_AFTER_MS, DEFAULT_STALE_AFTER_MS } from "./adapter.js";
import {
  cursorIndividualCredentialStatus,
  loadCursorIndividualCredential,
  type CursorIndividualCredential,
  type ReadFileImpl,
} from "./cursor-individual-credentials.js";
import { normalizeCursorApiDate } from "./cursor-team.js";

export const CURSOR_INDIVIDUAL_RUNTIME: Runtime = "cursor_local";

/** Explicit opt-in env: the ONLY value that enables the dashboard read. */
export const CURSOR_INDIVIDUAL_OPT_IN_ENV = "AGENT_DEALER_CURSOR_INDIVIDUAL_CAPACITY";

/** The opt-in value. Anything else (including unset) means disabled. */
export const CURSOR_INDIVIDUAL_OPT_IN_VALUE = "experimental";

/** Base URL override for tests (mock HTTP servers). Never set in production. */
export const CURSOR_INDIVIDUAL_BASE_URL_ENV = "CURSOR_INDIVIDUAL_API_BASE_URL";

/** Per-request timeout override (mirrors the Team adapter). */
export const CURSOR_INDIVIDUAL_TIMEOUT_ENV = "AGENT_DEALER_CURSOR_INDIVIDUAL_TIMEOUT_MS";

/** Opt-out for the on-demand stale refresh (mirrors the Team/Codex adapters). */
export const CURSOR_INDIVIDUAL_REFRESH_ENV = "AGENT_DEALER_CURSOR_INDIVIDUAL_REFRESH";

/**
 * Undocumented dashboard origins the adapter may talk to. `www.cursor.com`
 * canonicalizes to `cursor.com` (a same-site redirect), so the bare domain
 * must be allowlisted too or that redirect itself reads `unsafe-redirect`.
 * Community tools target the Cursor web dashboard for these routes; the
 * allowlist is exactly these origins — redirects or config pointing
 * anywhere else are rejected before any credential is sent.
 */
export const CURSOR_INDIVIDUAL_ALLOWED_ORIGINS = [
  "https://cursor.com",
  "https://www.cursor.com",
  "https://api.cursor.com",
] as const;

/** Default dashboard origin (community-observed; undocumented, may drift). */
export const CURSOR_INDIVIDUAL_DEFAULT_ORIGIN = "https://cursor.com";

/**
 * Candidate dashboard usage routes, tried in order. The first 2xx carrying
 * a usable billing value wins; a 404 moves to the next candidate (endpoint
 * drift); auth/transport failures dominate immediately. Both entries name
 * the community-observed usage-summary/current-period shape from the brief —
 * neither is a supported contract.
 */
export const CURSOR_INDIVIDUAL_USAGE_PATHS = [
  "/api/usage-summary/current-period",
  "/api/usage-summary",
] as const;

/** Cap on a dashboard response body (larger bodies read `malformed`). */
export const CURSOR_INDIVIDUAL_MAX_BODY_BYTES = 512 * 1024;

/** Redirect hops followed per read before giving up (allowlisted origins only). */
export const CURSOR_INDIVIDUAL_MAX_REDIRECTS = 3;

/**
 * Cooldown after a failed poll before `refreshCursorIndividualBillingIfStale()`
 * polls again (mirrors the Team adapter's 429/5xx backoff).
 */
export const CURSOR_INDIVIDUAL_FAILURE_BACKOFF_MS = 60_000;

/** Server-side evidence pointers only — never credentials or raw payloads. */
export const CURSOR_INDIVIDUAL_EVIDENCE = "cursor-dashboard:usage-summary/current-period";

/** The billing-cycle window identity in `runtime_capacity_snapshots`. */
export const CURSOR_INDIVIDUAL_WINDOW_KEY = "billing_cycle";
export const CURSOR_INDIVIDUAL_PROVIDER_BUCKET = "individual";
export const CURSOR_INDIVIDUAL_PROVIDER_LABEL = "billing cycle";

/** True only with the explicit experimental opt-in. No silent opt-in, ever. */
export function isCursorIndividualExperimentalEnabled(): boolean {
  return process.env[CURSOR_INDIVIDUAL_OPT_IN_ENV] === CURSOR_INDIVIDUAL_OPT_IN_VALUE;
}

export function cursorIndividualBaseUrl(): string {
  const raw = process.env[CURSOR_INDIVIDUAL_BASE_URL_ENV]?.trim();
  const base = raw ? raw : CURSOR_INDIVIDUAL_DEFAULT_ORIGIN;
  return base.replace(/\/+$/, "");
}

/** Per-request timeout (each dashboard fetch gets this budget). */
export function cursorIndividualTimeoutMs(): number {
  const raw = process.env[CURSOR_INDIVIDUAL_TIMEOUT_ENV];
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 10_000;
}

type FailureKind =
  | "disabled"
  | "absent-credential"
  | "bad-credential"
  | "unavailable"
  | "forbidden"
  | "rate-limited"
  | "unsafe-redirect"
  | "malformed";

/**
 * Operator-safe failure log: the static kind only, never tokens or payloads.
 * A rejected login (401/403) means the local Cursor session the adapter
 * borrowed is expired or revoked — the operator must refresh the Cursor
 * login itself (desktop app or `cursor agent login`); Dealer never mutates
 * Cursor auth, so the hint is static text, not a credential action.
 */
function logFailure(kind: FailureKind): void {
  const hint =
    kind === "forbidden" ? " (refresh the Cursor login and retry — Dealer never touches Cursor auth)" : "";
  console.error(`[cursor-individual-capacity] dashboard read failed: ${kind}${hint}`);
}

export interface CursorIndividualFetchResponse {
  status: number;
  headers: Record<string, string>;
  text(): Promise<string>;
}

export type FetchImpl = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal }
) => Promise<CursorIndividualFetchResponse>;

/**
 * A supported Cursor usage surface, preferred over the dashboard whenever
 * one is available. No supported Individual usage API exists as of NOT-250,
 * so the default reader below returns null (dashboard path). When Cursor
 * ships one, wire its reader as the default here: the dashboard is then
 * skipped automatically — no credential is read, no dashboard endpoint is
 * touched — and observations source as `supported_protocol`.
 */
export interface SupportedIndividualUsage {
  cycleLabel?: string | null;
  cycleStart?: string | null;
  cycleEnd?: string | null;
  usageValue?: number | null;
  usageUnit?: string | null;
  usedPercent?: number | null;
  usedFraction?: number | null;
  remainingPercent?: number | null;
  remainingFraction?: number | null;
}

export type SupportedUsageReader = () => SupportedIndividualUsage | null | Promise<SupportedIndividualUsage | null>;

/** Default reader: no supported surface exists yet — always null. */
export function defaultSupportedUsageReader(): SupportedIndividualUsage | null {
  return null;
}

export interface CursorIndividualReadOptions {
  nowMs?: number;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
  /** Credential loader override (tests inject fixture loaders; default reads the local login). */
  loadCredential?: () => CursorIndividualCredential;
  readFile?: ReadFileImpl;
  /** Preferred supported-surface reader (checked before the dashboard). */
  supportedReader?: SupportedUsageReader;
}

export interface CursorIndividualObservation {
  /** Normalized billing values (nulls when the dashboard did not report them). */
  billing: Omit<CursorIndividualBilling, "enabled" | "configured" | "generatedAt">;
  enabled: boolean;
  configured: boolean;
  /** True when the values came from a supported surface, not the dashboard. */
  viaSupportedApi: boolean;
  failure: { kind: FailureKind } | null;
  evidenceRef: string | null;
}

// ---------------------------------------------------------------------------
// Undocumented-shape parsing: only the fields below are recognized —
// billing-cycle label/start/end, a reported usage value/unit, and a usable
// remaining/used scale. Anything else yields nulls (the caller maps "no
// usable value" to `unparsable`), never guesses. In particular: no durations
// are invented (monthly data never becomes a 5H/1W window) and no cycle
// label is synthesized when the dashboard reports none.
// ---------------------------------------------------------------------------

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const n = asFiniteNumber(obj[k]);
    if (n !== null) return n;
  }
  return null;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function pickRaw(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return null;
}

const CYCLE_LABEL_KEYS = [
  "cycleLabel",
  "cycle_label",
  "billingPeriod",
  "billing_period",
  "period",
  "periodLabel",
  "period_label",
  "month",
];
const CYCLE_START_KEYS = [
  "cycleStart",
  "cycle_start",
  "billingCycleStart",
  "billing_cycle_start",
  "periodStart",
  "period_start",
  "startDate",
  "start_date",
  "currentPeriodStart",
  "current_period_start",
];
const CYCLE_END_KEYS = [
  "cycleEnd",
  "cycle_end",
  "billingCycleEnd",
  "billing_cycle_end",
  "periodEnd",
  "period_end",
  "endDate",
  "end_date",
  "resetAt",
  "reset_at",
  "resetDate",
  "reset_date",
  "currentPeriodEnd",
  "current_period_end",
];
const USAGE_VALUE_KEYS = [
  "usageValue",
  "usage_value",
  "usage",
  "used",
  "spent",
  "totalUsage",
  "total_usage",
  "spendValue",
  "spend_value",
  "costInCents",
  "cost_in_cents",
];
const USAGE_UNIT_KEYS = ["usageUnit", "usage_unit", "unit", "currency"];
const USED_PERCENT_KEYS = [
  "usedPercent",
  "used_percent",
  "usagePercent",
  "usage_percent",
  "totalPercentUsed",
  "total_percent_used",
];
// NOTE (NOT-267): `apiPercentUsed` is deliberately NOT listed anywhere here.
// The live payload reports per-pool scales (e.g. an API-model pool) next to
// the account-total `individualUsage.plan.totalPercentUsed` — substituting a
// pool scale for the account total would misreport personal capacity, so a
// payload carrying ONLY a pool scale reads as no usable scale (unparsable),
// never as the account total.
const USED_FRACTION_KEYS = ["usedFraction", "used_fraction", "usageFraction", "usage_fraction"];
const REMAINING_PERCENT_KEYS = [
  "remainingPercent",
  "remaining_percent",
  "percentRemaining",
  "percent_remaining",
];
const REMAINING_FRACTION_KEYS = ["remainingFraction", "remaining_fraction"];
/**
 * Last-resort scale: the plan's explicit used-vs-limit pair (e.g. spend vs
 * budget), read ONLY when no percent/fraction/remaining scale is present.
 * Money-vs-money and count-vs-count both reduce to the same share — but
 * this never mixes with the percent scales above, and never with a pool
 * scale: only the merged plan/top-level pair counts.
 */
const USED_AMOUNT_KEYS = [
  "used",
  "usage",
  "usedCredits",
  "used_credits",
  "consumed",
  "consumedCredits",
  "consumed_credits",
];
const LIMIT_AMOUNT_KEYS = [
  "limit",
  "quota",
  "allowance",
  "totalLimit",
  "total_limit",
  "limitValue",
  "limit_value",
  "monthlyLimit",
  "monthly_limit",
];

export interface CursorIndividualReadings {
  cycleLabel: string | null;
  cycleStart: string | null;
  cycleEnd: string | null;
  usageValue: number | null;
  usageUnit: string | null;
  remainingPercent: number | null;
}

function clampPercent(n: number): number {
  return Math.min(100, Math.max(0, n));
}

/**
 * Normalize one dashboard usage-summary payload. Returns null when the
 * payload is not an object at all, or when it carries no usable billing
 * value (no cycle label/start/end AND no usage/remaining scale) — the caller
 * maps that to `unparsable`.
 */
function individualUsagePlan(p: Record<string, unknown>): Record<string, unknown> | null {
  const usage = p.individualUsage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const plan = (usage as Record<string, unknown>).plan;
  return plan && typeof plan === "object" && !Array.isArray(plan) ? (plan as Record<string, unknown>) : null;
}

export function cursorIndividualPayloadToReadings(payload: unknown): CursorIndividualReadings | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const top = payload as Record<string, unknown>;
  // The live payload nests its usage scale under `individualUsage.plan`
  // (e.g. `totalPercentUsed`) while the cycle dates stay top-level — merge
  // the plan in (top-level wins on a name clash) so both shapes read the
  // same fields below.
  const plan = individualUsagePlan(top);
  const p = plan ? { ...plan, ...top } : top;
  const cycleLabel = pickString(p, CYCLE_LABEL_KEYS);
  const cycleStart = normalizeCursorApiDate(pickRaw(p, CYCLE_START_KEYS));
  const cycleEnd = normalizeCursorApiDate(pickRaw(p, CYCLE_END_KEYS));
  const usageValue = pickNumber(p, USAGE_VALUE_KEYS);
  const usageUnit = pickString(p, USAGE_UNIT_KEYS);
  let remainingPercent: number | null = null;
  const usedPercent = pickNumber(p, USED_PERCENT_KEYS);
  const usedFraction = pickNumber(p, USED_FRACTION_KEYS);
  const remainingDirect = pickNumber(p, REMAINING_PERCENT_KEYS);
  const remainingFraction = pickNumber(p, REMAINING_FRACTION_KEYS);
  if (usedPercent !== null) {
    remainingPercent = remainingPercentFromUsedPercent(usedPercent);
  } else if (usedFraction !== null) {
    remainingPercent = remainingPercentFromFraction(usedFraction);
  } else if (remainingDirect !== null) {
    remainingPercent = clampPercent(remainingDirect);
  } else if (remainingFraction !== null) {
    remainingPercent = clampPercent(remainingFraction * 100);
  } else {
    // Last resort: the plan's explicit used/limit pair. A non-positive
    // limit (or a negative used amount) is not a scale — it reads as no
    // usable value, never a division artifact.
    const usedAmount = pickNumber(p, USED_AMOUNT_KEYS);
    const limitAmount = pickNumber(p, LIMIT_AMOUNT_KEYS);
    if (usedAmount !== null && limitAmount !== null && limitAmount > 0 && usedAmount >= 0) {
      remainingPercent = clampPercent(100 - (usedAmount / limitAmount) * 100);
    }
  }
  const hasCycle = cycleLabel !== null || cycleStart !== null || cycleEnd !== null;
  const hasUsage = usageValue !== null || remainingPercent !== null;
  if (!hasCycle && !hasUsage) return null;
  return { cycleLabel, cycleStart, cycleEnd, usageValue, usageUnit, remainingPercent };
}

// ---------------------------------------------------------------------------
// Bounded HTTP read (injectable fetch so tests never touch the live dashboard)
// ---------------------------------------------------------------------------

function isAllowedOrigin(url: string): boolean {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  return (CURSOR_INDIVIDUAL_ALLOWED_ORIGINS as readonly string[]).includes(origin);
}

/**
 * Read a response body up to `CURSOR_INDIVIDUAL_MAX_BODY_BYTES`, aborting
 * the read (never buffering the full body first) the moment that cap is
 * crossed — `res.text()` has no such bound, so a large/streaming response
 * would otherwise sit fully in memory before the size check ever ran.
 * Shares the caller's `signal`, so a hop's timeout aborts a stalled body
 * read the same way it aborts a stalled header response.
 */
export async function readBoundedText(res: Response, signal: AbortSignal): Promise<string> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new Error("aborted");
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > CURSOR_INDIVIDUAL_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("response exceeds the size cap");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

function defaultFetch(): FetchImpl {
  const impl = globalThis.fetch;
  return (url, init) =>
    (impl as typeof fetch)(url, { ...init, redirect: "manual" } as RequestInit).then((res) => {
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return { status: res.status, headers, text: () => readBoundedText(res, init.signal) };
    });
}

type FetchOutcome =
  | { status: number; payload: unknown }
  | { failure: FailureKind }
  | { absent: true };

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * One bounded GET with manual redirect handling: redirects are followed only
 * to allowlisted https origins (up to CURSOR_INDIVIDUAL_MAX_REDIRECTS hops).
 * A redirect to an unknown origin — or a Location that does not parse —
 * fails as `unsafe-redirect` BEFORE any further request, so the credential
 * never travels off the allowlist.
 */
async function fetchJson(
  fetchImpl: FetchImpl,
  url: string,
  authHeader: string,
  timeoutMs: number
): Promise<FetchOutcome> {
  if (!isAllowedOrigin(url)) return { failure: "unsafe-redirect" };
  let current = url;
  for (let hop = 0; hop <= CURSOR_INDIVIDUAL_MAX_REDIRECTS; hop += 1) {
    const controller = new AbortController();
    // A manual, ref'd setTimeout (not AbortSignal.timeout(), whose internal
    // timer is unref'd) — otherwise, once nothing else in the process holds
    // the event loop open, Node can conclude the run before this timer ever
    // fires, surfacing as "Promise resolution is still pending but the event
    // loop has already resolved" instead of an actual abort. The timer stays
    // live for the WHOLE hop (headers + body read below), cleared only once
    // this hop is fully settled — a server that sends headers and then
    // stalls the body must abort too, not just a slow header response.
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res: CursorIndividualFetchResponse;
      try {
        res = await fetchImpl(current, {
          method: "GET",
          headers: { Cookie: authHeader, Accept: "application/json" },
          signal: controller.signal,
        });
      } catch {
        return { failure: "unavailable" };
      }
      if (isRedirect(res.status)) {
        const location = res.headers["location"];
        if (!location) return { failure: "unavailable" };
        let next: string;
        try {
          next = new URL(location, current).toString();
        } catch {
          return { failure: "unsafe-redirect" };
        }
        if (!next.toLowerCase().startsWith("https://") || !isAllowedOrigin(next)) {
          return { failure: "unsafe-redirect" };
        }
        current = next;
        continue;
      }
      if (res.status === 401 || res.status === 403) return { failure: "forbidden" };
      if (res.status === 429) return { failure: "rate-limited" };
      // 404 on an undocumented path means the endpoint moved or never existed
      // for this account — the caller tries the next candidate path.
      if (res.status === 404 || res.status === 405) return { absent: true };
      if (res.status < 200 || res.status >= 300) return { failure: "unavailable" };
      let text: string;
      try {
        text = await res.text();
      } catch {
        // An abort mid-body-read is a timeout (`unavailable`), never a parse
        // verdict on data that never fully arrived.
        return { failure: controller.signal.aborted ? "unavailable" : "malformed" };
      }
      if (text.length > CURSOR_INDIVIDUAL_MAX_BODY_BYTES) return { failure: "malformed" };
      try {
        return { status: res.status, payload: JSON.parse(text) as unknown };
      } catch {
        return { failure: "malformed" };
      }
    } finally {
      clearTimeout(timer);
    }
  }
  return { failure: "unavailable" };
}

function emptyBilling(observedAt: string): CursorIndividualObservation["billing"] {
  return {
    cycleLabel: null,
    cycleStart: null,
    cycleEnd: null,
    usageValue: null,
    usageUnit: null,
    remainingPercent: null,
    source: "unavailable",
    unavailableReason: "missing",
    observedAt,
  };
}

function readingsToBilling(
  readings: CursorIndividualReadings,
  observedAt: string,
  viaSupportedApi: boolean
): CursorIndividualObservation["billing"] {
  return {
    cycleLabel: readings.cycleLabel,
    cycleStart: readings.cycleStart,
    cycleEnd: readings.cycleEnd,
    usageValue: readings.usageValue,
    usageUnit: readings.usageUnit,
    remainingPercent: readings.remainingPercent,
    source: viaSupportedApi ? "supported_protocol" : "experimental_api",
    unavailableReason: null,
    observedAt,
  };
}

function supportedToReadings(supported: SupportedIndividualUsage): CursorIndividualReadings | null {
  const normalized: Record<string, unknown> = {
    cycleLabel: supported.cycleLabel ?? null,
    cycleStart: supported.cycleStart ?? null,
    cycleEnd: supported.cycleEnd ?? null,
    usageValue: supported.usageValue ?? null,
    usageUnit: supported.usageUnit ?? null,
  };
  if (supported.usedPercent !== undefined && supported.usedPercent !== null) {
    normalized.usedPercent = supported.usedPercent;
  } else if (supported.usedFraction !== undefined && supported.usedFraction !== null) {
    normalized.usedFraction = supported.usedFraction;
  } else if (supported.remainingPercent !== undefined && supported.remainingPercent !== null) {
    normalized.remainingPercent = supported.remainingPercent;
  } else if (supported.remainingFraction !== undefined && supported.remainingFraction !== null) {
    normalized.remainingFraction = supported.remainingFraction;
  }
  return cursorIndividualPayloadToReadings(normalized);
}

/**
 * One bounded experimental dashboard read. Never throws for provider-side
 * outcomes — those come back as `failure.kind` — never touches
 * `runtime_availability`, and never exposes the credential: the auth header
 * value stays in this function's scope and never appears in the observation,
 * logs, or evidence refs.
 *
 * Order: explicit opt-in → supported surface (preferred, skips the
 * dashboard entirely) → local credential → allowlisted dashboard GETs.
 */
export async function readCursorIndividualBilling(
  opts: CursorIndividualReadOptions = {}
): Promise<CursorIndividualObservation> {
  const nowMs = opts.nowMs ?? Date.now();
  const observedAt = new Date(nowMs).toISOString();
  if (!isCursorIndividualExperimentalEnabled()) {
    return {
      billing: emptyBilling(observedAt),
      enabled: false,
      configured: false,
      viaSupportedApi: false,
      failure: { kind: "disabled" },
      evidenceRef: null,
    };
  }
  const supportedReader = opts.supportedReader ?? defaultSupportedUsageReader;
  let supported: SupportedIndividualUsage | null = null;
  try {
    supported = await supportedReader();
  } catch {
    supported = null;
  }
  if (supported) {
    const readings = supportedToReadings(supported);
    if (readings) {
      return {
        billing: readingsToBilling(readings, observedAt, true),
        enabled: true,
        configured: true,
        viaSupportedApi: true,
        failure: null,
        evidenceRef: null,
      };
    }
    // A supported surface answered but carried nothing usable: fall through
    // to the dashboard rather than discarding the read.
  }
  const loadCredential = opts.loadCredential ?? (() => loadCursorIndividualCredential(opts.readFile));
  const credential = loadCredential();
  if (credential.status === "absent") {
    logFailure("absent-credential");
    return {
      billing: emptyBilling(observedAt),
      enabled: true,
      configured: false,
      viaSupportedApi: false,
      failure: { kind: "absent-credential" },
      evidenceRef: null,
    };
  }
  if (credential.status === "unparsable" || !credential.authHeader) {
    logFailure("bad-credential");
    return {
      billing: { ...emptyBilling(observedAt), unavailableReason: "unparsable" },
      enabled: true,
      configured: false,
      viaSupportedApi: false,
      failure: { kind: "bad-credential" },
      evidenceRef: null,
    };
  }
  const baseUrl = (opts.baseUrl ?? cursorIndividualBaseUrl()).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? cursorIndividualTimeoutMs();
  const fetchImpl = opts.fetchImpl ?? defaultFetch();
  const authHeader = credential.authHeader;

  let fatal: FailureKind | null = null;
  let readings: CursorIndividualReadings | null = null;
  // A 200 response this module cannot parse as JSON (`malformed`) is kept
  // distinct from a genuine auth/rate-limit/transport/redirect failure: an
  // undocumented path can serve an HTML SPA shell with a 200 status instead
  // of a 404 for an account it doesn't apply to, so `malformed` is treated
  // like `absent` and the next candidate still gets a try. The first such
  // verdict is remembered as the diagnostic in case no candidate parses.
  let malformedFallback: FailureKind | null = null;
  for (const candidatePath of CURSOR_INDIVIDUAL_USAGE_PATHS) {
    const outcome = await fetchJson(fetchImpl, `${baseUrl}${candidatePath}`, authHeader, timeoutMs);
    if ("failure" in outcome) {
      if (outcome.failure === "malformed") {
        malformedFallback = malformedFallback ?? outcome.failure;
        continue;
      }
      // Auth, rate-limit, transport, redirect, and oversize failures dominate
      // over remaining candidates: retrying another undocumented path cannot
      // fix a rejected credential or an unsafe redirect.
      fatal = outcome.failure;
      break;
    }
    if ("absent" in outcome) continue;
    const parsed = cursorIndividualPayloadToReadings(outcome.payload);
    if (parsed === null) {
      fatal = "malformed";
      break;
    }
    readings = parsed;
    break;
  }
  if (!fatal && !readings) fatal = malformedFallback;
  if (fatal) {
    logFailure(fatal);
    const reason: CapacityUnavailableReason = fatal === "malformed" ? "unparsable" : "missing";
    return {
      billing: { ...emptyBilling(observedAt), unavailableReason: reason },
      enabled: true,
      configured: true,
      viaSupportedApi: false,
      failure: { kind: fatal },
      evidenceRef: null,
    };
  }
  if (readings === null) {
    // Every candidate path 404/405'd (or nothing answered): the undocumented
    // endpoint drifted or never existed for this account — `missing`, never
    // a parse verdict on data that never arrived.
    logFailure("unavailable");
    return {
      billing: emptyBilling(observedAt),
      enabled: true,
      configured: true,
      viaSupportedApi: false,
      failure: { kind: "unavailable" },
      evidenceRef: null,
    };
  }
  return {
    billing: readingsToBilling(readings, observedAt, false),
    enabled: true,
    configured: true,
    viaSupportedApi: false,
    failure: null,
    evidenceRef: CURSOR_INDIVIDUAL_EVIDENCE,
  };
}

/**
 * Failure kind → stored N/A reason (shared enum only). Transport/auth/
 * rate-limit/redirect failures record `missing` (supported-shaped N/A, no
 * snapshot without stored data); malformed payloads and unreadable
 * credentials record `unparsable`. Disabled and absent-credential never
 * reach storage — they short-circuit at serve time.
 */
export function cursorIndividualFailureReason(kind: FailureKind): CapacityUnavailableReason {
  return kind === "malformed" || kind === "bad-credential" ? "unparsable" : "missing";
}

// ---------------------------------------------------------------------------
// Normalized snapshot persistence + bounded refresh (shared capacity pattern)
// ---------------------------------------------------------------------------

export interface CursorIndividualStoredSnapshot {
  cycleLabel: string | null;
  cycleStart: string | null;
  cycleEnd: string | null;
  usageValue: number | null;
  usageUnit: string | null;
  remainingPercent: number | null;
  source: CursorIndividualObservation["billing"]["source"];
  unavailableReason: CapacityUnavailableReason | null;
  observedAt: string;
  freshUntil: string | null;
  expiresAt: string | null;
  evidenceRef: string | null;
}

/**
 * Persist one observation as the normalized individual snapshot. Transient
 * failures do NOT overwrite a stored snapshot — the last-known values keep
 * serving under read-time freshness instead. Successful and malformed
 * observations do overwrite (malformed is the current verdict on arrived
 * data). Disabled/absent-credential observations persist nothing. Imported
 * lazily to keep this module free of DB binds.
 */
export async function ingestCursorIndividualObservation(
  observation: CursorIndividualObservation,
  nowMs = Date.now()
): Promise<void> {
  if (!observation.enabled) return;
  if (
    observation.failure &&
    observation.failure.kind !== "malformed" &&
    observation.failure.kind !== "bad-credential"
  ) {
    return;
  }
  const { writeCursorIndividualBillingRow } = await import(
    "../repository/cursor-individual-billing.js"
  );
  const b = observation.billing;
  const observedAt = b.observedAt ?? new Date(nowMs).toISOString();
  const observedMs = Date.parse(observedAt);
  const base = Number.isFinite(observedMs) ? observedMs : nowMs;
  const unavailable = observation.failure !== null;
  writeCursorIndividualBillingRow({
    cycleLabel: b.cycleLabel,
    cycleStart: b.cycleStart,
    cycleEnd: b.cycleEnd,
    usageValue: b.usageValue,
    usageUnit: b.usageUnit,
    remainingPercent: b.remainingPercent,
    source: b.source,
    unavailableReason: b.unavailableReason,
    observedAt,
    freshUntil: unavailable ? null : new Date(base + DEFAULT_STALE_AFTER_MS).toISOString(),
    expiresAt: unavailable ? null : new Date(base + DEFAULT_EXPIRES_AFTER_MS).toISOString(),
    evidenceRef: observation.evidenceRef,
  });
}

function observationToUnavailable(
  observedAt: string,
  reason: CapacityUnavailableReason
): CursorIndividualObservation["billing"] {
  return { ...emptyBilling(observedAt), unavailableReason: reason };
}

/**
 * Read model for `GET /api/cursor-individual-billing`: the stored normalized
 * snapshot with freshness applied, or an explicit N/A. Disabled reads
 * `enabled: false` without touching credentials, HTTP, or the database. A
 * `cycleEnd` in the past reads `expired` — a finished cycle is never
 * presented as current capacity (mirrors "a past reset is never current").
 */
export async function getCursorIndividualBillingSnapshot(
  nowMs = Date.now()
): Promise<CursorIndividualBilling> {
  const generatedAt = new Date(nowMs).toISOString();
  const disabled = {
    enabled: false,
    configured: false,
    cycleLabel: null,
    cycleStart: null,
    cycleEnd: null,
    usageValue: null,
    usageUnit: null,
    remainingPercent: null,
    source: "unavailable" as const,
    unavailableReason: "missing" as const,
    observedAt: null,
    generatedAt,
  };
  if (!isCursorIndividualExperimentalEnabled()) return disabled;
  const status = cursorIndividualCredentialStatusSafe();
  if (!status.present) {
    return {
      ...disabled,
      enabled: true,
      unavailableReason: status.format === null && status.path !== null ? "unparsable" : "missing",
    };
  }
  const { readCursorIndividualBillingRow } = await import(
    "../repository/cursor-individual-billing.js"
  );
  const row = readCursorIndividualBillingRow();
  if (!row) {
    return {
      ...disabled,
      enabled: true,
      configured: true,
    };
  }
  const hasValues = row.usageValue !== null || row.remainingPercent !== null;
  let reason: CapacityUnavailableReason | null = row.unavailableReason;
  let nulled = false;
  if (hasValues && reason === null) {
    const cycleMs = row.cycleEnd !== null ? Date.parse(row.cycleEnd) : NaN;
    if (Number.isFinite(cycleMs) && cycleMs <= nowMs) {
      reason = "expired";
      nulled = true;
    } else if (row.expiresAt !== null && Date.parse(row.expiresAt) <= nowMs) {
      reason = "expired";
      nulled = true;
    } else if (row.freshUntil !== null && Date.parse(row.freshUntil) <= nowMs) {
      reason = "stale";
      nulled = true;
    }
  }
  return {
    enabled: true,
    configured: true,
    cycleLabel: nulled ? null : row.cycleLabel,
    cycleStart: nulled ? null : row.cycleStart,
    cycleEnd: nulled ? null : row.cycleEnd,
    usageValue: nulled ? null : row.usageValue,
    usageUnit: nulled ? null : row.usageUnit,
    remainingPercent: nulled ? null : row.remainingPercent,
    source: nulled || reason !== null ? "unavailable" : row.source,
    unavailableReason: reason,
    observedAt: row.observedAt,
    generatedAt,
  };
}

function cursorIndividualCredentialStatusSafe(): { present: boolean; path: string | null; format: string | null } {
  try {
    return cursorIndividualCredentialStatus();
  } catch {
    return { present: false, path: null, format: null };
  }
}

/**
 * Bounded refresh: run one dashboard read and ingest it. Used by the stale
 * path below; failures persist as N/A rows only for malformed/bad-credential
 * observations — transient failures keep last-known values. Never throws,
 * never touches runtime health, never logs the credential.
 */
export async function refreshCursorIndividualBilling(
  opts: CursorIndividualReadOptions = {}
): Promise<CursorIndividualBilling> {
  const nowMs = opts.nowMs ?? Date.now();
  let observation: CursorIndividualObservation;
  try {
    observation = await readCursorIndividualBilling({ ...opts, nowMs });
  } catch {
    logFailure("unavailable");
    observation = {
      billing: observationToUnavailable(new Date(nowMs).toISOString(), "missing"),
      enabled: isCursorIndividualExperimentalEnabled(),
      configured: false,
      viaSupportedApi: false,
      failure: { kind: "unavailable" },
      evidenceRef: null,
    };
  }
  try {
    await ingestCursorIndividualObservation(observation, nowMs);
  } catch {
    // Storage failure must not break the read below.
  }
  return getCursorIndividualBillingSnapshot(nowMs);
}

let cursorIndividualSharedPollInFlight: Promise<void> | null = null;
let cursorIndividualLastFailedPollMs: number | null = null;

/** Test helper — clear the failure backoff (and any in-flight refresh). */
export function resetCursorIndividualPollStateForTests(): void {
  cursorIndividualLastFailedPollMs = null;
  cursorIndividualSharedPollInFlight = null;
}

/**
 * One bounded dashboard poll, shared by BOTH on-demand refresh paths below.
 * The billing card (`/api/cursor-individual-billing`) and the capacity strip
 * (`/api/runtime-capacity`) each read a different stored table, so each
 * deciding independently that its own table is stale — as when both mount
 * concurrently against an empty database — would otherwise fire two
 * separate dashboard polls. This single-flights across BOTH callers (not
 * just concurrent calls to the same one) and ingests the one observation
 * into both stores, so satisfying either caller's staleness also refreshes
 * the other's. Failures back off for `CURSOR_INDIVIDUAL_FAILURE_BACKOFF_MS`
 * (shared by both paths) before polling again. Never throws.
 */
async function pollCursorIndividualShared(
  nowMs: number,
  opts: CursorIndividualReadOptions
): Promise<void> {
  if (
    cursorIndividualLastFailedPollMs !== null &&
    nowMs - cursorIndividualLastFailedPollMs < CURSOR_INDIVIDUAL_FAILURE_BACKOFF_MS
  ) {
    return;
  }
  if (cursorIndividualSharedPollInFlight) {
    await cursorIndividualSharedPollInFlight;
    return;
  }
  cursorIndividualSharedPollInFlight = (async () => {
    try {
      const observation = await readCursorIndividualBilling({ ...opts, nowMs });
      // Transient (auth/transport/rate-limit/redirect) failures must not
      // overwrite either store's last-known value — only a genuine verdict
      // on data that arrived (success, or malformed/bad-credential) does.
      // `ingestCursorIndividualObservation` already self-gates this for the
      // billing table; `ingestAdapterResult` has no such guard, so the call
      // site below gates it too — otherwise a transient failure would keep
      // the billing card's last-known value while silently replacing the
      // capacity strip's with `missing`, the two surfaces disagreeing after
      // the same poll.
      const transient =
        observation.failure !== null &&
        observation.failure.kind !== "malformed" &&
        observation.failure.kind !== "bad-credential";
      if (transient) {
        cursorIndividualLastFailedPollMs = nowMs;
      }
      try {
        await ingestCursorIndividualObservation(observation, nowMs);
      } catch {
        // Storage failure must not break the read below.
      }
      if (!transient) {
        try {
          const { ingestAdapterResult } = await import("./service.js");
          await ingestAdapterResult(cursorIndividualObservationToAdapterResult(observation, nowMs));
        } catch {
          // Storage failure must not break the read below.
        }
      }
    } catch {
      cursorIndividualLastFailedPollMs = nowMs;
    } finally {
      cursorIndividualSharedPollInFlight = null;
    }
  })();
  await cursorIndividualSharedPollInFlight;
}

/**
 * On-demand bounded refresh: when explicitly opted in and the stored
 * snapshot is missing or older than the stale window, run one bounded poll
 * (shared with the capacity-strip path below) and ingest it, then return.
 * Disabled, fresh snapshots, and recent failed polls short-circuit with no
 * credential access and no HTTP (single-flight across concurrent requests,
 * including the other refresh path). This helper never throws, never
 * touches runtime health, and never sends the credential off the allowlist.
 * Set `AGENT_DEALER_CURSOR_INDIVIDUAL_REFRESH=off` to disable.
 */
export async function refreshCursorIndividualBillingIfStale(
  nowMs = Date.now(),
  opts: CursorIndividualReadOptions = {}
): Promise<void> {
  if (process.env[CURSOR_INDIVIDUAL_REFRESH_ENV] === "off") return;
  if (!isCursorIndividualExperimentalEnabled()) return;
  const { readCursorIndividualBillingRow } = await import(
    "../repository/cursor-individual-billing.js"
  );
  const row = readCursorIndividualBillingRow();
  const newestObserved = row ? Date.parse(row.observedAt) : NaN;
  if (Number.isFinite(newestObserved) && newestObserved + DEFAULT_STALE_AFTER_MS > nowMs) {
    return;
  }
  await pollCursorIndividualShared(nowMs, opts);
}

// ---------------------------------------------------------------------------
// CapacityAdapter: billing-cycle window for `cursor_local` (NOT-243 strip)
// ---------------------------------------------------------------------------

/**
 * Map one observation to an adapter read result: a single `billing_cycle`
 * window (no duration — monthly data never becomes a 5H/1W window) carrying
 * the reported cycle reset and remaining usage, or an explicit unavailable
 * reading. The label/reset/remaining come verbatim from the dashboard; no
 * unsupported windows are guessed.
 */
export function cursorIndividualObservationToAdapterResult(
  observation: CursorIndividualObservation,
  nowMs = Date.now()
): { runtime: Runtime; windows: import("./adapter.js").AdapterWindowReading[]; unavailable: import("./adapter.js").AdapterUnavailableReading[] } {
  const observedAt = observation.billing.observedAt ?? new Date(nowMs).toISOString();
  if (observation.failure || observation.billing.unavailableReason !== null) {
    const reason =
      observation.billing.unavailableReason ??
      cursorIndividualFailureReason(observation.failure?.kind ?? "unavailable");
    return {
      runtime: CURSOR_INDIVIDUAL_RUNTIME,
      windows: [],
      unavailable: [
        {
          windowKey: CURSOR_INDIVIDUAL_WINDOW_KEY,
          providerBucket: CURSOR_INDIVIDUAL_PROVIDER_BUCKET,
          providerLabel: CURSOR_INDIVIDUAL_PROVIDER_LABEL,
          reason,
          observedAt,
        },
      ],
    };
  }
  const b = observation.billing;
  if (b.remainingPercent === null) {
    return {
      runtime: CURSOR_INDIVIDUAL_RUNTIME,
      windows: [],
      unavailable: [
        {
          windowKey: CURSOR_INDIVIDUAL_WINDOW_KEY,
          providerBucket: CURSOR_INDIVIDUAL_PROVIDER_BUCKET,
          providerLabel: CURSOR_INDIVIDUAL_PROVIDER_LABEL,
          reason: "unparsable",
          observedAt,
        },
      ],
    };
  }
  return {
    runtime: CURSOR_INDIVIDUAL_RUNTIME,
    windows: [
      {
        windowKey: CURSOR_INDIVIDUAL_WINDOW_KEY,
        providerBucket: CURSOR_INDIVIDUAL_PROVIDER_BUCKET,
        durationMinutes: null,
        providerLabel: CURSOR_INDIVIDUAL_PROVIDER_LABEL,
        usedValue: b.usageValue,
        usedUnit: b.usageUnit,
        // Round-trip through the shared used scale: 100 - remaining is exact
        // for the clamped 0–100 range, so normalization recovers `remaining`.
        usedPercent: 100 - b.remainingPercent,
        resetAt: b.cycleEnd,
        observedAt,
        source: b.source === "supported_protocol" ? "supported_protocol" : "experimental_api",
      },
    ],
    unavailable: [],
  };
}

/**
 * Experimental CapacityAdapter for `cursor_local`: disabled reads N/A
 * (`missing`) with no credential or endpoint access; opted-in reads run one
 * bounded dashboard poll. Failures never throw — they normalize to
 * unavailable windows downstream.
 */
export function cursorIndividualCapacityAdapter(
  opts: CursorIndividualReadOptions = {}
): import("./adapter.js").CapacityAdapter {
  return {
    runtime: CURSOR_INDIVIDUAL_RUNTIME,
    source: "experimental_api",
    read: async (nowMs = Date.now()) => {
      const observation = await readCursorIndividualBilling({ ...opts, nowMs });
      return cursorIndividualObservationToAdapterResult(observation, nowMs);
    },
  };
}

/**
 * On-demand capacity-strip refresh: when the stored `cursor_local` window in
 * `runtime_capacity_snapshots` is missing or stale, run the poll shared with
 * the billing-card path above (see `pollCursorIndividualShared`) so the
 * Agents-page strip shows the billing-cycle window (or its explicit N/A).
 * Disabled is a strict no-op — no credential, no HTTP. Mirrors the
 * Codex/Team stale-check pattern: a fresh stored window (younger than
 * `DEFAULT_STALE_AFTER_MS`) short-circuits with no HTTP. `GET
 * /api/runtime-capacity` calls this on every poll, so without the check (and
 * the single-flight shared with the billing-card path) it would hit the
 * dashboard on every request. Never throws, never touches runtime health.
 * Imported lazily to keep this module free of DB binds.
 */
export async function refreshCursorIndividualCapacityIfStale(
  nowMs = Date.now(),
  opts: CursorIndividualReadOptions = {}
): Promise<void> {
  if (process.env[CURSOR_INDIVIDUAL_REFRESH_ENV] === "off") return;
  if (!isCursorIndividualExperimentalEnabled()) return;
  const { listCapacitySnapshots } = await import("../repository/runtime-capacity.js");
  const rows = listCapacitySnapshots(CURSOR_INDIVIDUAL_RUNTIME);
  const newestObserved = rows.reduce<number | null>((max, row) => {
    const ms = Date.parse(row.observedAt);
    if (!Number.isFinite(ms)) return max;
    return max === null || ms > max ? ms : max;
  }, null);
  if (newestObserved !== null && newestObserved + DEFAULT_STALE_AFTER_MS > nowMs) {
    return;
  }
  await pollCursorIndividualShared(nowMs, opts);
}
