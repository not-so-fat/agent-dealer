// packages/server/src/runners/usage-cap.ts
//
// NOT-111: detect hard usage-cap signals from CLI NDJSON logs and persist runtime_availability.
// NOT-117: Cursor/Codex text fallback must not scan assistant/tool file contents (false
// positives like "infra-attempt limit reached" in source); successful sessions never open a
// deferral from body text alone.

import fs from "node:fs";
import type { Runtime } from "@agent-dealer/shared";
import { usageCapFallbackCooldownMs } from "../coordinator/usage-cap-config.js";
import { recordRuntimeAvailability } from "../repository/runtime-availability.js";
import { parseCodexJsonl } from "./codex-jsonl.js";
import { parseNdjson } from "./stream-json.js";

type StreamEvent = Record<string, unknown>;

export interface UsageCapDetection {
  unavailableUntil: string;
  reason: string;
  evidence: Record<string, unknown>;
}

/** Structured / result-error prose — no bare "limit reached" (NOT-117). */
const CAP_ERROR_RE =
  /\b(rate\s*limit(?:ed)?|usage\s*limit|quota\s*exceeded|billing_error|subscription\s*limit)\b/i;

/**
 * Text-only fallback (stderr / error result). Requires rate|usage|quota|subscription
 * near "limit", or an explicit billing/quota phrase — never bare "limit reached".
 */
const CAP_FALLBACK_RE =
  /\b((?:rate|usage|quota|subscription)\s+limits?(?:\s+\w+){0,4}\s+reached|(?:rate|usage)\s*limit(?:ed)?|quota\s+exceeded|billing_error|subscription\s+limit)\b/i;

function parseResetsAt(raw: unknown): Date | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const ms = raw > 1e12 ? raw : raw * 1000;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d : null;
}

function fallbackUntil(nowMs = Date.now()): string {
  return new Date(nowMs + usageCapFallbackCooldownMs()).toISOString();
}

function capReason(runtime: Runtime, detail: string): string {
  return `${runtime} usage capped — ${detail}`;
}

// `status` is the verdict on the plan window. `overageStatus` only says whether pay-as-you-go
// overage is available: orgs with overage disabled report "rejected" on every event of a healthy
// session (status "allowed", isUsingOverage false), so it must not open a deferral by itself.
function isHardCapRateLimitInfo(info: Record<string, unknown>): boolean {
  return info.status === "rejected";
}

function signalFromRateLimitInfo(
  runtime: Runtime,
  info: Record<string, unknown>,
  evidence: Record<string, unknown>,
  nowMs: number
): UsageCapDetection | null {
  if (!isHardCapRateLimitInfo(info)) return null;
  const reset =
    parseResetsAt(info.resetsAt) ??
    parseResetsAt(info.overageResetsAt) ??
    parseResetsAt(info.overage_resets_at) ??
    parseResetsAt(info.resets_at);
  const unavailableUntil = reset && reset.getTime() > nowMs ? reset.toISOString() : fallbackUntil(nowMs);
  const limitType = String(info.rateLimitType ?? info.rate_limit_type ?? "plan");
  return {
    unavailableUntil,
    reason: capReason(runtime, `${limitType} limit rejected`),
    evidence: { ...evidence, rate_limit_info: info },
  };
}

function signalFromApiRetry(e: StreamEvent, runtime: Runtime, nowMs: number): UsageCapDetection | null {
  if (e.type !== "system") return null;
  const subtype = String(e.subtype ?? "");
  if (subtype !== "api_retry" && subtype !== "error") return null;
  const err = String((e as { error?: unknown }).error ?? "");
  // Hard cap only — transient api_retry rate_limit is not an account cap (NOT-111).
  if (err !== "billing_error") return null;
  return {
    unavailableUntil: fallbackUntil(nowMs),
    reason: capReason(runtime, err.replace("_", " ")),
    evidence: { event: e },
  };
}

function signalFromResultError(e: StreamEvent, runtime: Runtime, nowMs: number): UsageCapDetection | null {
  if (e.type !== "result" || !e.is_error) return null;
  const text = typeof e.result === "string" ? e.result : "";
  if (!CAP_ERROR_RE.test(text)) return null;
  return {
    unavailableUntil: fallbackUntil(nowMs),
    reason: capReason(runtime, "session ended with cap error"),
    evidence: { result: text.slice(0, 500) },
  };
}

/** Parse Claude/Cursor-shaped NDJSON events for a hard cap (rate_limit_event preferred over result error). */
export function extractUsageCapFromEvents(
  events: StreamEvent[],
  runtime: Runtime,
  nowMs = Date.now()
): UsageCapDetection | null {
  let fromRateLimit: UsageCapDetection | null = null;
  let fromResult: UsageCapDetection | null = null;
  for (const e of events) {
    if (e.type === "rate_limit_event") {
      const info = e.rate_limit_info;
      if (info && typeof info === "object") {
        const sig = signalFromRateLimitInfo(runtime, info as Record<string, unknown>, { event: e }, nowMs);
        if (sig) fromRateLimit = sig;
      }
    }
    const api = signalFromApiRetry(e, runtime, nowMs);
    if (api) fromRateLimit = api;
    const res = signalFromResultError(e, runtime, nowMs);
    if (res) fromResult = res;
  }
  return fromRateLimit ?? fromResult;
}

