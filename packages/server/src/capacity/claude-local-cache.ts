// packages/server/src/capacity/claude-local-cache.ts
//
// NOT-268: Claude account capacity — local-first source ladder with a
// one-hour paid fallback.
//
// Goal: keep Claude 5H/1W useful between Dealer runs. Production's last
// Dealer-observed sample can be days old (no recent Dealer-managed Claude
// run), while Claude Code itself maintains exact provider usage in the
// `cachedUsageUtilization` key of `~/.claude.json` on every run — including
// interactive runs outside Dealer. So the freshest valid observation wins
// from this ladder:
//
//   1. Existing Dealer `rate_limit_event` ingestion (claude-events.ts — kept
//      as-is, session-end, per-window newer-wins).
//   2. Read-only local cache: the `cachedUsageUtilization` subtree of
//      `~/.claude.json` (this module — free, ingested on every capacity
//      read; only that subtree is ever parsed, the rest of the config —
//      accountUuid, email, credentials, projects — is never retained).
//   3. One minimal bounded paid probe, only when every valid 5H/1W
//      observation is older than 60 minutes AND the explicit opt-in
//      `AGENT_DEALER_CLAUDE_CAPACITY_REFRESH=paid-after-1h` is set.
//
// Both file sources write the same `claude_unified_five_hour` /
// `claude_unified_seven_day` window keys through the shared
// `recordClaudeWindowReadings` newer-wins path, so freshness arbitration is
// automatic per window and an older cache can never clobber a newer event
// (or vice versa). `source` stays `observed_event` for both; `evidenceRef`
// tells them apart (`claude-session:unified-windows` vs
// `claude-cache:cachedUsageUtilization` vs `claude-probe:minimal-print`).
//
// Local-cache safety: only the `cachedUsageUtilization` subtree
// (`fetchedAtMs`, `utilization.five_hour`, `utilization.seven_day`,
// `utilization.limits[]`) is ever read. `accountUuid`, email, credentials,
// extra-usage spend, experiments, and the full raw object are never
// persisted, returned, or logged. Only the account-wide five-hour and
// seven-day windows are normalized — every other bucket is dropped.
//
// Observed provider shapes (verified against a real `~/.claude.json` at
// 2.1.283 — the cache is percent-scale, not 0–1 fractions):
// - Named fields: `{ utilization: <0–100 percent>, resets_at: <ISO-8601> }`.
//   Bare `utilization` ≤ 1 still reads as a fraction (compatibility); values
//   in (1, 100] read as percent. Anything else is malformed — rejected.
// - `limits[]`: `{ kind|group: "session"|"weekly_all", percent: <0–100>,
//   resets_at: <ISO-8601>, ... }`. Model-specific and overage entries are
//   dropped — only the account-wide pair is ever normalized.
//
// Probe argv (verified live at 2.1.283 — `claude -p --max-turns 1 --model
// <bogus>` parses flags and fails only on model resolution, spending
// nothing, even though `--help` hides the flag):
// - `--model haiku` — the cheapest supported alias (matches
//   runners/models.ts `haiku` "latest alias").
// - `--max-turns 1` — hard one-turn bound, belt-and-braces with the
//   structural bound below.
// - `--tools ""` + `--strict-mcp-config` (with no `--mcp-config`) — no tools,
//   no MCP. With no tools the model cannot continue past its first response,
//   the fixed minimal prompt asks for a single word, and
//   `--max-budget-usd 0.01` hard-caps spend.
// - `--no-session-persistence` — the probe leaves no resumable session.
// - `--output-format stream-json` (+ `--verbose`, matching Dealer's own
//   stream-json parsing) so `rate_limit_event`s can be ingested.
// - `--bare` is deliberately NOT used: it restricts auth to
//   ANTHROPIC_API_KEY/apiKeyHelper and would bypass the account's OAuth
//   login — the probe must bill to the account whose capacity it measures.
// - Ambient settings are kept (auth must resolve); no worktree is created
//   (cwd is the OS temp dir) and nothing touches Dealer workflow/session
//   rows, worktrees, commits, PRs, or queue events — the probe spawns
//   `claude` directly, never through the coordinator.
//
// If a live proof ever shows the minimal probe does not reliably emit 5H/1W
// (neither in its stream nor via the cache side effect), the probe is a
// recurring paid no-op: disable the opt-in and revise this ticket instead of
// shipping it. The `no_windows` diagnostic below exists to make that visible.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDataDir } from "../db/index.js";
import { resolveClaudeBin } from "../cli-env.js";
import { parseNdjson } from "../runners/stream-json.js";
import { listCapacitySnapshots } from "../repository/runtime-capacity.js";
import { configuredCapacityRuntimes } from "./service.js";
import {
  CLAUDE_RUNTIME,
  extractClaudeCapacityFromEvents,
  normalizeClaudeResetsAt,
  recordClaudeCapacityFromEvents,
  recordClaudeWindowReadings,
} from "./claude-events.js";
import type { AdapterReadResult, AdapterWindowReading } from "./adapter.js";

