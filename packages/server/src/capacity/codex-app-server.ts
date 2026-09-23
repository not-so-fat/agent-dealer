// packages/server/src/capacity/codex-app-server.ts
//
// NOT-246: Codex capacity adapter over the official App Server interface
// (https://developers.openai.com/codex/app-server).
// NOT-263: semantic deduplication of the aggregate `rateLimits` pair against
// `rateLimitsByLimitId` buckets, plus persisted-row reconciliation.
//
// Read-only account operation: the client performs the initialization
// handshake, then a single `account/rateLimits/read`, and optionally records
// `account/rateLimits/updated` notifications received while the managed
// connection is alive. It never creates a thread, submits a turn, or runs a
// model prompt — enforced by READ_ONLY_METHODS: any other method throws before
// it is written to the subprocess.
//
// Both `rateLimits` (primary/secondary windows) and `rateLimitsByLimitId`
// (per-limit buckets) are normalized. Each window keeps its provider identity
// (`providerBucket`), `usedPercent`, `windowDurationMins`, and `resetsAt`.
// Parsing is tolerant (camelCase/snake_case, epoch-second/ms or ISO resets)
// because only the canonical names above are contractual.
//
// When the aggregate primary/secondary pair exactly mirrors one detailed
// bucket's pair (same used scale, duration, and reset — never the display
// label alone), the aggregate aliases collapse and the detailed identity
// wins, so each logical window renders once. Genuinely distinct buckets stay
// visible even when they share a duration.
//
// Failure semantics (shared CapacityUnavailableReason enum only):
// - App Server unavailable / unauthenticated / timeout -> `missing`
//   (supported surface, no snapshot recorded). The exact cause stays
//   distinguishable server-side via the static log line, never in payloads.
// - Malformed payload -> `unparsable`.
// - Server without the method (-32601) -> `unsupported`.
// Failures never throw out of read(), never touch `runtime_availability`
// (NOT-111 health stays separate), and never log tokens or raw payloads: the
// adapter passes no credentials (the App Server subprocess uses its ambient
// session) and evidence refs are static strings.

import { spawn, type ChildProcess } from "node:child_process";
import type {
  CapacityCriticalRole,
  CapacityUnavailableReason,
  Runtime,
} from "@agent-dealer/shared";
import { resolveCodexBin } from "../cli-env.js";
import {
  normalizeAdapterWindow,
  normalizeUnavailableWindow,
  type AdapterReadResult,
  type AdapterUnavailableReading,
  type AdapterWindowReading,
  type CapacityAdapter,
} from "./adapter.js";

export const CODEX_RUNTIME: Runtime = "codex_local";

/**
 * Client version sent in the `initialize` handshake (`clientInfo.version`).
 * Kept in sync with `packages/server/package.json` — the App Server requires
 * a versioned client identity and may reject a version-less handshake.
 */
export const CODEX_CLIENT_VERSION = "1.1.10";

export const CODEX_CLIENT_INFO = {
  name: "agent-dealer",
  title: "agent-dealer",
  version: CODEX_CLIENT_VERSION,
} as const;

/** Methods this client may ever send. Anything else throws before write. */
export const READ_ONLY_METHODS = [
  "initialize",
  "initialized",
  "account/rateLimits/read",
] as const;
export type ReadOnlyMethod = (typeof READ_ONLY_METHODS)[number];

/** Notification the client records (never sends) while connected. */
export const RATE_LIMITS_UPDATED = "account/rateLimits/updated";

/** Methods that would start billable model work — never sent, asserted in tests. */
export const FORBIDDEN_MODEL_METHODS = [
  "thread/start",
  "turn/start",
  "thread/resume",
  "item/commandExecution/start",
] as const;

export function assertReadOnlyMethod(method: string): asserts method is ReadOnlyMethod {
  if (!(READ_ONLY_METHODS as readonly string[]).includes(method)) {
    throw new Error(`codex-app-server: refusing non-read method ${method}`);
  }
}

