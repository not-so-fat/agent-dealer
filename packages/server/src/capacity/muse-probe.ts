// packages/server/src/capacity/muse-probe.ts
//
// Reliable Muse 5H/1W fallback. Muse's stable protocol only exposes
// subscription capacity after the same `muse serve` process has observed
// real provider traffic. A read-only poll, session resume, or exec log cannot
// populate it (NOT-269). When the free sources have no complete current pair
// for one hour, this module runs one tiny bounded turn on a dedicated owned
// host, then performs `usage/read` on that exact host.
//
// The fallback is default-on and can be disabled with
// `AGENT_DEALER_MUSE_CAPACITY_REFRESH=off`. It is single-flight, attempted at
// most once per hour, and backs off 1h -> 2h -> 4h -> 8h after failures. The
// host disables shell and workspace writes and keeps restricted network;
// Muse 1.4's serve protocol has no per-turn max-step or disable-web-tools
// switch, so the fixed one-word prompt plus wall-clock cancellation is the
// tightest supported bound. No transcript, prompt, credential, or account
// payload is logged.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MUSE_CODE_CONTRIBUTOR_MODEL } from "@agent-dealer/shared";
import { getDataDir } from "../db/index.js";
import { listCapacitySnapshots } from "../repository/runtime-capacity.js";
import { runMuseServeTurn } from "../runners/muse-serve-session.js";
import { configuredCapacityRuntimes } from "./service.js";
import {
  maybeRefreshMuseCapacityFromHost,
  MuseCapacityHost,
  type MuseHostOptions,
} from "./muse-host.js";
import { MUSE_RUNTIME } from "./muse.js";

export const MUSE_CAPACITY_REFRESH_ENV = "AGENT_DEALER_MUSE_CAPACITY_REFRESH";
export const MUSE_CAPACITY_REFRESH_PAID_VALUE = "paid-after-1h";
export const MUSE_CAPACITY_REFRESH_OFF_VALUE = "off";
export const MUSE_CAPACITY_PROBE_TIMEOUT_ENV = "AGENT_DEALER_MUSE_CAPACITY_PROBE_TIMEOUT_MS";
export const MUSE_CAPACITY_PROBE_TIMEOUT_MS_DEFAULT = 60_000;
export const MUSE_CAPACITY_PROBE_STALE_AFTER_MS = 60 * 60 * 1000;
export const MUSE_CAPACITY_PROBE_ATTEMPT_COOLDOWN_MS = 60 * 60 * 1000;
export const MUSE_CAPACITY_PROBE_BACKOFF_CAP_MS = 8 * 60 * 60 * 1000;
export const MUSE_CAPACITY_PROBE_PROMPT = "Reply with exactly: OK";
export const MUSE_CAPACITY_PROBE_SERVE_ARGV = [
  "serve",
  "--sandbox-network",
  "restricted",
  "--disable-write",
  "--disable-shell",
] as const;

export type MuseProbeFailureKind =
  | "unadmitted"
  | "turn_failed"
  | "no_windows"
  | "timeout"
  | "exception";

export interface MuseProbeResult {
  ok: boolean;
  admitted: boolean;
  terminal: "completed" | "failed" | "cancelled" | null;
  failureKind: MuseProbeFailureKind | null;
  windowsUpdated: string[];
  durationMs: number;
}

export type MuseProbeSkipReason = "disabled" | "unconfigured" | "fresh" | "backoff" | "error";

export interface MuseProbeGateOutcome {
  probed: boolean;
  reason: MuseProbeSkipReason | "shared" | "completed";
  ok?: boolean;
  failureKind?: MuseProbeFailureKind | null;
  windowsUpdated?: string[];
}

export interface MuseProbeOptions {
  /** Inject a fake/already-created host in tests. Production creates a
   * dedicated restricted host and always shuts it down. */
  host?: MuseCapacityHost;
  hostOptions?: MuseHostOptions;
  timeoutMs?: number;
}

