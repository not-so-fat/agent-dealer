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
// Reads (bounded, non-billable metadata only, HTTP Basic auth with the API
// key as the username and an empty password):
// - `POST {base}/teams/spend` (`{page}` 1-based, paged via `totalPages`) → per-member
//   `teamMemberSpend` rows (`spendCents`, `hardLimitOverrideDollars`, ...),
//   `subscriptionCycleStart` (epoch ms), `totalMembers`, `totalPages`. Team
//   spend is the exact sum of reported `spendCents` (unit `cents`); per-member
//   limit overrides are counted as what they are, never relabeled as a team
//   hard limit. The API reports no team hard limit and no cycle end, so both
//   stay null.
// - `POST {base}/teams/daily-usage-data` (`{startDate, endDate}` epoch ms,
//   trailing 30 days) → activity/request-count rows, not spend: a 2xx only
//   records the queried usage period, never a monetary value.
//
// Monetary values are NEVER converted, NEVER rendered as token percentages,
// and no 5H/1W-style windows are invented: durationMinutes does not exist on
// this surface.
//
// Failure semantics (shared CapacityUnavailableReason enum only):
// - absent key -> `missing` (`configured: false`), no HTTP at all.
// - spend-endpoint 401/403 (bad key or missing admin permission),
//   network/5xx/timeout, 429 (rate limited) -> `missing` when nothing is
//   stored; a stored snapshot keeps serving under read-time freshness
//   (`stale`/`expired`). A daily-usage failure alone never fails the read —
//   the spend values still serve with the usage period unknown.
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

/** Reported unit of the summed per-member `spendCents` (never converted). */
export const CURSOR_TEAM_SPEND_UNIT_CENTS = "cents";

/**
 * Upper bound on `/teams/spend` pages per read: pagination follows
 * `totalPages`, but a lying `totalPages` must not turn one read into an
 * unbounded crawl.
 */
export const CURSOR_TEAM_MAX_SPEND_PAGES = 100;

/**
 * Cooldown after a failed poll before `refreshCursorTeamBillingIfStale()`
 * polls again: without it, every request right after a 429/5xx starts a new
 * Admin API poll. Successful and malformed reads are unaffected (a malformed
 * read persists a fresh N/A row that short-circuits on freshness instead).
 */
export const CURSOR_TEAM_FAILURE_BACKOFF_MS = 60_000;

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

/** Per-request timeout (each Admin API fetch gets this budget). */
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
// Documented-shape parsing: only the fields below are contractual —
// `teamMemberSpend[].spendCents`, `teamMemberSpend[].hardLimitOverrideDollars`,
// `subscriptionCycleStart` (epoch ms), `totalMembers`, `totalPages`.
// Anything else yields nulls (the caller maps "no usable value" to
// `unparsable`), never guesses. In particular: there is no team-level spend,
// no team hard limit, and no cycle end in the API, so those are never
// derived from per-member values.
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

function pickRaw(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return null;
}

/** Epoch ms (number or numeric string) or ISO-8601 → ISO, else null. */
export function normalizeCursorApiDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    // The documented cycle start is epoch milliseconds; small values are
    // tolerated as epoch seconds, anything else is rejected, never guessed.
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

const CYCLE_START_KEYS = ["subscriptionCycleStart", "subscription_cycle_start"];
const MEMBER_ROWS_KEYS = ["teamMemberSpend", "team_member_spend"];
const TOTAL_MEMBERS_KEYS = ["totalMembers", "total_members"];
const TOTAL_PAGES_KEYS = ["totalPages", "total_pages"];
const SPEND_CENTS_KEYS = ["spendCents", "spend_cents"];
const LIMIT_OVERRIDE_KEYS = ["hardLimitOverrideDollars", "hard_limit_override_dollars"];

export interface CursorTeamSpendPage {
  /** Per-member rows on this page (spend in cents, override flag). */
  members: Array<{ spendCents: number | null; hasLimitOverride: boolean }>;
  /** Raw `subscriptionCycleStart` value (normalized by the caller). */
  cycleStartRaw: unknown;
  /** Raw `totalMembers` value (finite numbers only). */
  totalMembers: number | null;
  /** Raw `totalPages` value (finite numbers only). */
  totalPages: number | null;
}

