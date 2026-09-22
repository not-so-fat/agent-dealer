// packages/server/src/capacity/muse.ts
//
// NOT-247: Muse Code capacity adapter — read stable MSP usage windows.
//
// Reads observed capacity through the versioned `muse serve` Session Protocol
// (MSP 1.3) without sending a prompt and without consuming model tokens: a
// single `usage/read` JSON-RPC request over a one-shot managed `muse serve`
// stdio connection, then shutdown. `usage/changed` notifications received
// while the connection is alive are recorded. The client enforces a read-only
// allowlist (`usage/read`) — any other method throws before it is written, so
// polling can never start a session, send a prompt, or run model work. It
// never touches the Keychain or undocumented endpoints.
//
// MSP 1.3 `usage/read` shape (per the contract):
//   result: {
//     protocol: "msp/1.3",
//     usage?: {
//       observedAtMs: number,
//       tier: string,                       // dropped: never persisted, never served
//       rolling?: { usedPercent, resetsAtMs, windowDurationMins },
//       weekly?: { usedPercent, resetsAtMs }
//     }
//   }
// `usage` may be omitted when Muse has no observation — preserved as N/A
// (`missing`). The rolling label is derived from `windowDurationMins` by the
// shared normalization, never hardcoded.
//
// Failure semantics (shared CapacityUnavailableReason enum only):
// - No credential (no META_API_KEY and no login file) / `usage` omitted /
//   unauthenticated / spawn error / bad exit / timeout -> `missing`
//   (supported surface, no snapshot recorded).
// - Malformed payload -> `unparsable`.
// - `muse` binary unavailable (ENOENT) or server without the method
//   (-32601) -> `unsupported` (no capacity surface at all).
// Failures never throw out of read(), never touch `runtime_availability`
// (NOT-111 health stays separate), and never log tokens or raw payloads: the
// adapter passes no credentials (the serve subprocess uses its ambient
// session) and evidence refs are static strings.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import type { CapacityUnavailableReason, Runtime } from "@agent-dealer/shared";
import { MUSE_CLI_ENV, resolveMuseAuthFile, resolveMuseBin } from "../cli-env.js";
import {
  normalizeAdapterWindow,
  normalizeUnavailableWindow,
  type AdapterReadResult,
  type AdapterUnavailableReading,
  type AdapterWindowReading,
  type CapacityAdapter,
} from "./adapter.js";

export const MUSE_RUNTIME: Runtime = "muse_code";

/** Methods this client may ever send. Anything else throws before write. */
export const MSP_READ_ONLY_METHODS = ["usage/read"] as const;
export type MspReadOnlyMethod = (typeof MSP_READ_ONLY_METHODS)[number];

/** Notification the client records (never sends) while connected. */
export const MSP_USAGE_CHANGED = "usage/changed";

/** Methods that would start billable model work — never sent, asserted in tests. */
export const MSP_FORBIDDEN_MODEL_METHODS = [
  "session/start",
  "session/prompt",
  "session/resume",
  "exec",
] as const;

export function assertMuseReadOnlyMethod(method: string): asserts method is MspReadOnlyMethod {
  if (!(MSP_READ_ONLY_METHODS as readonly string[]).includes(method)) {
    throw new Error(`muse-serve: refusing non-read method ${method}`);
  }
}