/** Override for the Claude cache file (tests, smoke). */
export const CLAUDE_CACHE_FILE_ENV = "AGENT_DEALER_CLAUDE_CACHE_FILE";

/** Paid-fallback opt-in. Any value other than PAID_AFTER_1H disables probing. */
export const CLAUDE_CAPACITY_REFRESH_ENV = "AGENT_DEALER_CLAUDE_CAPACITY_REFRESH";
export const CLAUDE_CAPACITY_REFRESH_PAID_VALUE = "paid-after-1h";

/** Upper bound for one probe spawn (ms). */
export const CLAUDE_CAPACITY_PROBE_TIMEOUT_ENV = "AGENT_DEALER_CLAUDE_PROBE_TIMEOUT_MS";
export const CLAUDE_PROBE_TIMEOUT_MS_DEFAULT = 90_000;

/** Static evidence pointers — never credentials or raw payloads. */
export const CLAUDE_CACHE_EVIDENCE_REF = "claude-cache:cachedUsageUtilization";
export const CLAUDE_PROBE_EVIDENCE_REF = "claude-probe:minimal-print";

/** Cheapest supported model alias for the probe (cf. runners/models.ts). */
export const CLAUDE_PROBE_MODEL = "haiku";
/** Fixed minimal prompt — asserted in tests; never interpolated. */
export const CLAUDE_PROBE_PROMPT = "Reply with exactly: ok";
/** Hard spend cap for the probe (USD). */
export const CLAUDE_PROBE_MAX_BUDGET_USD = 0.01;

/** A 5H/1W observation newer than this suppresses the paid probe. */
export const CLAUDE_PROBE_STALE_AFTER_MS = 60 * 60 * 1000;
/** Minimum gap between probe attempts (per account); failures back off. */
export const CLAUDE_PROBE_ATTEMPT_COOLDOWN_MS = 60 * 60 * 1000;
export const CLAUDE_PROBE_BACKOFF_CAP_MS = 8 * 60 * 60 * 1000;

/** Account-wide window identities for the local cache (exact, lowercase). */
const FIVE_HOUR_LIMIT_NAMES = new Set(["five_hour", "session"]);
const WEEKLY_LIMIT_NAMES = new Set(["seven_day", "weekly", "weekly_all"]);

interface CacheWindowIdentity {
  windowKey: string;
  providerBucket: string;
  durationMinutes: number;
  criticalRole: "five_hour" | "weekly";
}

const CACHE_WINDOW_IDENTITIES: Record<"five_hour" | "weekly", CacheWindowIdentity> = {
  five_hour: {
    windowKey: "claude_unified_five_hour",
    providerBucket: "five_hour",
    durationMinutes: 300,
    criticalRole: "five_hour",
  },
  weekly: {
    windowKey: "claude_unified_seven_day",
    providerBucket: "seven_day",
    durationMinutes: 10080,
    criticalRole: "weekly",
  },
};

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

function pickString(candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}

/**
 * Path to the Claude Code config file whose `cachedUsageUtilization` key
 * carries the local 5H/1W observation (override env for tests/smoke points
 * at a fixture file instead). Only that key is ever parsed — see
 * `extractClaudeCacheSubtree`.
 */
export function claudeCacheFilePath(): string {
  const override = process.env[CLAUDE_CACHE_FILE_ENV]?.trim();
  if (override) return override;
  return path.join(process.env.HOME ?? os.homedir(), ".claude.json");
}

