// packages/server/src/capacity/cursor-team.ts
//
// NOT-249: Cursor Team capacity adapter over the official Admin API
// (https://docs.cursor.com/en/account/teams/admin-api).
//
// Optional and team-scoped: it runs only when the operator explicitly
// configures `CURSOR_ADMIN_API_KEY` (server env / `.env`, same secret
// mechanism as `LINEAR_API_KEY`). It is distinct from the local Cursor CLI
// login (`cursor_local` connection health) and never touches the local
// session token, undocumented dashboard APIs, or individual accounts.
//
// Reads (bounded, non-billable metadata only):
// - `GET {base}/teams/spend` → subscription-cycle start/end, team spend, and
//   spend hard limit. All values keep the units the API reported.
// - `POST {base}/teams/daily-usage-data` (`{startDate, endDate}` epoch ms,
//   trailing 30 days) → per-day rows; summed to a usage-period spend only
//   when every spend-carrying row reports one shared currency.
//
// Monetary values are NEVER converted, NEVER rendered as token percentages,
// and no 5H/1W-style windows are invented: durationMinutes does not exist on
// this surface.
//
// Failure semantics (shared CapacityUnavailableReason enum only):
// - absent key -> `missing` (`configured: false`), no HTTP at all.
// - 401/403 (bad key or missing admin permission), network/5xx/timeout, 429
//   (rate limited) -> `missing` when nothing is stored; a stored snapshot
//   keeps serving under read-time freshness (`stale`/`expired`).
// - 2xx without a usable field -> `unparsable`.
// Failures never throw out of read(), never touch `runtime_availability`
// (NOT-111 health stays separate), and never log the key, URLs carrying
// secrets (the key travels header-only), or raw payloads.

import type {
  CapacityUnavailableReason,
  CursorTeamBilling,
} from "@agent-dealer/shared";
import { DEFAULT_STALE_AFTER_MS, DEFAULT_EXPIRES_AFTER_MS } from "./adapter.js";

/** Env var carrying the operator-configured Admin API key (server-side only). */
export const CURSOR_TEAM_KEY_ENV = "CURSOR_ADMIN_API_KEY";

/** Base URL override for tests (mock HTTP servers). */
export const CURSOR_TEAM_BASE_URL_ENV = "CURSOR_ADMIN_API_BASE_URL";

/** Documented Admin API base URL. */
export const CURSOR_ADMIN_API_BASE_URL = "https://api.cursor.com";

/** Opt-out for the on-demand stale refresh (mirrors the Codex adapter). */
export const CURSOR_TEAM_REFRESH_ENV = "AGENT_DEALER_CURSOR_TEAM_CAPACITY_REFRESH";

/** Timeout override env (mirrors the Codex adapter). */
export const CURSOR_TEAM_TIMEOUT_ENV = "AGENT_DEALER_CURSOR_TEAM_CAPACITY_TIMEOUT_MS";

/** Trailing usage window queried from the daily-usage endpoint (days). */
export const CURSOR_TEAM_USAGE_DAYS = 30;

/** Cap on an Admin API response body (larger bodies read `malformed`). */
export const CURSOR_TEAM_MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Server-side evidence pointers only — never credentials or raw payloads. */
export const CURSOR_TEAM_SPEND_EVIDENCE = "cursor-admin-api:teams/spend";
export const CURSOR_TEAM_USAGE_EVIDENCE = "cursor-admin-api:teams/daily-usage-data";

export function cursorTeamAdminKey(): string | undefined {
  const raw = process.env[CURSOR_TEAM_KEY_ENV]?.trim();
  return raw ? raw : undefined;
}

export function cursorTeamBaseUrl(): string {
  const raw = process.env[CURSOR_TEAM_BASE_URL_ENV]?.trim();
  return raw ? raw.replace(/\/+$/, "") : CURSOR_ADMIN_API_BASE_URL;
}

export function cursorTeamTimeoutMs(): number {
  const raw = process.env[CURSOR_TEAM_TIMEOUT_ENV];
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 15_000;
}

type FailureKind =
  | "absent-key"
  | "unavailable"
  | "forbidden"
  | "rate-limited"
  | "malformed";