function readOnlyRequest(id: string, method: MspReadOnlyMethod, params: unknown): string {
  assertMuseReadOnlyMethod(method);
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

/**
 * Versioned Session Protocol argv. Fixed: capacity reads never `exec`.
 *
 * Caveat: this argv and the handshake-free single `usage/read` below were
 * built from the ticket contract brief — the official Muse Code docs were
 * unreachable at implementation time, so they are unverified against the
 * published MSP surface. The committed fake (`fixtures/fake-muse-serve.mjs`)
 * likewise enforces no handshake, so tests cannot catch a handshake
 * requirement either. If a live `muse serve` demands an `initialize` step,
 * the read-only allowlist will reject it and every live read will fail
 * closed as `missing`/`unparsable` (never billed); re-check the argv against
 * the docs before debugging any live failure.
 */
export const MUSE_SERVE_ARGV: readonly string[] = ["serve", "--protocol", "msp/1.3"];

/** Single JSON-RPC request id for the one-shot read. */
export const MSP_USAGE_READ_ID = "muse-capacity-1";

/** Weekly windows carry no duration in MSP 1.3; a week in minutes. */
export const MUSE_WEEKLY_DURATION_MINUTES = 10080;

// ---------------------------------------------------------------------------
// Payload normalization
// ---------------------------------------------------------------------------

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** resetsAtMs arrives as epoch ms (epoch seconds and ISO-8601 also accepted). */
export function normalizeMuseResetsAt(value: unknown): string | null {
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
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return normalizeMuseResetsAt(Number(trimmed));
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}

function windowReadingFromEntry(
  kind: "rolling" | "weekly",
  entry: unknown,
  observedAt: string
): AdapterWindowReading | null {
  if (!entry || typeof entry !== "object") return null;
  const w = entry as Record<string, unknown>;
  const usedPercent = asFiniteNumber(w.usedPercent);
  if (usedPercent === null) return null;
  const resetAt = normalizeMuseResetsAt(w.resetsAtMs);
  if (resetAt === null) return null;
  const durationRaw = kind === "rolling" ? asFiniteNumber(w.windowDurationMins) : null;
  return {
    windowKey: kind === "rolling" ? "rolling_all_models" : "weekly_all_models",
    providerBucket: "all_models",
    durationMinutes:
      durationRaw !== null && durationRaw > 0
        ? Math.round(durationRaw)
        : kind === "weekly"
          ? MUSE_WEEKLY_DURATION_MINUTES
          : null,
    providerLabel: kind,
    usedValue: usedPercent,
    usedUnit: "percent",
    usedPercent,
    resetAt,
    observedAt,
    source: "supported_protocol",
  };
}

export interface MuseUsageReadings {
  windows: AdapterWindowReading[];
}

/**
 * Extract the `usage` object from a `usage/read` result. Bare usage objects
 * (no envelope) are tolerated. An envelope with no `usage` key and no
 * usage-like keys carries no observation (null, not an error); anything else
 * that is not a usage object is malformed.
 */
function extractUsageObject(payload: unknown): { usage?: Record<string, unknown>; error?: string } {
  if (!payload || typeof payload !== "object") return { error: "result is not an object" };
  const result = payload as Record<string, unknown>;
  if ("usage" in result) {
    const usage = result.usage;
    if (usage === undefined || usage === null) return {};
    if (typeof usage !== "object" || Array.isArray(usage)) return { error: "usage is not an object" };
    return { usage: usage as Record<string, unknown> };
  }
  if ("observedAtMs" in result || "rolling" in result || "weekly" in result) {
    return { usage: result };
  }
  const keys = Object.keys(result);
  if (keys.length === 0 || (keys.length === 1 && keys[0] === "protocol")) return {};
  return { error: "result carries no usage observation" };
}

/**
 * Normalize MSP 1.3 `usage` into adapter readings. Returns null when the
 * payload carries no observation or is malformed (callers needing the
 * distinction check the payload shape first). Entries that are individually
 * malformed are skipped — the caller re-reports present-but-bad keys as
 * per-window `unparsable` readings so a bad sibling never sinks a good
 * window.
 */
export function museUsageToReadings(
  payload: unknown,
  observedAt = new Date().toISOString()
): MuseUsageReadings | null {
  const { usage, error } = extractUsageObject(payload);
  if (error !== undefined || usage === undefined) return null;
  const u = usage;
  const hasRolling = u.rolling !== undefined;
  const hasWeekly = u.weekly !== undefined;
  const observedAtMs =
    typeof u.observedAtMs === "number" && Number.isFinite(u.observedAtMs) ? u.observedAtMs : null;
  const observed = observedAtMs !== null ? new Date(observedAtMs).toISOString() : observedAt;
  const out: AdapterWindowReading[] = [];
  if (hasRolling) {
    const rolling = windowReadingFromEntry("rolling", u.rolling, observed);
    if (rolling) out.push(rolling);
  }
  if (hasWeekly) {
    const weekly = windowReadingFromEntry("weekly", u.weekly, observed);
    if (weekly) out.push(weekly);
  }
  return { windows: out };
}

/**
 * Keys present in `usage` but malformed — each becomes a per-window
 * `unparsable` sibling instead of sinking the whole observation.
 */
export function museBadWindowKinds(payload: unknown): Array<"rolling" | "weekly"> {
  const { usage, error } = extractUsageObject(payload);
  if (error !== undefined || usage === undefined) return [];
  const u = usage;
  const bad: Array<"rolling" | "weekly"> = [];
  for (const kind of ["rolling", "weekly"] as const) {
    if (u[kind] === undefined) continue;
    const probe = windowReadingFromEntry(kind, u[kind], new Date().toISOString());
    if (!probe) bad.push(kind);
  }
  return bad;
}

// ---------------------------------------------------------------------------
// JSON-RPC subprocess client (bounded, read-only)
// ---------------------------------------------------------------------------

export interface MuseServeOptions {
  /** Binary to spawn. Defaults to the resolved `muse` CLI. */
  command?: string;
  /** Args for the binary. Defaults to the versioned serve argv. */
  args?: string[];
  /** Extra env for the subprocess (merged over process.env). */
  env?: NodeJS.ProcessEnv;
  /** Overall bound in ms (default 15s, env AGENT_DEALER_MUSE_CAPACITY_TIMEOUT_MS). */
  timeoutMs?: number;
  nowMs?: number;
  /** Muse login file (existence only, never read). Defaults to resolveMuseAuthFile(). */
  authFilePath?: string;
}

export function museCapacityTimeoutMs(): number {
  const raw = process.env.AGENT_DEALER_MUSE_CAPACITY_TIMEOUT_MS;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 15_000;
}

type FailureKind = "unavailable" | "unauthenticated" | "timeout" | "malformed" | "unsupported";

const AUTH_RE =
  /login is no longer valid|authentication failed|missing \w+ credentials|api key .*rejected|unauthenticated|unauthorized|unauthori[sz]ed|not (signed|logged) in|sign in|\b401\b|\b403\b|forbidden/i;

export interface MuseUsageRead {
  payload: unknown;
  /** Parsed `usage/changed` bodies seen while connected (usually 0). */
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
  const e = error as { code?: unknown; message?: unknown };
  return AUTH_RE.test(String(e.message ?? "")) || e.code === 401 || e.code === 403;
}

/** The only credential signals the repo knows (cf. agent-health): env key or login file. */
function hasMuseCredential(env: NodeJS.ProcessEnv, authFilePath: string): boolean {
  const key = env.META_API_KEY;
  if (typeof key === "string" && key.length > 0) return true;
  try {
    return fs.existsSync(authFilePath);
  } catch {
    return false;
  }
}

/**
 * Spawn `muse serve`, send one `usage/read`, record any `usage/changed`
 * notifications, then shut the connection down. Never throws for
 * provider-side failures — those come back as `failure.kind`. Never sends
 * anything outside MSP_READ_ONLY_METHODS.
 */
export function requestMuseUsage(opts: MuseServeOptions = {}): Promise<MuseUsageRead> {
  const command = opts.command ?? resolveMuseBin();
  const args = opts.args ?? [...MUSE_SERVE_ARGV];
  const timeoutMs = opts.timeoutMs ?? museCapacityTimeoutMs();
  const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
  return new Promise((resolve) => {
    if (!hasMuseCredential(mergedEnv, opts.authFilePath ?? resolveMuseAuthFile())) {
      resolve({ payload: null, updates: [], failure: { kind: "unauthenticated" } });
      return;
    }
    const updates: unknown[] = [];
    let settled = false;
    let child: ChildProcess | undefined;
    let buffer = "";
    let readResolve: ((r: RpcResponse) => void) | null = null;

    const finish = (out: MuseUsageRead) => {
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
        if (msg.method === MSP_USAGE_CHANGED) updates.push(msg.params ?? null);
        return;
      }
      if (msg.id === MSP_USAGE_READ_ID && readResolve) {
        const cb = readResolve;
        readResolve = null;
        cb(msg);
      }
    };

    const timer = setTimeout(() => fail("timeout"), timeoutMs);
    timer.unref?.();

    try {
      child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...mergedEnv, ...MUSE_CLI_ENV },
      });
    } catch (err) {
      fail((err as NodeJS.ErrnoException)?.code === "ENOENT" ? "unsupported" : "unavailable");
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
    child.on("error", (err) => {
      fail((err as NodeJS.ErrnoException)?.code === "ENOENT" ? "unsupported" : "unavailable");
    });
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
      if (!write(readOnlyRequest(MSP_USAGE_READ_ID, "usage/read", {}))) {
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
        !("usage" in (payload as Record<string, unknown>)) &&
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

const SENTINEL_WINDOW_KEY = "muse_account_usage";

function unavailableResult(nowMs: number, reason: CapacityUnavailableReason): AdapterReadResult {
  const reading: AdapterUnavailableReading = {
    windowKey: SENTINEL_WINDOW_KEY,
    providerBucket: "account",
    providerLabel: "account_usage",
    reason,
    observedAt: new Date(nowMs).toISOString(),
  };
  return { runtime: MUSE_RUNTIME, windows: [], unavailable: [reading] };
}

/**
 * Operator-safe failure log: the static kind only, never server text, tokens,
 * or payloads.
 */
function logFailure(kind: FailureKind): void {
  console.error(`[muse-capacity] serve read failed: ${kind}`);
}

function failureToUnavailable(nowMs: number, kind: FailureKind): AdapterReadResult {
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
export function museEvidenceRef(kind: FailureKind | "read"): string {
  return `muse-serve:${kind === "read" ? "usage/read" : kind}`;
}

/**
 * One bounded, non-billable read of Muse account usage. Never throws:
 * every failure maps to an explicit unavailable reading, and this function
 * never touches `runtime_availability` (connection health stays separate).
 */
export async function readMuseCapacity(opts: MuseServeOptions = {}): Promise<AdapterReadResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const observedAt = new Date(nowMs).toISOString();
  let read: MuseUsageRead;
  try {
    read = await requestMuseUsage(opts);
  } catch {
    logFailure("unavailable");
    return unavailableResult(nowMs, "missing");
  }
  if (read.failure) return failureToUnavailable(nowMs, read.failure.kind);
  const extracted = extractUsageObject(read.payload);
  if (extracted.error !== undefined) {
    logFailure("malformed");
    return unavailableResult(nowMs, "unparsable");
  }
  if (extracted.usage === undefined) {
    // No observation in the payload — N/A (`missing`), not a bad payload.
    return unavailableResult(nowMs, "missing");
  }
  let parsed: MuseUsageReadings | null = null;
  try {
    parsed = museUsageToReadings(read.payload, observedAt);
  } catch {
    parsed = null;
  }
  if (!parsed) {
    logFailure("malformed");
    return unavailableResult(nowMs, "unparsable");
  }
  const normalized = parsed.windows.map((w) => normalizeAdapterWindow(MUSE_RUNTIME, w, nowMs));
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
        evidenceRef: museEvidenceRef("read"),
      });
    }
  }
  for (const kind of museBadWindowKinds(read.payload)) {
    if (windows.some((w) => w.windowKey.startsWith(kind)) || unavailable.some((u) => u.windowKey.startsWith(kind))) {
      continue;
    }
    unavailable.push({
      windowKey: kind === "rolling" ? "rolling_all_models" : "weekly_all_models",
      providerBucket: "all_models",
      providerLabel: kind,
      durationMinutes: kind === "weekly" ? MUSE_WEEKLY_DURATION_MINUTES : null,
      reason: "unparsable",
      observedAt,
    });
  }
  if (windows.length === 0 && unavailable.length === 0) {
    // Usage carried no window keys at all — no observation (`missing`).
    return unavailableResult(nowMs, "missing");
  }
  return { runtime: MUSE_RUNTIME, windows, unavailable };
}