function readOnlyRequest(id: number, method: ReadOnlyMethod, params: unknown): string {
  assertReadOnlyMethod(method);
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

function readOnlyNotification(method: ReadOnlyMethod, params: unknown): string {
  assertReadOnlyMethod(method);
  return `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`;
}

// ---------------------------------------------------------------------------
// Payload normalization
// ---------------------------------------------------------------------------

/** One window as the App Server reports it (tolerant field access). */
export interface CodexRateLimitWindowLike {
  usedPercent?: unknown;
  used_percent?: unknown;
  usedFraction?: unknown;
  used_fraction?: unknown;
  windowDurationMins?: unknown;
  window_duration_mins?: unknown;
  windowDurationMinutes?: unknown;
  durationMinutes?: unknown;
  duration_minutes?: unknown;
  resetsAt?: unknown;
  resets_at?: unknown;
  resetAt?: unknown;
  reset_at?: unknown;
  label?: unknown;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pickNumber(candidates: unknown[]): number | null {
  for (const c of candidates) {
    const n = asFiniteNumber(c);
    if (n !== null) return n;
  }
  return null;
}

/** resetsAt arrives as epoch seconds, epoch ms, or ISO-8601 — normalize to ISO. */
export function normalizeCodexResetsAt(value: unknown): string | null {
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
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return normalizeCodexResetsAt(Number(trimmed));
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}

function sanitizeKeySegment(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || "window";
}

function windowReadingFromEntry(
  entry: unknown,
  identity: {
    windowKey: string;
    providerBucket: string;
    labelOverride?: string | null;
    criticalRole?: CapacityCriticalRole | null;
  },
  observedAt: string
): AdapterWindowReading | null {
  if (!entry || typeof entry !== "object") return null;
  const w = entry as CodexRateLimitWindowLike;
  const usedPercent = pickNumber([w.usedPercent, w.used_percent]);
  const usedFraction = pickNumber([w.usedFraction, w.used_fraction]);
  if (usedPercent === null && usedFraction === null) return null;
  const durationRaw = pickNumber([
    w.windowDurationMins,
    w.window_duration_mins,
    w.windowDurationMinutes,
    w.durationMinutes,
    w.duration_minutes,
  ]);
  const override = identity.labelOverride;
  const label =
    typeof w.label === "string" && w.label.length > 0
      ? w.label
      : typeof override === "string" && override.length > 0
        ? override
        : identity.providerBucket;
  return {
    windowKey: identity.windowKey,
    providerBucket: identity.providerBucket,
    durationMinutes: durationRaw !== null ? Math.round(durationRaw) : null,
    providerLabel: label,
    usedValue: usedPercent ?? usedFraction,
    usedUnit: usedPercent !== null ? "percent" : "fraction",
    ...(usedPercent !== null ? { usedPercent } : { usedFraction: usedFraction as number }),
    resetAt: normalizeCodexResetsAt(w.resetsAt ?? w.resets_at ?? w.resetAt ?? w.reset_at),
    observedAt,
    source: "supported_protocol",
    criticalRole: identity.criticalRole ?? null,
  };
}

export interface CodexRateLimitsReadings {
  windows: AdapterWindowReading[];
  /**
   * Aggregate `rateLimits` keys collapsed because one detailed bucket
   * exactly mirrors the pair. The refresh path deletes these persisted rows
   * so databases written by older versions heal without manual cleanup.
   */
  collapsedAggregateKeys: string[];
}

/**
 * Semantic window equality for dedup: same used scale and value, same
 * duration, same normalized reset. Display labels (`5H`/`1W`) are never
 * compared — two genuinely distinct buckets may share a duration.
 */
export function codexWindowValuesEqual(a: AdapterWindowReading, b: AdapterWindowReading): boolean {
  const aPercent = a.usedPercent ?? null;
  const bPercent = b.usedPercent ?? null;
  if (aPercent !== null || bPercent !== null) {
    if (aPercent === null || bPercent === null || aPercent !== bPercent) return false;
  } else {
    const aFraction = a.usedFraction ?? null;
    const bFraction = b.usedFraction ?? null;
    if (aFraction === null || bFraction === null || aFraction !== bFraction) return false;
  }
  if ((a.durationMinutes ?? null) !== (b.durationMinutes ?? null)) return false;
  if ((a.resetAt ?? null) !== (b.resetAt ?? null)) return false;
  return true;
}

/** One `rateLimitsByLimitId` bucket: identity plus nested window snapshots. */
export interface CodexRateLimitBucketLike {
  limitId?: unknown;
  limit_id?: unknown;
  limitName?: unknown;
  limit_name?: unknown;
  name?: unknown;
  primary?: unknown;
  secondary?: unknown;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Normalize `rateLimits` + `rateLimitsByLimitId` into adapter readings.
 * Returns null when the payload carries no usable window (caller maps that to
 * an `unparsable` unavailable reading). Entries that are individually
 * malformed are skipped; `rateLimits` keys use a `codex_rate_limit_` prefix
 * and `rateLimitsByLimitId` keys a `codex_limit_<limitId>_<primary|secondary>`
 * prefix so the two maps can never overwrite each other and per-limit buckets
 * stay distinguishable.
 *
 * Each `rateLimitsByLimitId` bucket is a nested snapshot
 * (`{ limitId, limitName, primary, secondary }`): every present
 * primary/secondary sub-window becomes its own reading whose providerBucket
 * carries both the limit id and the window (`<limitId>/<primary|secondary>`)
 * and whose label is the bucket's `limitName`. A bucket without nested
 * windows still parses as one legacy flat window so older servers keep
 * working.
 *
 * Deduplication (NOT-263): when the aggregate `primary`/`secondary` pair
 * exactly mirrors one detailed bucket's pair (same used scale, duration,
 * and reset), the aggregate aliases collapse and the detailed identity wins
 * — each logical window is reported once. The comparison is semantic, never
 * label-based, so genuinely distinct buckets sharing a duration stay
 * visible; a partial overlap (only one sub-window matches) never collapses.
 */
export function codexRateLimitsToReadings(
  payload: unknown,
  observedAt = new Date().toISOString()
): CodexRateLimitsReadings | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const aggregate: AdapterWindowReading[] = [];
  const primary = p.rateLimits;
  if (primary && typeof primary === "object") {
    for (const [name, entry] of Object.entries(primary as Record<string, unknown>)) {
      // The `rateLimits` aggregate is, by construction, the account-wide
      // summary — its `primary`/`secondary` entries are the critical 5H/1W
      // pair whenever present; any other key the provider might add here is
      // not part of that identity.
      const criticalRole: CapacityCriticalRole | null =
        name === "primary" ? "five_hour" : name === "secondary" ? "weekly" : null;
      const reading = windowReadingFromEntry(
        entry,
        { windowKey: `codex_rate_limit_${sanitizeKeySegment(name)}`, providerBucket: name, criticalRole },
        observedAt
      );
      if (reading) aggregate.push(reading);
    }
  }
  const buckets = new Map<string, { primary?: AdapterWindowReading; secondary?: AdapterWindowReading }>();
  const flat: AdapterWindowReading[] = [];
  const byId = p.rateLimitsByLimitId ?? p.rate_limits_by_limit_id;
  if (byId && typeof byId === "object") {
    for (const [mapKey, bucket] of Object.entries(byId as Record<string, unknown>)) {
      if (!bucket || typeof bucket !== "object") continue;
      const b = bucket as CodexRateLimitBucketLike;
      const limitId =
        nonEmptyString(b.limitId) ?? nonEmptyString(b.limit_id) ?? mapKey;
      const limitName =
        nonEmptyString(b.limitName) ?? nonEmptyString(b.limit_name) ?? nonEmptyString(b.name);
      let nested = false;
      const pair: { primary?: AdapterWindowReading; secondary?: AdapterWindowReading } = {};
      for (const sub of ["primary", "secondary"] as const) {
        const entry = b[sub];
        if (!entry || typeof entry !== "object") continue;
        nested = true;
        const reading = windowReadingFromEntry(
          entry,
          {
            windowKey: `codex_limit_${sanitizeKeySegment(limitId)}_${sub}`,
            providerBucket: `${limitId}/${sub}`,
            labelOverride: limitName,
          },
          observedAt
        );
        if (reading) pair[sub] = reading;
      }
      if (nested) {
        buckets.set(limitId, pair);
      } else {
        const reading = windowReadingFromEntry(
          bucket,
          {
            windowKey: `codex_limit_${sanitizeKeySegment(limitId)}`,
            providerBucket: limitId,
            labelOverride: limitName,
          },
          observedAt
        );
        if (reading) flat.push(reading);
      }
    }
  }
  const collapsedAggregateKeys: string[] = [];
  const aggPrimary = aggregate.find((w) => w.windowKey === "codex_rate_limit_primary");
  const aggSecondary = aggregate.find((w) => w.windowKey === "codex_rate_limit_secondary");
  if (aggPrimary && aggSecondary) {
    for (const pair of buckets.values()) {
      if (
        pair.primary &&
        pair.secondary &&
        codexWindowValuesEqual(aggPrimary, pair.primary) &&
        codexWindowValuesEqual(aggSecondary, pair.secondary)
      ) {
        collapsedAggregateKeys.push(aggPrimary.windowKey, aggSecondary.windowKey);
        // The surviving detailed pair now stands in for the aggregate it
        // absorbed — it IS the account-wide identity, so it inherits the
        // aggregate's criticalRole rather than reporting as non-critical.
        pair.primary = { ...pair.primary, criticalRole: "five_hour" };
        pair.secondary = { ...pair.secondary, criticalRole: "weekly" };
        break;
      }
    }
  }
  const out: AdapterWindowReading[] = [
    ...aggregate.filter((w) => !collapsedAggregateKeys.includes(w.windowKey)),
    ...[...buckets.values()].flatMap((pair) =>
      [pair.primary, pair.secondary].filter((w): w is AdapterWindowReading => w !== undefined)
    ),
    ...flat,
  ];
  return out.length > 0 ? { windows: out, collapsedAggregateKeys } : null;
}

// ---------------------------------------------------------------------------
// JSONL subprocess client (bounded, read-only)
// ---------------------------------------------------------------------------

export interface CodexAppServerOptions {
  /** Binary to spawn. Defaults to the resolved Codex CLI. */
  command?: string;
  /** Args for the binary. Defaults to `["app-server"]`. */
  args?: string[];
  /** Extra env for the subprocess. */
  env?: Record<string, string>;
  /** Overall bound in ms (default 15s, env AGENT_DEALER_CODEX_CAPACITY_TIMEOUT_MS). */
  timeoutMs?: number;
  nowMs?: number;
  spawnImpl?: typeof spawn;
}

export function codexCapacityTimeoutMs(): number {
  const raw = process.env.AGENT_DEALER_CODEX_CAPACITY_TIMEOUT_MS;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 15_000;
}

type FailureKind = "unavailable" | "unauthenticated" | "timeout" | "malformed" | "unsupported";

// Anchored to explicit auth-failure phrasing: bare `auth`/`login` substrings
// misclassify unrelated crash output as unauthenticated in operator logs.
const AUTH_RE =
  /unauthenticated|unauthorized|not (signed|logged)[ -]in|not authenticated|authentication (required|failed|expired)|please (sign|log) in|signed out|logged out|\b401\b|\b403\b|forbidden/i;

export interface CodexRateLimitsRead {
  payload: unknown;
  /** Parsed `account/rateLimits/updated` bodies seen while connected (usually 0). */
  updates: unknown[];
  failure: { kind: FailureKind } | null;
}

interface RpcResponse {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

function parseRpcLine(line: string): (RpcResponse & { method?: unknown; params?: unknown }) | null {
  const t = line.trim();
  if (!t) return null;
  try {
    const v = JSON.parse(t) as Record<string, unknown>;
    if (!v || typeof v !== "object") return null;
    return v as RpcResponse & { method?: unknown; params?: unknown };
  } catch {
    return null;
  }
}

function errorLooksAuth(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown; data?: unknown };
  return (
    AUTH_RE.test(String(e.message ?? "")) ||
    AUTH_RE.test(String((e.data as { message?: unknown } | null)?.message ?? "")) ||
    e.code === 401 ||
    e.code === 403
  );
}

/**
 * Spawn the App Server, run the handshake + `account/rateLimits/read`, record
 * any `account/rateLimits/updated` notifications, then shut the connection
 * down. Never throws for provider-side failures — those come back as
 * `failure.kind`. Never sends anything outside READ_ONLY_METHODS.
 */
export function readCodexRateLimits(opts: CodexAppServerOptions = {}): Promise<CodexRateLimitsRead> {
  const command = opts.command ?? resolveCodexBin();
  const args = opts.args ?? ["app-server"];
  const timeoutMs = opts.timeoutMs ?? codexCapacityTimeoutMs();
  const spawnImpl = opts.spawnImpl ?? spawn;
  return new Promise((resolve) => {
    const updates: unknown[] = [];
    let settled = false;
    let child: ChildProcess | undefined;
    let buffer = "";
    let initResolve: ((r: RpcResponse) => void) | null = null;
    let readResolve: ((r: RpcResponse) => void) | null = null;

    const finish = (out: CodexRateLimitsRead) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.kill();
      } catch {
        // Already exited — nothing to signal.
      }
      resolve(out);
    };
    const fail = (kind: FailureKind): void => {
      finish({ payload: null, updates, failure: { kind } });
    };

    const onLine = (line: string) => {
      const msg = parseRpcLine(line);
      if (!msg) return; // Tolerate non-JSON chatter; malformed verdict comes from the payload.
      if (typeof msg.method === "string" && msg.id === undefined) {
        if (msg.method === RATE_LIMITS_UPDATED) updates.push(msg.params ?? null);
        return;
      }
      if (msg.id === 1 && initResolve) {
        const cb = initResolve;
        initResolve = null;
        cb(msg);
      } else if (msg.id === 2 && readResolve) {
        const cb = readResolve;
        readResolve = null;
        cb(msg);
      }
    };

    const timer = setTimeout(() => {
      try {
        child?.kill();
      } catch {
        // Already exited — nothing to signal.
      }
      // A wedged App Server can ignore SIGTERM; escalate once so repeated
      // polls cannot orphan a subprocess per read.
      const killer = setTimeout(() => {
        try {
          if (child && child.exitCode === null) child.kill("SIGKILL");
        } catch {
          // Already exited — nothing to signal.
        }
      }, 2000);
      killer.unref?.();
      fail("timeout");
    }, timeoutMs);
    timer.unref?.();

    try {
      child = spawnImpl(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...opts.env },
      });
    } catch {
      fail("unavailable");
      return;
    }

    let stderrTail = "";
    child.stderr?.on("data", (buf: Buffer) => {
      stderrTail = `${stderrTail}${buf.toString()}`.slice(-2000);
    });
    child.stdout?.on("data", (buf: Buffer) => {
      buffer += buf.toString();
      if (buffer.length > 10 * 1024 * 1024) {
        fail("malformed");
        return;
      }
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        onLine(line);
        if (settled) return;
      }
    });
    child.on("error", () => fail("unavailable"));
    // A pipe error without a child 'error' event must not crash the process.
    child.stdin?.on("error", () => fail("unavailable"));
    child.on("close", (code) => {
      if (settled) return;
      // Exited before the read completed: auth hint in stderr ->
      // unauthenticated, anything else -> unavailable.
      if (code !== 0 && code !== null && AUTH_RE.test(stderrTail)) {
        fail("unauthenticated");
        return;
      }
      fail("unavailable");
    });

    const write = (chunk: string): boolean => {
      try {
        child?.stdin?.write(chunk);
        return true;
      } catch {
        return false;
      }
    };

    void (async () => {
      if (!write(readOnlyRequest(1, "initialize", { clientInfo: { ...CODEX_CLIENT_INFO } }))) {
        fail("unavailable");
        return;
      }
      const init = await new Promise<RpcResponse | null>((res) => {
        initResolve = res;
      });
      if (settled) return;
      if (!init || init.error) {
        fail(init?.error && errorLooksAuth(init.error) ? "unauthenticated" : "unavailable");
        return;
      }
      write(readOnlyNotification("initialized", {}));
      if (!write(readOnlyRequest(2, "account/rateLimits/read", {}))) {
        fail("unavailable");
        return;
      }
      const read = await new Promise<RpcResponse | null>((res) => {
        readResolve = res;
      });
      if (settled) return;
      if (!read) {
        fail("unavailable");
        return;
      }
      if (read.error) {
        if (errorLooksAuth(read.error)) fail("unauthenticated");
        else if (read.error.code === -32601) fail("unsupported");
        else fail("malformed");
        return;
      }
      let payload = read.result;
      if (
        payload &&
        typeof payload === "object" &&
        !("rateLimits" in (payload as Record<string, unknown>)) &&
        (payload as Record<string, unknown>).result !== undefined
      ) {
        payload = (payload as Record<string, unknown>).result;
      }
      finish({ payload, updates, failure: null });
    })();
  });
}