export function isMusePaidFallbackEnabled(): boolean {
  const setting = process.env[MUSE_CAPACITY_REFRESH_ENV];
  if (setting === MUSE_CAPACITY_REFRESH_PAID_VALUE) return true;
  if (setting !== undefined && setting !== "") return false;
  // Backward compatibility: this older switch used to disable every Muse
  // capacity refresh. Do not turn an existing no-refresh deployment into a
  // spender on upgrade. An explicit paid-after-1h above may override it.
  if (process.env.AGENT_DEALER_MUSE_CAPACITY_REFRESH_MS === "off") return false;
  return true;
}

export function museCapacityProbeTimeoutMs(): number {
  const raw = process.env[MUSE_CAPACITY_PROBE_TIMEOUT_ENV];
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return MUSE_CAPACITY_PROBE_TIMEOUT_MS_DEFAULT;
}

function validRoleObservedAtMs(
  role: "five_hour" | "weekly",
  nowMs: number
): number | null {
  const row = listCapacitySnapshots(MUSE_RUNTIME).find((w) => w.criticalRole === role);
  if (!row || row.remainingPercent === null || row.unavailableReason !== null || row.source === "unavailable") {
    return null;
  }
  const observedMs = Date.parse(row.observedAt);
  if (!Number.isFinite(observedMs) || observedMs > nowMs) return null;
  if (row.resetAt !== null) {
    const resetMs = Date.parse(row.resetAt);
    if (!Number.isFinite(resetMs) || resetMs <= nowMs) return null;
  }
  return observedMs;
}

/** Both halves must be valid and under one hour old. A fresh 5H window may
 * never hide a missing/stale 1W sibling (or vice versa). */
export function hasFreshMuseCapacityPair(nowMs = Date.now()): boolean {
  const fiveHour = validRoleObservedAtMs("five_hour", nowMs);
  const weekly = validRoleObservedAtMs("weekly", nowMs);
  return (
    fiveHour !== null &&
    weekly !== null &&
    nowMs - fiveHour < MUSE_CAPACITY_PROBE_STALE_AFTER_MS &&
    nowMs - weekly < MUSE_CAPACITY_PROBE_STALE_AFTER_MS
  );
}

function museProbeDiagnosticLogPath(): string {
  return path.join(getDataDir(), "capacity", "muse-probe.log");
}

function appendMuseProbeDiagnostic(nowMs: number, result: MuseProbeResult): void {
  try {
    const file = museProbeDiagnosticLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(
      file,
      `${JSON.stringify({
        ts: new Date(nowMs).toISOString(),
        event: "muse_capacity_probe",
        trigger: "stale_60m",
        model: MUSE_CODE_CONTRIBUTOR_MODEL,
        ...result,
      })}\n`
    );
  } catch {
    // Diagnostics are advisory; capacity refresh must never fail on logging.
  }
}

/** One bounded real turn followed by a read on the same restricted host. */
export async function runMuseCapacityProbe(
  nowMs = Date.now(),
  opts: MuseProbeOptions = {}
): Promise<MuseProbeResult> {
  const startedRealMs = Date.now();
  const timeoutMs = opts.timeoutMs ?? museCapacityProbeTimeoutMs();
  const ownsHost = opts.host === undefined;
  const host =
    opts.host ??
    new MuseCapacityHost({
      ...opts.hostOptions,
      args: opts.hostOptions?.args ?? [...MUSE_CAPACITY_PROBE_SERVE_ARGV],
      timeoutMs: Math.min(opts.hostOptions?.timeoutMs ?? timeoutMs, timeoutMs),
    });
  let result: MuseProbeResult;
  try {
    const turn = await runMuseServeTurn({
      host,
      prompt: MUSE_CAPACITY_PROBE_PROMPT,
      model: MUSE_CODE_CONTRIBUTOR_MODEL,
      cwd: os.tmpdir(),
      timeoutMs,
      rpcTimeoutMs: Math.min(15_000, timeoutMs),
    });
    if (!turn.admitted) {
      result = {
        ok: false,
        admitted: false,
        terminal: null,
        failureKind: "unadmitted",
        windowsUpdated: [],
        durationMs: Date.now() - startedRealMs,
      };
    } else {
      await host.readUsage();
      const checkNowMs = Math.max(nowMs, Date.now());
      const ok = hasFreshMuseCapacityPair(checkNowMs);
      result = {
        ok,
        admitted: true,
        terminal: turn.terminal,
        failureKind: ok
          ? null
          : turn.timedOut
            ? "timeout"
            : turn.failure !== null
              ? "turn_failed"
              : "no_windows",
        windowsUpdated: ok ? ["rolling_all_models", "weekly_all_models"] : [],
        durationMs: Date.now() - startedRealMs,
      };
    }
  } catch {
    result = {
      ok: false,
      admitted: false,
      terminal: null,
      failureKind: "exception",
      windowsUpdated: [],
      durationMs: Date.now() - startedRealMs,
    };
  } finally {
    if (ownsHost) await host.shutdown().catch(() => undefined);
  }
  appendMuseProbeDiagnostic(nowMs, result);
  const outcome = result.ok ? "ok" : `failed: ${result.failureKind ?? "unknown"}`;
  console.error(`[muse-capacity] fallback ${outcome}`);
  return result;
}