export function claudeProbeTimeoutMs(): number {
  const raw = process.env[CLAUDE_CAPACITY_PROBE_TIMEOUT_ENV];
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return CLAUDE_PROBE_TIMEOUT_MS_DEFAULT;
}

/**
 * Fixed probe argv. Pinned by tests: the fixed minimal prompt, cheapest
 * model, `--max-turns 1`, no tools, no MCP, no session persistence, stream
 * JSON, ≤$0.01 budget.
 */
export function buildClaudeProbeArgv(): string[] {
  return [
    "-p",
    CLAUDE_PROBE_PROMPT,
    "--model",
    CLAUDE_PROBE_MODEL,
    "--max-turns",
    "1",
    "--tools",
    "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-budget-usd",
    String(CLAUDE_PROBE_MAX_BUDGET_USD),
  ];
}

// ---------------------------------------------------------------------------
// Local-cache parsing
// ---------------------------------------------------------------------------

interface CacheScale {
  usedPercent: number | null;
  usedFraction: number | null;
}

/**
 * Utilization scale for one cache window entry. Explicit percent spellings
 * (`usedPercent`, `percent`, …) are 0–100. Bare `utilization` (and its
 * `used*` spellings) is dual-scale, matching the observed provider data: a
 * real `~/.claude.json` at 2.1.283 carries percent values there
 * (`{ utilization: 9, … }`), while older shapes carry 0–1 fractions — so
 * ≤ 1 reads as a fraction and (1, 100] reads as percent. Anything else —
 * wrong type, negative, or above 100 on both scales — is malformed and the
 * window is rejected, never guessed.
 */
function cacheEntryScale(entry: Record<string, unknown>): CacheScale | null {
  const usedPercent = pickNumber([
    entry.usedPercent,
    entry.used_percent,
    entry.utilizationPercent,
    entry.utilization_percent,
    entry.percent,
  ]);
  if (usedPercent !== null) {
    if (usedPercent < 0 || usedPercent > 100) return null;
    return { usedPercent, usedFraction: null };
  }
  // Explicit fraction spellings stay strict 0–1.
  const strictFraction = pickNumber([entry.usedFraction, entry.used_fraction]);
  if (strictFraction !== null) {
    if (strictFraction < 0 || strictFraction > 1) return null;
    return { usedPercent: null, usedFraction: strictFraction };
  }
  // Bare `utilization`/`used` is dual-scale (fraction ≤ 1, percent above).
  const usedValue = pickNumber([entry.utilization, entry.used]);
  if (usedValue === null) return null;
  if (usedValue < 0 || usedValue > 100) return null;
  if (usedValue <= 1) return { usedPercent: null, usedFraction: usedValue };
  return { usedPercent: usedValue, usedFraction: null };
}

function cacheWindowReading(
  role: "five_hour" | "weekly",
  entry: unknown,
  observedAt: string,
  observedMs: number,
  evidenceRef: string
): AdapterWindowReading | null {
  const identity = CACHE_WINDOW_IDENTITIES[role];
  let scale: CacheScale | null = null;
  let resetRaw: unknown = null;
  if (typeof entry === "number") {
    const f = asFiniteNumber(entry);
    if (f === null || f < 0 || f > 1) return null;
    scale = { usedPercent: null, usedFraction: f };
  } else if (entry && typeof entry === "object") {
    const w = entry as Record<string, unknown>;
    scale = cacheEntryScale(w);
    if (!scale) return null;
    resetRaw =
      w.resets_at ?? w.resetsAt ?? w.reset_at ?? w.resetAt ?? w.resetsAtMs ?? null;
  } else {
    return null;
  }
  const resetAt = normalizeClaudeResetsAt(resetRaw);
  if (resetAt !== null) {
    const resetMs = Date.parse(resetAt);
    // A past reset is never current capacity — reject the window so the
    // last-good row survives instead of being overwritten by expired data.
    if (!Number.isFinite(resetMs) || resetMs <= observedMs) return null;
  }
  return {
    windowKey: identity.windowKey,
    providerBucket: identity.providerBucket,
    durationMinutes: identity.durationMinutes,
    providerLabel: identity.providerBucket,
    usedValue: scale.usedPercent ?? scale.usedFraction,
    usedUnit: scale.usedPercent !== null ? "percent" : "fraction",
    ...(scale.usedPercent !== null
      ? { usedPercent: scale.usedPercent }
      : { usedFraction: scale.usedFraction as number }),
    resetAt,
    observedAt,
    source: "observed_event",
    evidenceRef,
    criticalRole: identity.criticalRole,
  };
}