/**
 * Normalize one `POST /teams/spend` page body. Returns null when the payload
 * is not an object at all; a well-formed page with an empty member list is
 * still a page (zero spend), never a parse failure.
 */
export function cursorTeamSpendPageToReadings(payload: unknown): CursorTeamSpendPage | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  const rowsRaw = pickRaw(p, MEMBER_ROWS_KEYS);
  const rows = Array.isArray(rowsRaw) ? rowsRaw : null;
  const members =
    rows?.map((row) => {
      const r = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
      return {
        spendCents: pickNumber(r, SPEND_CENTS_KEYS),
        hasLimitOverride: pickNumber(r, LIMIT_OVERRIDE_KEYS) !== null,
      };
    }) ?? [];
  return {
    members,
    cycleStartRaw: pickRaw(p, CYCLE_START_KEYS),
    totalMembers: pickNumber(p, TOTAL_MEMBERS_KEYS),
    totalPages: pickNumber(p, TOTAL_PAGES_KEYS),
  };
}

export interface CursorTeamSpendReadings {
  cycleStart: string | null;
  /** The API reports no cycle end: always null, never invented. */
  cycleEnd: null;
  /** Exact sum of reported per-member `spendCents`; null with no member rows. */
  spendValue: number | null;
  /** `cents` with member rows, else null — the reported unit, never assumed. */
  spendUnit: string | null;
  /** The API reports no team hard limit: always null, never relabeled. */
  hardLimitValue: null;
  hardLimitUnit: null;
  /** Reported `totalMembers` (or the exact rows seen when absent). */
  memberCount: number | null;
  /** Members reporting a per-member limit override — not a team limit. */
  memberLimitOverrideCount: number | null;
}

/**
 * Fold `POST /teams/spend` pages into one reading. Returns null when the
 * pages carry no usable billing value at all (caller maps that to
 * `unparsable`): at least one member row, a cycle start, or a team size is
 * required — anything less is not evidence.
 */
export function cursorTeamSpendPagesToReadings(pages: CursorTeamSpendPage[]): CursorTeamSpendReadings | null {
  if (pages.length === 0) return null;
  let spendTotal = 0;
  let membersSeen = 0;
  let overridesSeen = 0;
  let cycleStartRaw: unknown = null;
  let totalMembers: number | null = null;
  for (const page of pages) {
    if (cycleStartRaw === null && page.cycleStartRaw !== undefined && page.cycleStartRaw !== null) {
      cycleStartRaw = page.cycleStartRaw;
    }
    if (totalMembers === null && page.totalMembers !== null) {
      totalMembers = page.totalMembers;
    }
    for (const m of page.members) {
      membersSeen += 1;
      if (m.spendCents !== null) spendTotal += m.spendCents;
      if (m.hasLimitOverride) overridesSeen += 1;
    }
  }
  // Members without a reported spendCents contribute rows but no cents:
  // spend is the exact sum of reported cents, even when that sum is zero.
  const cycleStart = normalizeCursorApiDate(cycleStartRaw);
  if (membersSeen === 0 && cycleStart === null && totalMembers === null) return null;
  return {
    cycleStart,
    cycleEnd: null,
    spendValue: membersSeen === 0 ? null : spendTotal,
    spendUnit: membersSeen === 0 ? null : CURSOR_TEAM_SPEND_UNIT_CENTS,
    hardLimitValue: null,
    hardLimitUnit: null,
    memberCount: totalMembers ?? (membersSeen > 0 ? membersSeen : null),
    memberLimitOverrideCount: membersSeen === 0 ? null : overridesSeen,
  };
}

// ---------------------------------------------------------------------------
// Bounded HTTP read (injectable fetch so tests never touch the live API)
// ---------------------------------------------------------------------------

/**
 * Documented Admin API auth: HTTP Basic with the API key as the username and
 * an empty password. The key travels header-only — never in a URL, a body, a
 * log, or a stored observation.
 */