// ---------------------------------------------------------------------------
// Adapter + bounded refresh (shared capacity contract)
// ---------------------------------------------------------------------------

const SENTINEL_WINDOW_KEY = "codex_account_rate_limits";

/**
 * Adapter read result carrying the NOT-263 collapse metadata: aggregate
 * alias keys the fresh payload superseded. Older databases still hold those
 * rows (per-window upserts never delete siblings), so the refresh path
 * deletes them explicitly.
 */
export interface CodexAppServerReadResult extends AdapterReadResult {
  collapsedAggregateKeys: string[];
}

function unavailableResult(nowMs: number, reason: CapacityUnavailableReason): CodexAppServerReadResult {
  const reading: AdapterUnavailableReading = {
    windowKey: SENTINEL_WINDOW_KEY,
    providerBucket: "account",
    providerLabel: "account_rate_limits",
    reason,
    observedAt: new Date(nowMs).toISOString(),
  };
  return { runtime: CODEX_RUNTIME, windows: [], unavailable: [reading], collapsedAggregateKeys: [] };
}

/**
 * Operator-safe failure log: the static kind only, never server text, tokens,
 * or payloads.
 */
function logFailure(kind: FailureKind): void {
  console.error(`[codex-capacity] app-server read failed: ${kind}`);
}