function limitEntryRole(name: string): "five_hour" | "weekly" | null {
  const b = name.trim().toLowerCase();
  if (FIVE_HOUR_LIMIT_NAMES.has(b)) return "five_hour";
  if (WEEKLY_LIMIT_NAMES.has(b)) return "weekly";
  return null;
}

/**
 * Normalize the `utilization` subtree of `cachedUsageUtilization` into
 * account-wide 5H/1W readings. `fetchedAtMs` is the observed time.
 *
 * - `utilization.limits[]` is preferred when it carries the explicit
 *   account-wide windows (`session` → five-hour, `weekly_all` → weekly,
 *   named via `kind`/`group`, scaled via `percent`); any other limit entry
 *   (model-specific, overage) is dropped — only the account-wide pair is
 *   ever normalized.
 * - The named `five_hour` / `seven_day` fields are the compatibility path
 *   for whichever role `limits[]` does not cover. Bare `utilization` values
 *   are dual-scale (≤ 1 fraction, above percent to 100).
 * - Returns null when nothing usable is present: missing/future
 *   `fetchedAtMs`, no account-wide window with a usable scale, or every
 *   window rejected (malformed scale, expired reset). Account identity,
 *   extra-usage spend, experiments, and the raw object never leave this
 *   function.
 */
export function parseClaudeCachedUtilization(
  raw: unknown,
  nowMs = Date.now(),
  evidenceRef: string = CLAUDE_CACHE_EVIDENCE_REF
): AdapterWindowReading[] | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const root = raw as Record<string, unknown>;
  const fetchedAtMs = asFiniteNumber(root.fetchedAtMs);
  if (fetchedAtMs === null || fetchedAtMs <= 0 || fetchedAtMs > nowMs) return null;
  const observedAt = new Date(fetchedAtMs).toISOString();
  const utilization = root.utilization;
  if (!utilization || typeof utilization !== "object" || Array.isArray(utilization)) {
    return null;
  }
  const u = utilization as Record<string, unknown>;
  const byRole = new Map<"five_hour" | "weekly", AdapterWindowReading>();
  const consider = (role: "five_hour" | "weekly", entry: unknown) => {
    if (byRole.has(role)) return;
    const reading = cacheWindowReading(role, entry, observedAt, fetchedAtMs, evidenceRef);
    if (reading) byRole.set(role, reading);
  };
  // Preferred path: explicit account-wide entries in limits[]. Real
  // entries name their window via `kind`/`group` (`session`, `weekly_all`)
  // and scale via `percent`; the `name`/`window`/… + `utilization` spellings
  // are the compatibility path for older shapes.
  const limits = u.limits;
  if (Array.isArray(limits)) {
    for (const item of limits) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const w = item as Record<string, unknown>;
      const name = pickString([
        w.name,
        w.window,
        w.bucket,
        w.key,
        w.id,
        w.kind,
        w.group,
      ]);
      if (!name) continue;
      const role = limitEntryRole(name);
      if (!role) continue;
      consider(role, item);
    }
  }
  // Compatibility path: named fields fill whichever role limits[] missed.
  const named = u as Record<string, unknown>;
  if (!byRole.has("five_hour") && named.five_hour !== undefined) {
    consider("five_hour", named.five_hour);
  }
  if (!byRole.has("weekly") && named.seven_day !== undefined) {
    consider("weekly", named.seven_day);
  }
  return byRole.size > 0 ? [...byRole.values()] : null;
}

/**
 * Extract the `cachedUsageUtilization` subtree from a parsed config file.
 * A bare cache object (no such key — the shape override fixtures use) is
 * accepted as-is so tests can point the override at a minimal file. The
 * caller must drop the input immediately after: siblings carry accountUuid,
 * email, credentials, and projects, none of which may persist.
 */