/** Live Muse adapter for the shared capacity service (runtime `muse_code`). */
export function createMuseCapacityAdapter(opts: MuseServeOptions = {}): CapacityAdapter {
  return {
    runtime: MUSE_RUNTIME,
    source: "supported_protocol",
    read: (nowMs = Date.now()) => readMuseCapacity({ ...opts, nowMs }),
  };
}

/**
 * Bounded refresh: run the live adapter and ingest into normalized snapshots.
 * Reuses the shared ingest path; failures persist as N/A windows, never as
 * health rows. Imported lazily to keep the adapter module free of DB binds.
 *
 * A successful read (real windows) deletes the failure sentinel
 * (`muse_account_usage`): snapshot writes are per-window upserts that never
 * delete siblings, so without this a stale N/A sentinel would linger next to
 * the recovered windows indefinitely.
 */
export async function refreshMuseCapacityFromServe(
  opts: MuseServeOptions = {}
): Promise<import("@agent-dealer/shared").RuntimeCapacityResponse> {
  const { ingestAdapterResult, getRuntimeCapacitySnapshot } = await import("./service.js");
  const { deleteCapacitySnapshots } = await import("../repository/runtime-capacity.js");
  const nowMs = opts.nowMs ?? Date.now();
  const result = await readMuseCapacity({ ...opts, nowMs });
  await ingestAdapterResult(result);
  if (result.windows.length > 0) {
    deleteCapacitySnapshots(MUSE_RUNTIME, [SENTINEL_WINDOW_KEY]);
  }
  return getRuntimeCapacitySnapshot(nowMs);
}