function failureToUnavailable(nowMs: number, kind: FailureKind): CodexAppServerReadResult {
  logFailure(kind);
  switch (kind) {
    case "unsupported":
      return unavailableResult(nowMs, "unsupported");
    case "malformed":
      return unavailableResult(nowMs, "unparsable");
    case "unavailable":
    case "unauthenticated":
    case "timeout":
      return unavailableResult(nowMs, "missing");
  }
}

/** Evidence refs are static — the failure kind only, never tokens or payloads. */
export function codexEvidenceRef(kind: FailureKind | "read"): string {
  return `codex-app-server:${kind === "read" ? "account/rateLimits/read" : kind}`;
}

/**
 * One bounded, non-billable read of Codex account rate limits. Never throws:
 * every failure maps to an explicit unavailable reading, and this function
 * never touches `runtime_availability` (connection health stays separate).
 */
export async function readCodexAppServerCapacity(
  opts: CodexAppServerOptions = {}
): Promise<CodexAppServerReadResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const observedAt = new Date(nowMs).toISOString();
  let read: CodexRateLimitsRead;
  try {
    read = await readCodexRateLimits(opts);
  } catch {
    logFailure("unavailable");
    return unavailableResult(nowMs, "missing");
  }
  if (read.failure) return failureToUnavailable(nowMs, read.failure.kind);
  let parsed: CodexRateLimitsReadings | null = null;
  try {
    parsed = codexRateLimitsToReadings(read.payload, observedAt);
  } catch {
    parsed = null;
  }
  if (!parsed) {
    logFailure("malformed");
    return unavailableResult(nowMs, "unparsable");
  }
  const normalized = parsed.windows.map((w) => normalizeAdapterWindow(CODEX_RUNTIME, w, nowMs));
  const windows: AdapterWindowReading[] = [];
  const unavailable: AdapterUnavailableReading[] = [];
  for (let i = 0; i < parsed.windows.length; i++) {
    const n = normalized[i]!;
    if (n.unavailableReason !== null || n.remainingPercent === null) {
      unavailable.push({
        windowKey: n.windowKey,
        providerBucket: n.providerBucket,
        providerLabel: n.displayLabel,
        durationMinutes: n.durationMinutes,
        reason: "unparsable",
        observedAt: n.observedAt,
      });
    } else {
      const raw = parsed.windows[i]!;
      windows.push({
        ...raw,
        evidenceRef: codexEvidenceRef("read"),
      });
    }
  }
  if (windows.length === 0 && unavailable.length === 0) {
    logFailure("malformed");
    return unavailableResult(nowMs, "unparsable");
  }
  return {
    runtime: CODEX_RUNTIME,
    windows,
    unavailable,
    collapsedAggregateKeys: parsed.collapsedAggregateKeys,
  };
}