/** Operator-safe failure log: the static kind only, never keys or payloads. */
function logFailure(kind: FailureKind): void {
  console.error(`[cursor-team-capacity] admin api read failed: ${kind}`);
}

export type FetchImpl = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }
) => Promise<{ status: number; text(): Promise<string> }>;

export interface CursorTeamReadOptions {
  key?: string;
  baseUrl?: string;
  timeoutMs?: number;
  nowMs?: number;
  usageDays?: number;
  fetchImpl?: FetchImpl;
}

export interface CursorTeamObservation {
  /** Normalized billing values (nulls when the endpoints did not report them). */
  billing: Omit<CursorTeamBilling, "configured" | "generatedAt">;
  failure: { kind: FailureKind } | null;
  evidenceRef: string | null;
}

// ---------------------------------------------------------------------------
// Tolerant parsing: only the canonical concepts below are contractual —
// billing-cycle start/end, spend + currency, hard limit + currency — field
// names and date shapes vary, so camelCase/snake_case aliases and epoch
// seconds/ms/ISO dates are all accepted. Unknown shapes yield nulls (the
// caller maps "no usable value" to `unparsable`), never guesses.
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
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

/** Epoch seconds/ms (number or numeric string) or ISO-8601 → ISO, else null. */
export function normalizeCursorApiDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return normalizeCursorApiDate(Number(trimmed));
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}

const CYCLE_START_KEYS = [
  "billingCycleStart",
  "billing_cycle_start",
  "cycleStart",
  "cycle_start",
  "subscriptionCycleStart",
  "subscription_cycle_start",
  "periodStart",
  "period_start",
];
const CYCLE_END_KEYS = [
  "billingCycleEnd",
  "billing_cycle_end",
  "cycleEnd",
  "cycle_end",
  "subscriptionCycleEnd",
  "subscription_cycle_end",
  "periodEnd",
  "period_end",
];
const SPEND_KEYS = [
  "spend",
  "totalSpend",
  "total_spend",
  "currentSpend",
  "current_spend",
  "amountSpent",
  "amount_spent",
];
const SPEND_UNIT_KEYS = ["spendCurrency", "spend_currency", "spendUnit", "spend_unit", "currency"];
const LIMIT_KEYS = [
  "hardLimit",
  "hard_limit",
  "spendLimit",
  "spend_limit",
  "budgetLimit",
  "budget_limit",
  "maxSpend",
  "max_spend",
];
const LIMIT_UNIT_KEYS = [
  "hardLimitCurrency",
  "hard_limit_currency",
  "limitCurrency",
  "limit_currency",
  "limitUnit",
  "limit_unit",
];
const ROW_SPEND_KEYS = [...SPEND_KEYS, "cost", "amount", "totalCost", "total_cost"];
const ROW_UNIT_KEYS = [...SPEND_UNIT_KEYS, "unit", "currencyCode", "currency_code"];

export interface CursorTeamSpendReadings {
  cycleStart: string | null;
  cycleEnd: string | null;
  spendValue: number | null;
  spendUnit: string | null;
  hardLimitValue: number | null;
  hardLimitUnit: string | null;
}

/**
 * Normalize a `GET /teams/spend` body. Returns null when the payload carries
 * no usable billing value (caller maps that to `unparsable`). A spend without
 * a reported currency keeps `spendUnit: null` rather than assuming one; a
 * hard limit keeps its own reported unit — money is never relabeled.
 */
export function cursorTeamSpendToReadings(payload: unknown): CursorTeamSpendReadings | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const inner =
    p.data && typeof p.data === "object" && !Array.isArray(p.data)
      ? { ...p, ...(p.data as Record<string, unknown>) }
      : p;
  const spendValue = pickNumber(inner, SPEND_KEYS);
  const hardLimitValue = pickNumber(inner, LIMIT_KEYS);
  if (spendValue === null && hardLimitValue === null) return null;
  return {
    cycleStart: normalizeCursorApiDate(pickRaw(inner, CYCLE_START_KEYS)),
    cycleEnd: normalizeCursorApiDate(pickRaw(inner, CYCLE_END_KEYS)),
    spendValue,
    spendUnit: spendValue === null ? null : pickString(inner, SPEND_UNIT_KEYS),
    hardLimitValue,
    hardLimitUnit: hardLimitValue === null ? null : (pickString(inner, LIMIT_UNIT_KEYS) ?? pickString(inner, SPEND_UNIT_KEYS)),
  };
}