function codexCapFromEvents(events: StreamEvent[], runtime: Runtime, nowMs: number): UsageCapDetection | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "turn.failed") {
      const err = e.error;
      let msg = "";
      if (typeof err === "string") msg = err;
      else if (err && typeof err === "object") {
        msg = String((err as { message?: unknown }).message ?? "");
      }
      if (CAP_ERROR_RE.test(msg)) {
        return {
          unavailableUntil: fallbackUntil(nowMs),
          reason: capReason(runtime, msg.slice(0, 120) || "turn failed"),
          evidence: { turn_failed: err },
        };
      }
    }
    if (e.type === "error" && typeof e.message === "string" && CAP_ERROR_RE.test(e.message)) {
      return {
        unavailableUntil: fallbackUntil(nowMs),
        reason: capReason(runtime, e.message.slice(0, 120)),
        evidence: { error: e.message },
      };
    }
  }
  return null;
}

function parseEventsForRuntime(raw: string, runtime: Runtime): StreamEvent[] {
  if (runtime === "codex_local") return parseCodexJsonl(raw);
  return parseNdjson(raw);
}

/**
 * True when the stream ended successfully — used to skip Codex/Cursor text fallback
 * (NOT-117). Cursor/Claude use a non-error `result`; Codex native JSONL uses
 * `turn.completed` (never emits `type: "result"` until normalizeCodexEvents).
 */
function sessionEndedSuccessfully(events: StreamEvent[], runtime: Runtime): boolean {
  if (runtime === "codex_local") {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === "turn.failed") return false;
      if (e.type === "error") return false;
      if (e.type === "turn.completed") return true;
    }
    return false;
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "result") return !e.is_error;
  }
  return false;
}

/**
 * Text fallback haystack: stderr trailer + error-result strings only — never assistant /
 * tool / file-read bodies (NOT-117 false-positive source).
 */
function textFallbackHaystack(raw: string, events: StreamEvent[]): string {
  const stderr = raw.includes("\n--- stderr ---\n") ? raw.split("\n--- stderr ---\n")[1] ?? "" : "";
  const resultBits: string[] = [];
  for (const e of events) {
    if (e.type === "result" && e.is_error && typeof e.result === "string") {
      resultBits.push(e.result);
    }
  }
  return `${resultBits.join("\n")}\n${stderr}`;
}

/** Detect from an in-memory NDJSON string (unit tests). */
export function detectUsageCapFromNdjson(raw: string, runtime: Runtime, nowMs = Date.now()): UsageCapDetection | null {
  const events = parseEventsForRuntime(raw, runtime);
  if (runtime === "codex_local") return codexCapFromEvents(events, runtime, nowMs);
  return extractUsageCapFromEvents(events, runtime, nowMs);
}

/**
 * Full-log detection including Cursor/Codex text fallback (unit tests that need the
 * NOT-117 path without writing a temp file).
 */
export function detectUsageCapFromRawLog(raw: string, runtime: Runtime, nowMs = Date.now()): UsageCapDetection | null {
  const events = parseEventsForRuntime(raw, runtime);
  const fromEvents =
    runtime === "codex_local"
      ? codexCapFromEvents(events, runtime, nowMs)
      : extractUsageCapFromEvents(events, runtime, nowMs);
  if (fromEvents) return fromEvents;

  if (runtime === "codex_local" || runtime === "cursor_local") {
    // Successful sessions must not open a usage-cap deferral from log body text (NOT-117).
    if (sessionEndedSuccessfully(events, runtime)) return null;
    const haystack = textFallbackHaystack(raw, events);
    if (CAP_FALLBACK_RE.test(haystack)) {
      return {
        unavailableUntil: fallbackUntil(nowMs),
        reason: capReason(runtime, "stderr/log matched usage-cap pattern"),
        evidence: { matched: haystack.slice(0, 300) },
      };
    }
  }
  return null;
}

export function detectUsageCapFromLog(
  logPath: string,
  runtime: Runtime,
  nowMs = Date.now()
): UsageCapDetection | null {
  if (!fs.existsSync(logPath)) return null;
  return detectUsageCapFromRawLog(fs.readFileSync(logPath, "utf8"), runtime, nowMs);
}

/** Persist a cap row when detected; returns the detection or null. */
export function recordUsageCapFromLog(logPath: string, runtime: Runtime, nowMs = Date.now()): UsageCapDetection | null {
  const cap = detectUsageCapFromLog(logPath, runtime, nowMs);
  if (!cap) return null;
  recordRuntimeAvailability({
    runtime,
    unavailableUntil: cap.unavailableUntil,
    reason: cap.reason,
    evidence: cap.evidence,
  });
  return cap;
}

/** Convenience for callers that already parsed events (e.g. stream-json tests). */
export function recordUsageCapFromEvents(
  events: StreamEvent[],
  runtime: Runtime,
  nowMs = Date.now()
): UsageCapDetection | null {
  const cap =
    runtime === "codex_local"
      ? codexCapFromEvents(events, runtime, nowMs)
      : extractUsageCapFromEvents(events, runtime, nowMs);
  if (!cap) return null;
  recordRuntimeAvailability({
    runtime,
    unavailableUntil: cap.unavailableUntil,
    reason: cap.reason,
    evidence: cap.evidence,
  });
  return cap;
}

/**
 * NOT-181: Muse's usage-cap signal is the parsed failure kind (runners/muse-code-jsonl.ts), not a
 * Claude-shaped log event. Muse reports no reset time (NOT-177: real cap payload never observed),
 * so the deferral uses the fallback cooldown.
 */
export function recordMuseUsageCap(
  failure: { kind: string; message: string } | null,
  nowMs = Date.now()
): UsageCapDetection | null {
  if (failure?.kind !== "usage_cap") return null;
  const cap: UsageCapDetection = {
    unavailableUntil: fallbackUntil(nowMs),
    reason: capReason("muse_code", failure.message.slice(0, 120) || "usage cap"),
    evidence: { muse_failure: failure },
  };
  recordRuntimeAvailability({
    runtime: "muse_code",
    unavailableUntil: cap.unavailableUntil,
    reason: cap.reason,
    evidence: cap.evidence,
  });
  return cap;
}