/** Live Codex adapter for the shared capacity service (runtime `codex_local`). */
export function createCodexAppServerAdapter(
  opts: CodexAppServerOptions = {}
): CapacityAdapter {
  return {
    runtime: CODEX_RUNTIME,
    source: "supported_protocol",
    read: (nowMs = Date.now()) => readCodexAppServerCapacity({ ...opts, nowMs }),
  };
}

/**
 * Bounded refresh: run the live adapter and ingest into normalized snapshots.
 * Reuses the shared ingest path; failures persist as N/A windows, never as
 * health rows. Imported lazily to keep the adapter module free of DB binds.
 *
 * A successful read deletes the failure sentinel plus any aggregate alias
 * keys the fresh payload collapsed (NOT-263): per-window upserts never
 * delete siblings, so without this the obsolete `codex_rate_limit_*`
 * duplicates from older versions would linger next to the surviving
 * detailed rows indefinitely.
 */
export async function refreshCodexCapacityFromAppServer(
  opts: CodexAppServerOptions = {}
): Promise<import("@agent-dealer/shared").RuntimeCapacityResponse> {
  const { ingestAdapterResult, getRuntimeCapacitySnapshot } = await import("./service.js");
  const nowMs = opts.nowMs ?? Date.now();
  const result = await readCodexAppServerCapacity({ ...opts, nowMs });
  await ingestAdapterResult(result);
  const obsolete = [...result.collapsedAggregateKeys];
  if (result.windows.length > 0) {
    // A successful read supersedes the failure sentinel: without this the
    // N/A row lingers next to fresh windows until its own TTL expires.
    obsolete.push(SENTINEL_WINDOW_KEY);
  }
  if (obsolete.length > 0) {
    const { deleteCapacitySnapshots } = await import("../repository/runtime-capacity.js");
    deleteCapacitySnapshots(CODEX_RUNTIME, obsolete);
  }
  return getRuntimeCapacitySnapshot(nowMs);
}