function pickRaw(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return null;
}

export interface CursorTeamUsageReadings {
  spendValue: number | null;
  spendUnit: string | null;
  rows: number;
}

/**
 * Normalize a `POST /teams/daily-usage-data` body (`{ data: [...] }`, bare
 * arrays also accepted). Rows are summed to a period spend only when at
 * least one row reports a finite spend AND every spend-carrying row agrees
 * on one currency (case-insensitive); mixed currencies or spend-less rows
 * yield a null spend rather than a mixed-unit total.
 */
export function cursorTeamUsageToReadings(payload: unknown): CursorTeamUsageReadings | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const rows = Array.isArray(p) ? p : Array.isArray(p.data) ? p.data : null;
  if (!rows) return null;
  let total = 0;
  let contributors = 0;
  let currency: string | null = null;
  let mixed = false;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const spend = pickNumber(r, ROW_SPEND_KEYS);
    if (spend === null) continue;
    const unit = pickString(r, ROW_UNIT_KEYS);
    if (unit === null) {
      mixed = true;
      continue;
    }
    if (currency === null) {
      currency = unit;
    } else if (currency.toLowerCase() !== unit.toLowerCase()) {
      mixed = true;
      continue;
    }
    total += spend;
    contributors += 1;
  }
  if (mixed || contributors === 0 || currency === null) {
    return { spendValue: null, spendUnit: null, rows: rows.length };
  }
  return { spendValue: total, spendUnit: currency, rows: rows.length };
}

// ---------------------------------------------------------------------------
// Bounded HTTP read (injectable fetch so tests never touch the live API)
// ---------------------------------------------------------------------------

async function fetchJson(
  fetchImpl: FetchImpl,
  url: string,
  key: string,
  timeoutMs: number,
  method: "GET" | "POST",
  body?: Record<string, unknown>
): Promise<{ status: number; payload: unknown } | { failure: FailureKind } | { absent: true }> {
  let res: { status: number; text(): Promise<string> };
  try {
    res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { failure: "unavailable" };
  }
  if (res.status === 401 || res.status === 403) return { failure: "forbidden" };
  if (res.status === 429) return { failure: "rate-limited" };
  // 404/405 means the assumed documented path is absent — skip the endpoint
  // rather than failing the whole read; the sibling endpoint may still read.
  if (res.status === 404 || res.status === 405) return { absent: true };
  if (res.status < 200 || res.status >= 300) return { failure: "unavailable" };
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { failure: "malformed" };
  }
  if (text.length > CURSOR_TEAM_MAX_BODY_BYTES) return { failure: "malformed" };
  try {
    return { status: res.status, payload: JSON.parse(text) as unknown };
  } catch {
    return { failure: "malformed" };
  }
}

function defaultFetch(): FetchImpl {
  const impl = globalThis.fetch;
  return (url, init) =>
    (impl as typeof fetch)(url, init as RequestInit).then((res) => ({
      status: res.status,
      text: () => res.text(),
    }));
}

function emptyBilling(observedAt: string): CursorTeamObservation["billing"] {
  return {
    cycleStart: null,
    cycleEnd: null,
    spendValue: null,
    spendUnit: null,
    hardLimitValue: null,
    hardLimitUnit: null,
    usagePeriodStart: null,
    usagePeriodEnd: null,
    usageSpendValue: null,
    usageSpendUnit: null,
    source: "unavailable",
    unavailableReason: "missing",
    observedAt,
  };
}

/**
 * One bounded read of the documented team spend/usage endpoints. Never
 * throws for provider-side outcomes — those come back as `failure.kind` —
 * and never touches `runtime_availability`. The key travels header-only and
 * never appears in the observation, logs, or evidence refs.
 */