export function cursorTeamAuthHeader(key: string): string {
  return `Basic ${Buffer.from(`${key}:`, "utf8").toString("base64")}`;
}

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
        Authorization: cursorTeamAuthHeader(key),
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
  // 404/405 on a documented path means the endpoint is absent for this team
  // (or moved) — skip it rather than failing the whole read; the sibling
  // endpoint may still read.
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
    memberCount: null,
    memberLimitOverrideCount: null,
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
 * One bounded, paginated read of `POST /teams/spend` (`{page}` 1-based per
 * the Admin API — `page` defaults to 1 — following `totalPages` up to
 * `CURSOR_TEAM_MAX_SPEND_PAGES`). Returns the folded pages plus the first
 * transport-level outcome: auth/rate-limit/transport failures dominate over
 * page data, while 404/405 marks the endpoint absent.
 */
async function readSpendPages(
  fetchImpl: FetchImpl,
  baseUrl: string,
  key: string,
  timeoutMs: number
): Promise<
  | { pages: CursorTeamSpendPage[] }
  | { failure: FailureKind }
  | { absent: true }
> {
  const pages: CursorTeamSpendPage[] = [];
  let page = 1;
  for (;;) {
    const res = await fetchJson(
      fetchImpl,
      `${baseUrl}/teams/spend`,
      key,
      timeoutMs,
      "POST",
      { page }
    );
    if ("failure" in res) return { failure: res.failure };
    if ("absent" in res) {
      // No pages yet and the path is absent: the endpoint did not answer.
      // Pages already collected stay usable — a later page vanishing is not
      // evidence against the data already returned.
      return pages.length === 0 ? { absent: true } : { pages };
    }
    const parsed = cursorTeamSpendPageToReadings(res.payload);
    if (parsed === null) return { failure: "malformed" };
    pages.push(parsed);
    const totalPages = parsed.totalPages;
    // `totalPages` is a 1-based page count; pages run 1..totalPages. An
    // absent/invalid count means a single page — never an unbounded crawl.
    const lastPage =
      totalPages === null || !Number.isInteger(totalPages) || totalPages <= 0
        ? 1
        : Math.min(totalPages, CURSOR_TEAM_MAX_SPEND_PAGES);
    if (page >= lastPage) break;
    page += 1;
    if (page > CURSOR_TEAM_MAX_SPEND_PAGES) break;
  }
  return { pages };
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
    readSpendPages(fetchImpl, baseUrl, key, timeoutMs),
    fetchJson(
      fetchImpl,
      `${baseUrl}/teams/daily-usage-data`,
      key,
      timeoutMs,
      "POST",
      { startDate: usageStart, endDate: usageEnd }
    ),
  ]);

  // Spend decides the outcome: auth / rate-limit / transport failures on the
  // spend endpoint dominate (without usable spend the read has no
  // trustworthy billing values). Daily-usage only contributes the queried
  // period, so a usage failure degrades to "period unknown" instead of
  // throwing away a successful spend read.
  const spendFatal =
    "failure" in spendRes &&
    (spendRes.failure === "forbidden" ||
      spendRes.failure === "rate-limited" ||
      spendRes.failure === "unavailable")
      ? spendRes.failure
      : null;
  if (spendFatal) {
    logFailure(spendFatal);
    return { billing: emptyBilling(observedAt), failure: { kind: spendFatal }, evidenceRef: null };
  }

  const spendReadings =
    "pages" in spendRes ? cursorTeamSpendPagesToReadings(spendRes.pages) : null;
  const usageAnswered = "payload" in usageRes;
  // Daily-usage rows report activity and request counts, not spend: a 2xx
  // records the queried usage period and nothing monetary.
  if (spendReadings === null) {
    const answered = "pages" in spendRes || usageAnswered;
    if (!answered) {
      // The spend path is absent (404/405) and usage did not answer either:
      // `missing`, not a parse verdict on real data.
      logFailure("unavailable");
      return { billing: emptyBilling(observedAt), failure: { kind: "unavailable" }, evidenceRef: null };
    }
    // At least one endpoint answered 2xx (anything else returned above) but
    // the spend pages carried no usable billing value — `unparsable`, never
    // a guess.
    logFailure("malformed");
    const billing = emptyBilling(observedAt);
    billing.unavailableReason = "unparsable";
    return { billing, failure: { kind: "malformed" }, evidenceRef: null };
  }

  return {
    billing: {
      cycleStart: spendReadings.cycleStart,
      cycleEnd: spendReadings.cycleEnd,
      spendValue: spendReadings.spendValue,
      spendUnit: spendReadings.spendUnit,
      hardLimitValue: spendReadings.hardLimitValue,
      hardLimitUnit: spendReadings.hardLimitUnit,
      memberCount: spendReadings.memberCount,
      memberLimitOverrideCount: spendReadings.memberLimitOverrideCount,
      usagePeriodStart: usageAnswered ? new Date(usageStart).toISOString() : null,
      usagePeriodEnd: usageAnswered ? new Date(usageEnd).toISOString() : null,
      usageSpendValue: null,
      usageSpendUnit: null,
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
  memberCount: number | null;
  memberLimitOverrideCount: number | null;
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
    memberCount: b.memberCount,
    memberLimitOverrideCount: b.memberLimitOverrideCount,
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
      memberCount: null,
      memberLimitOverrideCount: null,
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
      memberCount: null,
      memberLimitOverrideCount: null,
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
    row.spendValue !== null ||
    row.hardLimitValue !== null ||
    row.usageSpendValue !== null ||
    row.memberCount !== null ||
    row.memberLimitOverrideCount !== null;
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
    memberCount: nulled ? null : row.memberCount,
    memberLimitOverrideCount: nulled ? null : row.memberLimitOverrideCount,
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
 * Last failed on-demand poll (transient failure kinds only, which persist
 * nothing). While inside `CURSOR_TEAM_FAILURE_BACKOFF_MS` of it, stale
 * refreshes skip polling so a 429/5xx does not trigger an Admin API poll on
 * every request. Compared against the caller-supplied `nowMs`, so tests stay
 * deterministic.
 */
let cursorTeamLastFailedPollMs: number | null = null;

/** Test helper — clear the failure backoff (and any in-flight refresh). */
export function resetCursorTeamPollStateForTests(): void {
  cursorTeamLastFailedPollMs = null;
  cursorTeamStaleRefreshInFlight = null;
}

/**
 * On-demand bounded refresh: when a key is configured and the stored
 * snapshot is missing or older than the stale window, run one bounded poll
 * and ingest it, then return. Fresh snapshots short-circuit with no HTTP.
 * A recent failed poll also short-circuits (failure backoff) so transient
 * errors stay bounded under rate limits. Concurrent callers share one
 * in-flight refresh (single-flight); failures resolve to the stored snapshot
 * — this helper never throws, never touches runtime health, and never sends
 * the local Cursor session token.
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
  if (
    cursorTeamLastFailedPollMs !== null &&
    nowMs - cursorTeamLastFailedPollMs < CURSOR_TEAM_FAILURE_BACKOFF_MS
  ) {
    return;
  }
  if (cursorTeamStaleRefreshInFlight) {
    await cursorTeamStaleRefreshInFlight;
    return;
  }
  cursorTeamStaleRefreshInFlight = (async () => {
    try {
      const observation = await readCursorTeamBilling({ ...opts, nowMs });
      if (observation.failure && observation.failure.kind !== "malformed") {
        // Transient failures persist nothing, so without this timestamp every
        // request would start another poll — including right after a 429.
        // (Malformed reads persist a fresh N/A row that short-circuits on
        // freshness instead.)
        cursorTeamLastFailedPollMs = nowMs;
      }
      try {
        await ingestCursorTeamObservation(observation, nowMs);
      } catch {
        // Storage failure must not break the read below.
      }
    } catch {
      cursorTeamLastFailedPollMs = nowMs;
      // The read model still serves the stored snapshot with N/A reasons.
    } finally {
      cursorTeamStaleRefreshInFlight = null;
    }
  })();
  await cursorTeamStaleRefreshInFlight;
}