/**
 * On-demand bounded refresh for runtimes without a scheduler: when
 * `codex_local` is a configured runtime account and its stored snapshot is
 * missing or older than the stale window, run one bounded non-billable read
 * and ingest it, then return. Fresh snapshots short-circuit with no
 * subprocess. Concurrent callers share one in-flight refresh
 * (single-flight); failures resolve to the stored snapshot — this helper
 * never throws, never touches runtime health, and never sends credentials.
 * Set `AGENT_DEALER_CODEX_CAPACITY_REFRESH=off` to disable the refresh.
 */
let codexStaleRefreshInFlight: Promise<unknown> | null = null;

export async function refreshCodexCapacityIfStale(
  nowMs = Date.now(),
  opts: CodexAppServerOptions = {}
): Promise<void> {
  if (process.env.AGENT_DEALER_CODEX_CAPACITY_REFRESH === "off") return;
  const [{ configuredCapacityRuntimes }, { listCapacitySnapshots }, adapter] = await Promise.all([
    import("./service.js"),
    import("../repository/runtime-capacity.js"),
    import("./adapter.js"),
  ]);
  if (!configuredCapacityRuntimes().includes(CODEX_RUNTIME)) return;
  const rows = listCapacitySnapshots(CODEX_RUNTIME);
  const newestObserved = rows.reduce<number | null>((max, row) => {
    const ms = Date.parse(row.observedAt);
    if (!Number.isFinite(ms)) return max;
    return max === null || ms > max ? ms : max;
  }, null);
  if (
    newestObserved !== null &&
    newestObserved + adapter.DEFAULT_STALE_AFTER_MS > nowMs
  ) {
    return;
  }
  if (codexStaleRefreshInFlight) {
    await codexStaleRefreshInFlight;
    return;
  }
  const run = refreshCodexCapacityFromAppServer({ ...opts, nowMs }).catch(() => undefined);
  codexStaleRefreshInFlight = run;
  try {
    await run;
  } finally {
    if (codexStaleRefreshInFlight === run) codexStaleRefreshInFlight = null;
  }
}

/** Normalize one unavailable Codex reading for direct persistence (tests/tools). */
export function normalizeCodexUnavailable(
  reason: CapacityUnavailableReason,
  nowMs = Date.now()
): ReturnType<typeof normalizeUnavailableWindow> {
  return normalizeUnavailableWindow(
    CODEX_RUNTIME,
    {
      windowKey: SENTINEL_WINDOW_KEY,
      providerBucket: "account",
      providerLabel: "account_rate_limits",
      reason,
      observedAt: new Date(nowMs).toISOString(),
    },
    nowMs
  );
}