export async function readCursorTeamBilling(
  opts: CursorTeamReadOptions = {}
): Promise<CursorTeamObservation> {
  const nowMs = opts.nowMs ?? Date.now();
  const observedAt = new Date(nowMs).toISOString();
  const key = opts.key ?? cursorTeamAdminKey();
  if (!key) {
    return { billing: emptyBilling(observedAt), failure: { kind: "absent-key" }, evidenceRef: null };
  }
  const baseUrl = (opts.baseUrl ?? cursorTeamBaseUrl()).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? cursorTeamTimeoutMs();
  const fetchImpl = opts.fetchImpl ?? defaultFetch();
  const usageDays = opts.usageDays ?? CURSOR_TEAM_USAGE_DAYS;
  const usageEnd = nowMs;
  const usageStart = nowMs - usageDays * 24 * 3600_000;

  const [spendRes, usageRes] = await Promise.all([
    fetchJson(fetchImpl, `${baseUrl}/teams/spend`, key, timeoutMs, "GET"),
    fetchJson(
      fetchImpl,
      `${baseUrl}/teams/daily-usage-data`,
      key,
      timeoutMs,
      "POST",
      { startDate: usageStart, endDate: usageEnd }
    ),
  ]);

  // Auth / rate-limit / transport failures dominate: without usable auth the
  // read has no trustworthy values, even if one endpoint answered.
  const kinds = [spendRes, usageRes]
    .filter((r): r is { failure: FailureKind } => "failure" in r)
    .map((r) => r.failure);
  const fatal = kinds.find((k) => k === "forbidden" || k === "rate-limited" || k === "unavailable");
  if (fatal) {
    logFailure(fatal);
    return { billing: emptyBilling(observedAt), failure: { kind: fatal }, evidenceRef: null };
  }

  const spendReadings =
    "payload" in spendRes ? cursorTeamSpendToReadings(spendRes.payload) : null;
  const usageAnswered = "payload" in usageRes;
  const usageReadings = usageAnswered ? cursorTeamUsageToReadings(usageRes.payload) : null;
  const usable =
    spendReadings !== null ||
    (usageReadings !== null && usageReadings.spendValue !== null);
  if (!usable) {
    const answered = [spendRes, usageRes].some((r) => "payload" in r);
    if (!answered) {
      // Neither documented path exists (both 404/405) — the assumed shape
      // was not found: `missing`, not a parse verdict on real data.
      logFailure("unavailable");
      return { billing: emptyBilling(observedAt), failure: { kind: "unavailable" }, evidenceRef: null };
    }
    // At least one endpoint answered 2xx (anything else returned above) but
    // neither carried a usable billing value — `unparsable`, never a guess.
    logFailure("malformed");
    const billing = emptyBilling(observedAt);
    billing.unavailableReason = "unparsable";
    return { billing, failure: { kind: "malformed" }, evidenceRef: null };
  }

  return {
    billing: {
      cycleStart: spendReadings?.cycleStart ?? null,
      cycleEnd: spendReadings?.cycleEnd ?? null,
      spendValue: spendReadings?.spendValue ?? null,
      spendUnit: spendReadings?.spendUnit ?? null,
      hardLimitValue: spendReadings?.hardLimitValue ?? null,
      hardLimitUnit: spendReadings?.hardLimitUnit ?? null,
      usagePeriodStart: usageAnswered ? new Date(usageStart).toISOString() : null,
      usagePeriodEnd: usageAnswered ? new Date(usageEnd).toISOString() : null,
      usageSpendValue: usageReadings?.spendValue ?? null,
      usageSpendUnit: usageReadings?.spendUnit ?? null,
      source: "supported_protocol",
      unavailableReason: null,
      observedAt,
    },
    failure: null,
    evidenceRef: CURSOR_TEAM_SPEND_EVIDENCE,
  };
}

function observationToUnavailable(
  observedAt: string,
  reason: CapacityUnavailableReason
): CursorTeamObservation["billing"] {
  return { ...emptyBilling(observedAt), unavailableReason: reason };
}