export function extractClaudeCacheSubtree(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;
  const subtree = root.cachedUsageUtilization;
  if (subtree && typeof subtree === "object" && !Array.isArray(subtree)) return subtree;
  return parsed;
}

/**
 * Read-only local-cache read: parse `~/.claude.json`, extract only the
 * `cachedUsageUtilization` subtree, normalize it, and drop everything else.
 * Returns null when the file is missing, unparsable, or carries no usable
 * 5H/1W observation — never throws, never spawns Claude, never spends
 * money.
 */
export function readClaudeLocalCache(nowMs = Date.now()): AdapterReadResult | null {
  let text: string;
  try {
    text = fs.readFileSync(claudeCacheFilePath(), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const windows = parseClaudeCachedUtilization(extractClaudeCacheSubtree(parsed), nowMs);
  if (!windows) return null;
  return { runtime: CLAUDE_RUNTIME, windows, unavailable: [] };
}

/**
 * Ingest the local cache through the shared newer-wins path. Returns the
 * persisted window count, or null when no usable observation exists. A stale
 * cache ingests with its true `fetchedAtMs` (read-time rules render it N/A
 * with honest age); an older cache never overwrites a newer event row.
 */
export function ingestClaudeLocalCache(nowMs = Date.now()): number | null {
  const result = readClaudeLocalCache(nowMs);
  if (!result) return null;
  return recordClaudeWindowReadings(result.windows, CLAUDE_RUNTIME, nowMs);
}

// ---------------------------------------------------------------------------
// Paid fallback probe (explicit opt-in only)
// ---------------------------------------------------------------------------

/** True only under the exact opt-in; any other value disables paid probing. */
export function isClaudePaidFallbackEnabled(): boolean {
  return process.env[CLAUDE_CAPACITY_REFRESH_ENV] === CLAUDE_CAPACITY_REFRESH_PAID_VALUE;
}

export interface ProbeSpawnResult {
  stdout: string;
  exitCode: number | null;
  timedOut: boolean;
  spawnError: string | null;
}

export type ProbeRunner = (
  bin: string,
  argv: string[],
  opts: { timeoutMs: number; cwd: string }
) => Promise<ProbeSpawnResult>;

/** Bounded direct spawn of `claude` — never the coordinator, never a run. */
export function defaultProbeRunner(
  bin: string,
  argv: string[],
  opts: { timeoutMs: number; cwd: string }
): Promise<ProbeSpawnResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn(bin, argv, {
        cwd: opts.cwd,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (err) {
      resolve({
        stdout: "",
        exitCode: null,
        timedOut: false,
        spawnError: (err as NodeJS.ErrnoException)?.code ?? "spawn_failed",
      });
      return;
    }
    const chunks: string[] = [];
    let size = 0;
    let settled = false;
    const finish = (out: ProbeSpawnResult) => {
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
    const timer = setTimeout(() => {
      finish({ stdout: chunks.join(""), exitCode: null, timedOut: true, spawnError: null });
    }, opts.timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (buf: Buffer) => {
      const s = buf.toString();
      // Cap retained output: only rate_limit events are parsed, the probe's
      // own text is never kept, logged, or returned.
      if (size + s.length <= 4 * 1024 * 1024) {
        chunks.push(s);
        size += s.length;
      }
    });
    child.on("error", (err) => {
      finish({
        stdout: chunks.join(""),
        exitCode: null,
        timedOut: false,
        spawnError: (err as NodeJS.ErrnoException)?.code ?? "spawn_failed",
      });
    });
    child.on("close", (code) => {
      finish({ stdout: chunks.join(""), exitCode: code, timedOut: false, spawnError: null });
    });
  });
}

export type ProbeFailureKind =
  | "spawn"
  | "timeout"
  | "nonzero_exit"
  | "no_windows";

export interface ProbeRunResult {
  ok: boolean;
  windowsUpdated: string[];
  costUsd: number | null;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  failureKind: ProbeFailureKind | null;
}

function probeCostFromEvents(events: Array<Record<string, unknown>>): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== "result") continue;
    const cost = (e as { total_cost_usd?: unknown }).total_cost_usd;
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) return cost;
  }
  return null;
}