let museProbeInFlight: Promise<MuseProbeResult> | null = null;
let lastMuseProbeAttemptMs = 0;
let consecutiveMuseProbeFailures = 0;

function museProbeCooldownMs(): number {
  const shift = Math.min(consecutiveMuseProbeFailures, 3);
  return Math.min(
    MUSE_CAPACITY_PROBE_ATTEMPT_COOLDOWN_MS * 2 ** shift,
    MUSE_CAPACITY_PROBE_BACKOFF_CAP_MS
  );
}

export function resetMuseCapacityProbeStateForTests(): void {
  museProbeInFlight = null;
  lastMuseProbeAttemptMs = 0;
  consecutiveMuseProbeFailures = 0;
}

export async function maybeProbeMuseCapacity(
  nowMs = Date.now(),
  opts: MuseProbeOptions = {}
): Promise<MuseProbeGateOutcome> {
  try {
    if (!isMusePaidFallbackEnabled()) return { probed: false, reason: "disabled" };
    if (!configuredCapacityRuntimes().includes(MUSE_RUNTIME)) {
      return { probed: false, reason: "unconfigured" };
    }
    if (hasFreshMuseCapacityPair(nowMs)) return { probed: false, reason: "fresh" };
    if (museProbeInFlight) {
      const shared = await museProbeInFlight;
      return {
        probed: true,
        reason: "shared",
        ok: shared.ok,
        failureKind: shared.failureKind,
        windowsUpdated: shared.windowsUpdated,
      };
    }
    if (nowMs - lastMuseProbeAttemptMs < museProbeCooldownMs()) {
      return { probed: false, reason: "backoff" };
    }
    lastMuseProbeAttemptMs = nowMs;
    const run = runMuseCapacityProbe(nowMs, opts);
    museProbeInFlight = run;
    try {
      const result = await run;
      consecutiveMuseProbeFailures = result.ok ? 0 : consecutiveMuseProbeFailures + 1;
      return {
        probed: true,
        reason: "completed",
        ok: result.ok,
        failureKind: result.failureKind,
        windowsUpdated: result.windowsUpdated,
      };
    } finally {
      if (museProbeInFlight === run) museProbeInFlight = null;
    }
  } catch {
    return { probed: false, reason: "error" };
  }
}

/** Free read first; only a still-missing/stale complete pair reaches the
 * bounded paid fallback. Route callers run this in the background. */
export async function refreshMuseCapacityIfStale(
  nowMs = Date.now(),
  opts: MuseProbeOptions = {}
): Promise<MuseProbeGateOutcome> {
  if (!configuredCapacityRuntimes().includes(MUSE_RUNTIME)) {
    return { probed: false, reason: "unconfigured" };
  }
  try {
    await maybeRefreshMuseCapacityFromHost({}, nowMs);
  } catch {
    // The paid gate below still decides from durable last-good rows.
  }
  return maybeProbeMuseCapacity(nowMs, opts);
}