/**
 * Failure kind → stored N/A reason (shared enum only). Auth, transport, and
 * rate-limit failures record `missing` (supported surface, no snapshot);
 * malformed payloads record `unparsable`. Absent key never reaches storage —
 * it short-circuits to `configured: false` at serve time.
 */
export function cursorTeamFailureReason(kind: FailureKind): CapacityUnavailableReason {
  return kind === "malformed" ? "unparsable" : "missing";
}

// ---------------------------------------------------------------------------
// Normalized snapshot persistence + bounded refresh (shared capacity pattern)
// ---------------------------------------------------------------------------

export interface CursorTeamStoredSnapshot {
  cycleStart: string | null;
  cycleEnd: string | null;
  spendValue: number | null;
  spendUnit: string | null;
  hardLimitValue: number | null;
  hardLimitUnit: string | null;
  usagePeriodStart: string | null;
  usagePeriodEnd: string | null;
  usageSpendValue: number | null;
  usageSpendUnit: string | null;
  source: CursorTeamObservation["billing"]["source"];
  unavailableReason: CapacityUnavailableReason | null;
  observedAt: string;
  freshUntil: string | null;
  expiresAt: string | null;
  evidenceRef: string | null;
}

/**
 * Persist one observation as the normalized team snapshot. Transient
 * transport/auth/rate-limit failures do NOT overwrite a stored snapshot —
 * the last-known values keep serving under read-time freshness instead.
 * Successful and malformed observations do overwrite (malformed is the
 * current verdict on arrived data). Imported lazily to keep this module
 * free of DB binds.
 */
export async function ingestCursorTeamObservation(
  observation: CursorTeamObservation,
  nowMs = Date.now()
): Promise<void> {
  const { writeCursorTeamBillingRow } = await import(
    "../repository/cursor-team-billing.js"
  );
  if (observation.failure && observation.failure.kind !== "malformed") return;
  const b = observation.billing;
  const observedAt = b.observedAt ?? new Date(nowMs).toISOString();
  const observedMs = Date.parse(observedAt);
  const base = Number.isFinite(observedMs) ? observedMs : nowMs;
  const unavailable = observation.failure !== null;
  writeCursorTeamBillingRow({
    cycleStart: b.cycleStart,
    cycleEnd: b.cycleEnd,
    spendValue: b.spendValue,
    spendUnit: b.spendUnit,
    hardLimitValue: b.hardLimitValue,
    hardLimitUnit: b.hardLimitUnit,
    usagePeriodStart: b.usagePeriodStart,
    usagePeriodEnd: b.usagePeriodEnd,
    usageSpendValue: b.usageSpendValue,
    usageSpendUnit: b.usageSpendUnit,
    source: b.source,
    unavailableReason: b.unavailableReason,
    observedAt,
    freshUntil: unavailable ? null : new Date(base + DEFAULT_STALE_AFTER_MS).toISOString(),
    expiresAt: unavailable ? null : new Date(base + DEFAULT_EXPIRES_AFTER_MS).toISOString(),
    evidenceRef: observation.evidenceRef,
  });
}

/**
 * Read model for `GET /api/cursor-team-billing`: the stored normalized
 * snapshot with freshness applied, or an explicit N/A. A `cycleEnd` in the
 * past reads `expired` — a finished cycle is never presented as current
 * billing (mirrors "a past reset is never current capacity").
 */