function rolesCoveredByReadings(readings: AdapterWindowReading[]): Set<string> {
  const out = new Set<string>();
  for (const w of readings) {
    if (w.criticalRole === "five_hour" || w.criticalRole === "weekly") out.add(w.criticalRole);
  }
  return out;
}

function maxReadingObservedMs(readings: AdapterWindowReading[]): number | null {
  let max: number | null = null;
  for (const w of readings) {
    if (!w.observedAt) continue;
    const ms = Date.parse(w.observedAt);
    if (!Number.isFinite(ms)) continue;
    max = max === null ? ms : Math.max(max, ms);
  }
  return max;
}

/** Operator-safe probe log: static kinds and numbers only. */
function logProbeOutcome(outcome: {
  ok: boolean;
  failureKind: ProbeFailureKind | null;
  costUsd: number | null;
}): void {
  console.error(
    `[claude-capacity] probe ${outcome.ok ? "ok" : `failed: ${outcome.failureKind ?? "unknown"}`} ` +
      `(cost_usd=${outcome.costUsd ?? "unknown"})`
  );
}

/**
 * Capacity diagnostic log: the actual probe cost/result per attempt, without
 * prompt/output/credentials. Append-only JSON lines under the data dir.
 */
export function probeDiagnosticLogPath(): string {
  return path.join(getDataDir(), "capacity", "claude-probe.log");
}

function appendProbeDiagnostic(entry: Record<string, unknown>): void {
  try {
    const file = probeDiagnosticLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // Diagnostics are advisory — a full disk must not fail the probe path.
  }
}

/**
 * Run one minimal bounded probe and ingest whatever 5H/1W it yields — first
 * the stream's `rate_limit_event`s, then a re-read of the local cache (the
 * probe run itself refreshes Claude's own cache file, so the side effect
 * counts even when the stream carries no windows). Success means the union
 * covers both critical roles. Never throws; never creates Dealer
 * workflow/session rows, worktrees, commits, PRs, or queue events.
 */