/** Default minimum gap between production Muse refreshes (5 minutes). */
export const MUSE_REFRESH_THROTTLE_MS_DEFAULT = 5 * 60 * 1000;

/**
 * Throttle bound for production refreshes. Override with
 * `AGENT_DEALER_MUSE_CAPACITY_REFRESH_MS` (milliseconds); `off` disables
 * refresh entirely. Non-positive or unparsable values fall back to the default.
 */
export function museRefreshThrottleMs(): number {
  const raw = process.env.AGENT_DEALER_MUSE_CAPACITY_REFRESH_MS;
  if (raw === undefined || raw === "") return MUSE_REFRESH_THROTTLE_MS_DEFAULT;
  if (raw === "off") return Number.POSITIVE_INFINITY;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  return MUSE_REFRESH_THROTTLE_MS_DEFAULT;
}

let lastMuseRefreshMs = 0;

/** Test helper — reset the refresh throttle so the next refresh runs. */
export function resetMuseCapacityRefreshState(): void {
  lastMuseRefreshMs = 0;
}

/**
 * Production trigger for the Muse adapter: throttled, bounded, best-effort.
 * Returns the refreshed snapshot, or null when throttled/disabled. Never
 * throws — a failed refresh persists as N/A through the shared ingest path,
 * and any unexpected error resolves to null so callers (routes) can still
 * serve the last-known snapshot.
 */
export async function maybeRefreshMuseCapacityFromServe(
  opts: MuseServeOptions = {},
  nowMs = Date.now()
): Promise<import("@agent-dealer/shared").RuntimeCapacityResponse | null> {
  const throttle = museRefreshThrottleMs();
  if (!Number.isFinite(throttle) || nowMs - lastMuseRefreshMs < throttle) return null;
  lastMuseRefreshMs = nowMs;
  try {
    return await refreshMuseCapacityFromServe({ ...opts, nowMs });
  } catch {
    return null;
  }
}

/** Normalize one unavailable Muse reading for direct persistence (tests/tools). */
export function normalizeMuseUnavailable(
  reason: CapacityUnavailableReason,
  nowMs = Date.now()
): ReturnType<typeof normalizeUnavailableWindow> {
  return normalizeUnavailableWindow(
    MUSE_RUNTIME,
    {
      windowKey: SENTINEL_WINDOW_KEY,
      providerBucket: "account",
      providerLabel: "account_usage",
      reason,
      observedAt: new Date(nowMs).toISOString(),
    },
    nowMs
  );
}