export async function getCursorTeamBillingSnapshot(
  nowMs = Date.now()
): Promise<CursorTeamBilling> {
  const generatedAt = new Date(nowMs).toISOString();
  if (!cursorTeamAdminKey()) {
    return {
      configured: false,
      cycleStart: null,
      cycleEnd: null,
      spendValue: null,
      spendUnit: null,
      hardLimitValue: null,
      hardLimitUnit: null,
      usagePeriodStart: null,
      usagePeriodEnd: null,
      usageSpendValue: null,
      usageSpendUnit: null,
      source: "unavailable",
      unavailableReason: "missing",
      observedAt: null,
      generatedAt,
    };
  }
  const { readCursorTeamBillingRow } = await import(
    "../repository/cursor-team-billing.js"
  );
  const row = readCursorTeamBillingRow();
  if (!row) {
    return {
      configured: true,
      cycleStart: null,
      cycleEnd: null,
      spendValue: null,
      spendUnit: null,
      hardLimitValue: null,
      hardLimitUnit: null,
      usagePeriodStart: null,
      usagePeriodEnd: null,
      usageSpendValue: null,
      usageSpendUnit: null,
      source: "unavailable",
      unavailableReason: "missing",
      observedAt: null,
      generatedAt,
    };
  }
  const hasValues =
    row.spendValue !== null || row.hardLimitValue !== null || row.usageSpendValue !== null;
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
    configured: true,
    cycleStart: nulled ? null : row.cycleStart,
    cycleEnd: nulled ? null : row.cycleEnd,
    spendValue: nulled ? null : row.spendValue,
    spendUnit: nulled ? null : row.spendUnit,
    hardLimitValue: nulled ? null : row.hardLimitValue,
    hardLimitUnit: nulled ? null : row.hardLimitUnit,
    usagePeriodStart: nulled ? null : row.usagePeriodStart,
    usagePeriodEnd: nulled ? null : row.usagePeriodEnd,
    usageSpendValue: nulled ? null : row.usageSpendValue,
    usageSpendUnit: nulled ? null : row.usageSpendUnit,
    source: nulled || reason !== null ? "unavailable" : row.source,
    unavailableReason: reason,
    observedAt: row.observedAt,
    generatedAt,
  };
}

/**
 * Bounded refresh: run one Admin API read and ingest it. Used by the stale
 * path below; failures persist as N/A rows only for malformed/success
 * observations — transient failures keep last-known values. Never throws,
 * never touches runtime health, never logs the key.
 */
export async function refreshCursorTeamBilling(
  opts: CursorTeamReadOptions = {}
): Promise<CursorTeamBilling> {
  const nowMs = opts.nowMs ?? Date.now();
  let observation: CursorTeamObservation;
  try {
    observation = await readCursorTeamBilling({ ...opts, nowMs });
  } catch {
    logFailure("unavailable");
    observation = {
      billing: observationToUnavailable(new Date(nowMs).toISOString(), "missing"),
      failure: { kind: "unavailable" },
      evidenceRef: null,
    };
  }
  try {
    await ingestCursorTeamObservation(observation, nowMs);
  } catch {
    // Storage failure must not break the read below.
  }
  return getCursorTeamBillingSnapshot(nowMs);
}

let cursorTeamStaleRefreshInFlight: Promise<unknown> | null = null;

/**
 * On-demand bounded refresh: when a key is configured and the stored
 * snapshot is missing or older than the stale window, run one bounded poll
 * and ingest it, then return. Fresh snapshots short-circuit with no HTTP.
 * Concurrent callers share one in-flight refresh (single-flight); failures
 * resolve to the stored snapshot — this helper never throws, never touches
 * runtime health, and never sends the local Cursor session token.
 * Set `AGENT_DEALER_CURSOR_TEAM_CAPACITY_REFRESH=off` to disable.
 */
export async function refreshCursorTeamBillingIfStale(
  nowMs = Date.now(),
  opts: CursorTeamReadOptions = {}
): Promise<void> {
  if (process.env[CURSOR_TEAM_REFRESH_ENV] === "off") return;
  if (!cursorTeamAdminKey()) return;
  const { readCursorTeamBillingRow } = await import(
    "../repository/cursor-team-billing.js"
  );
  const row = readCursorTeamBillingRow();
  const newestObserved = row ? Date.parse(row.observedAt) : NaN;
  if (Number.isFinite(newestObserved) && newestObserved + DEFAULT_STALE_AFTER_MS > nowMs) {
    return;
  }
  if (cursorTeamStaleRefreshInFlight) {
    await cursorTeamStaleRefreshInFlight;
    return;
  }
  cursorTeamStaleRefreshInFlight = (async () => {
    try {
      await refreshCursorTeamBilling({ ...opts, nowMs });
    } catch {
      // The read model still serves the stored snapshot with N/A reasons.
    } finally {
      cursorTeamStaleRefreshInFlight = null;
    }
  })();
  await cursorTeamStaleRefreshInFlight;
}