export async function runClaudeCapacityProbe(
  nowMs = Date.now(),
  opts: { runner?: ProbeRunner; bin?: string; timeoutMs?: number } = {}
): Promise<ProbeRunResult> {
  const startedRealMs = Date.now();
  const bin = opts.bin ?? resolveClaudeBin();
  const argv = buildClaudeProbeArgv();
  const timeoutMs = opts.timeoutMs ?? claudeProbeTimeoutMs();
  const runner = opts.runner ?? defaultProbeRunner;
  // Pre-probe cache age (read BEFORE the spawn): the re-read below only
  // counts toward success when the probe actually refreshed the file
  // (strictly newer observation) — a stale-but-parseable file must not turn
  // a failed probe into a success.
  let preProbeCacheObservedMs: number | null = null;
  try {
    preProbeCacheObservedMs = maxReadingObservedMs(readClaudeLocalCache(nowMs)?.windows ?? []);
  } catch {
    preProbeCacheObservedMs = null;
  }
  let spawnResult: ProbeSpawnResult;
  try {
    spawnResult = await runner(bin, argv, { timeoutMs, cwd: os.tmpdir() });
  } catch {
    spawnResult = { stdout: "", exitCode: null, timedOut: false, spawnError: "runner_threw" };
  }
  const durationMs = Date.now() - startedRealMs;
  const fail = (
    failureKind: ProbeFailureKind,
    extra: Partial<ProbeRunResult> = {}
  ): ProbeRunResult => {
    const out: ProbeRunResult = {
      ok: false,
      windowsUpdated: [],
      costUsd: null,
      exitCode: spawnResult.exitCode,
      timedOut: spawnResult.timedOut,
      durationMs,
      failureKind,
      ...extra,
    };
    logProbeOutcome(out);
    appendProbeDiagnostic({
      ts: new Date(nowMs).toISOString(),
      event: "claude_capacity_probe",
      trigger: "stale_60m",
      model: CLAUDE_PROBE_MODEL,
      budgetUsd: CLAUDE_PROBE_MAX_BUDGET_USD,
      ...out,
    });
    return out;
  };
  if (spawnResult.spawnError) return fail("spawn");
  if (spawnResult.timedOut) return fail("timeout");
  let events: Array<Record<string, unknown>> = [];
  try {
    events = parseNdjson(spawnResult.stdout) as Array<Record<string, unknown>>;
  } catch {
    events = [];
  }
  const costUsd = probeCostFromEvents(events);
  // Ingest the stream first (event timestamps clamp to nowMs inside).
  let streamRoles = new Set<string>();
  try {
    const extracted = extractClaudeCapacityFromEvents(events, nowMs, nowMs);
    if (extracted) streamRoles = rolesCoveredByReadings(extracted.windows);
    recordClaudeCapacityFromEvents(events, CLAUDE_RUNTIME, nowMs, nowMs);
  } catch {
    // A broken stream must not fail the probe path — the cache re-read below
    // may still yield fresh rows.
  }
  // Then the cache side effect: the probe run refreshes Claude's own file.
  // Ingest regardless (newer-wins protects stored rows), but only a
  // strictly newer observation counts toward success.
  let cacheRoles = new Set<string>();
  try {
    const reread = readClaudeLocalCache(nowMs);
    if (reread) {
      const afterObservedMs = maxReadingObservedMs(reread.windows);
      if (
        afterObservedMs !== null &&
        (preProbeCacheObservedMs === null || afterObservedMs > preProbeCacheObservedMs)
      ) {
        cacheRoles = rolesCoveredByReadings(reread.windows);
      }
      recordClaudeWindowReadings(reread.windows, CLAUDE_RUNTIME, nowMs);
    }
  } catch {
    // Advisory — stream coverage below still counts.
  }
  const covered = new Set([...streamRoles, ...cacheRoles]);
  if (spawnResult.exitCode !== 0 && covered.size === 0) return fail("nonzero_exit", { costUsd });
  if (!covered.has("five_hour") || !covered.has("weekly")) {
    // The probe spent money but produced no 5H/1W pair — a `no_windows`
    // streak is the signal to disable the opt-in and revise the ticket
    // rather than ship a recurring paid no-op.
    return fail("no_windows", { costUsd });
  }
  const out: ProbeRunResult = {
    ok: true,
    windowsUpdated: [CACHE_WINDOW_IDENTITIES.five_hour.windowKey, CACHE_WINDOW_IDENTITIES.weekly.windowKey],
    costUsd,
    exitCode: spawnResult.exitCode,
    timedOut: false,
    durationMs,
    failureKind: null,
  };
  logProbeOutcome(out);
  appendProbeDiagnostic({
    ts: new Date(nowMs).toISOString(),
    event: "claude_capacity_probe",
    trigger: "stale_60m",
    model: CLAUDE_PROBE_MODEL,
    budgetUsd: CLAUDE_PROBE_MAX_BUDGET_USD,
    ...out,
  });
  return out;
}

// ---------------------------------------------------------------------------
// Freshness gate, single-flight, backoff
// ---------------------------------------------------------------------------

/**
 * Newest valid account-wide 5H/1W observation (event or cache — both share
 * window keys and critical roles). A row counts when it carries a remaining
 * %, its reset is absent or future, and its observed time is not in the
 * future. Returns null when no such sample exists.
 */
export function newestValidClaudeObservationMs(nowMs = Date.now()): number | null {
  let max: number | null = null;
  for (const row of listCapacitySnapshots(CLAUDE_RUNTIME)) {
    if (row.criticalRole !== "five_hour" && row.criticalRole !== "weekly") continue;
    if (row.remainingPercent === null) continue;
    if (row.resetAt !== null) {
      const resetMs = Date.parse(row.resetAt);
      if (!Number.isFinite(resetMs) || resetMs <= nowMs) continue;
    }
    const observedMs = Date.parse(row.observedAt);
    if (!Number.isFinite(observedMs) || observedMs > nowMs) continue;
    max = max === null ? observedMs : Math.max(max, observedMs);
  }
  return max;
}

export type ProbeSkipReason = "disabled" | "unconfigured" | "fresh" | "backoff" | "error";

export interface ProbeGateOutcome {
  probed: boolean;
  reason: ProbeSkipReason | "shared" | "completed";
  ok?: boolean;
  windowsUpdated?: string[];
  costUsd?: number | null;
  failureKind?: ProbeFailureKind | null;
}

let claudeProbeInFlight: Promise<ProbeRunResult> | null = null;
let lastClaudeProbeAttemptMs = 0;
let consecutiveClaudeProbeFailures = 0;

/** Test helper — clear single-flight, attempt, and backoff state. */
export function resetClaudeCapacityRefreshState(): void {
  claudeProbeInFlight = null;
  lastClaudeProbeAttemptMs = 0;
  consecutiveClaudeProbeFailures = 0;
}

/** Test helper — observe backoff/attempt state without spawning. */
export function claudeProbeRefreshStateForTests(): {
  lastAttemptMs: number;
  consecutiveFailures: number;
  inFlight: boolean;
} {
  return {
    lastAttemptMs: lastClaudeProbeAttemptMs,
    consecutiveFailures: consecutiveClaudeProbeFailures,
    inFlight: claudeProbeInFlight !== null,
  };
}

function probeCooldownMs(): number {
  const shift = Math.min(consecutiveClaudeProbeFailures, 3);
  return Math.min(
    CLAUDE_PROBE_ATTEMPT_COOLDOWN_MS * 2 ** shift,
    CLAUDE_PROBE_BACKOFF_CAP_MS
  );
}

/**
 * On-demand paid fallback: when `claude_code` is configured and no valid
 * 5H/1W observation is newer than 60 minutes, run one minimal bounded probe
 * (single-flight across concurrent readers; at most one attempt per account
 * per 60 minutes, backing off exponentially on failure). Disabled is a
 * strict no-op — no spawn, no spend. Never throws, never touches Dealer
 * workflow/session state or `runtime_availability`.
 */
export async function maybeProbeClaudeCapacity(
  nowMs = Date.now(),
  opts: { runner?: ProbeRunner; bin?: string; timeoutMs?: number } = {}
): Promise<ProbeGateOutcome> {
  try {
    if (!isClaudePaidFallbackEnabled()) return { probed: false, reason: "disabled" };
    if (!configuredCapacityRuntimes().includes(CLAUDE_RUNTIME)) {
      return { probed: false, reason: "unconfigured" };
    }
    const newest = newestValidClaudeObservationMs(nowMs);
    if (newest !== null && nowMs - newest < CLAUDE_PROBE_STALE_AFTER_MS) {
      return { probed: false, reason: "fresh" };
    }
    // Single-flight first: readers arriving while a probe runs share it
    // rather than hitting the cooldown the owner just stamped.
    if (claudeProbeInFlight) {
      const shared = await claudeProbeInFlight;
      return {
        probed: true,
        reason: "shared",
        ok: shared.ok,
        windowsUpdated: shared.windowsUpdated,
        costUsd: shared.costUsd,
        failureKind: shared.failureKind,
      };
    }
    if (nowMs - lastClaudeProbeAttemptMs < probeCooldownMs()) {
      return { probed: false, reason: "backoff" };
    }
    lastClaudeProbeAttemptMs = nowMs;
    const run = runClaudeCapacityProbe(nowMs, opts);
    claudeProbeInFlight = run;
    try {
      const result = await run;
      consecutiveClaudeProbeFailures = result.ok ? 0 : consecutiveClaudeProbeFailures + 1;
      return {
        probed: true,
        reason: "completed",
        ok: result.ok,
        windowsUpdated: result.windowsUpdated,
        costUsd: result.costUsd,
        failureKind: result.failureKind,
      };
    } finally {
      if (claudeProbeInFlight === run) claudeProbeInFlight = null;
    }
  } catch {
    return { probed: false, reason: "error" };
  }
}

/**
 * Full on-demand refresh for `GET /api/runtime-capacity`: ingest the free
 * local cache first, then consider the paid probe. Best-effort — never
 * throws. The route serves the stored snapshot regardless.
 */
export async function refreshClaudeCapacityIfStale(
  nowMs = Date.now(),
  opts: { runner?: ProbeRunner; bin?: string; timeoutMs?: number } = {}
): Promise<ProbeGateOutcome> {
  try {
    ingestClaudeLocalCache(nowMs);
  } catch {
    // Advisory — the probe gate below still applies.
  }
  return maybeProbeClaudeCapacity(nowMs, opts);
}

