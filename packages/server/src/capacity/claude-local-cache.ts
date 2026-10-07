// packages/server/src/capacity/claude-local-cache.ts
//
// NOT-268: Claude account capacity — local-first source ladder with a free
// `/usage` refresh (corrected 2026-09-27; see below for what changed and why).
//
// Goal: keep Claude 5H/1W useful between Dealer runs. Production's last
// Dealer-observed sample can be days old (no recent Dealer-managed Claude
// run). The ladder:
//
//   1. Existing Dealer `rate_limit_event` ingestion (claude-events.ts — kept
//      as-is, session-end, per-window newer-wins).
//   2. Read-only local cache: the `cachedUsageUtilization` subtree of
//      `~/.claude.json` (this module — free, ingested on every capacity
//      read; only that subtree is ever parsed, the rest of the config —
//      accountUuid, email, credentials, projects — is never retained).
//   3. One minimal FREE refresh when either valid 5H/1W observation is
//      missing or at least 14 minutes old: `claude -p "/usage"` (NOT-281 —
//      the 15-minute display freshness would otherwise lapse into N/A while
//      the old 60-minute trigger waited). This is the default behavior.
//      Set `AGENT_DEALER_CLAUDE_CAPACITY_REFRESH=off` to disable it entirely
//      — reading capacity then never spawns Claude. Unrecognized values also
//      fail closed (stay disabled).
//
// 2026-09-27 correction (what changed and why): the original design for rung
// 3 spawned a real one-turn model prompt (`claude -p "Reply with exactly: ok"
// --model haiku ...`), assuming any `claude` invocation would emit a
// `rate_limit_event` and/or refresh rung 2's cache file. A live proof against
// a real account falsified both assumptions: three attempts each overspent
// the $0.01 cap on ambient context alone (~11K cache-creation tokens before
// the model could even answer), none emitted a `rate_limit_event`, and the
// cache file was untouched afterward — a decompiled trace of the installed
// CLI showed the cache write (`Juo()`) lives behind the interactive
// usage/plan-limits fetch, not the ordinary chat-turn path. That path
// initially looked unreachable from a headless probe, until a second live
// test found the actual trigger: passing the **local slash-command**
// `/usage` as the `-p` prompt. Claude Code resolves `/usage` as a local
// command — no model call, `total_cost_usd: 0`, ~300ms — and its NDJSON
// output carries the exact structured result Dealer needs directly, at
// `usage_report.rate_limits.limits[]` (`{ kind: "session"|"weekly_all",
// percent, resets_at, ... }` — the same shape rung 2 already parses from the
// cache file's `limits[]`). It also performs the identical write rung 2
// reads, confirmed by `cachedUsageUtilization.fetchedAtMs` changing on every
// run. Verified reproducible across repeated live invocations. This is a
// documented, user-facing CLI command (listed in the session's own
// `slash_commands`), not an internal/undocumented surface, and it costs
// nothing — so the refresh is back to default-on, and the diagnostic log
// records real ~$0 outcomes instead of a `no_windows` failure streak. See
// docs/RUNTIME_CAPACITY.md for the full writeup and both live proofs.
//
// Both file sources write the same `claude_unified_five_hour` /
// `claude_unified_seven_day` window keys through the shared
// `recordClaudeWindowReadings` newer-wins path, so freshness arbitration is
// automatic per window and an older cache can never clobber a newer event
// (or vice versa). `source` stays `observed_event` for both; `evidenceRef`
// tells them apart (`claude-session:unified-windows` vs
// `claude-cache:cachedUsageUtilization` vs `claude-probe:usage-command`).
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
//   dropped — only the account-wide pair is ever normalized. The `/usage`
//   probe's `usage_report.rate_limits.limits[]` is this exact same shape and
//   shares the same role mapping (`limitEntryRole`).
//
// Probe argv (verified live at 2.1.283):
// - `-p "/usage"` — the fixed local slash-command; never interpolated, never
//   a natural-language prompt. Resolved entirely locally: no model call, no
//   tokens, no cost.
// - `--model haiku` + `--max-turns 1` + `--tools ""` — structural safeguards
//   kept even though `/usage` never reaches the model on 2.1.283: verified
//   live that they do not break local resolution, and they bound the
//   (unobserved) case where a different CLI build makes `/usage` fall
//   through to a real prompt (2026-09-27 review hardening — see
//   `buildClaudeProbeArgv`).
// - `--strict-mcp-config` (with no `--mcp-config`) — no MCP servers loaded.
// - `--no-session-persistence` — the probe leaves no resumable session.
// - `--output-format stream-json` (+ `--verbose`, matching Dealer's own
//   stream-json parsing) so the `usage_report` and any `rate_limit_event`s
//   can be ingested.
// - `--max-budget-usd 0.01` — defensive belt-and-braces only: normal cost is
//   exactly $0. Not sufficient alone (ambient context can blow the cap
//   before the check fires — see live proof #1 below), so the result is
//   also checked for the local-command marker and exactly-zero cost before
//   it counts as success (`runClaudeCapacityProbe`).
// - `--bare` is deliberately NOT used: it restricts auth to
//   ANTHROPIC_API_KEY/apiKeyHelper and would bypass the account's OAuth
//   login — the probe must read the capacity of the account it measures.
// - Ambient settings are kept (auth must resolve); no worktree is created
//   (cwd is the OS temp dir) and nothing touches Dealer workflow/session
//   rows, worktrees, commits, PRs, or queue events — the probe spawns
//   `claude` directly, never through the coordinator.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDataDir } from "../db/index.js";
import { resolveClaudeBin } from "../cli-env.js";
import { parseNdjson } from "../runners/stream-json.js";
import { listCapacitySnapshots, recordCapacitySnapshots } from "../repository/runtime-capacity.js";
import {
  deriveWindowLabel,
  isWindowKnown,
  type CapacityUnavailableDetail,
  type CapacityUnavailableReason,
} from "@agent-dealer/shared";
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

/**
 * Refresh setting. Default ON (unset/empty, or the historical explicit
 * `paid-after-1h` value — kept accepted for backward compat with 1.2.4
 * configs, though the refresh is no longer paid). Only `off` (or any other
 * unrecognized value) disables it, failing closed on typos.
 */
export const CLAUDE_CAPACITY_REFRESH_ENV = "AGENT_DEALER_CLAUDE_CAPACITY_REFRESH";
export const CLAUDE_CAPACITY_REFRESH_PAID_VALUE = "paid-after-1h";
export const CLAUDE_CAPACITY_REFRESH_OFF_VALUE = "off";

/** Upper bound for one probe spawn (ms). */
export const CLAUDE_CAPACITY_PROBE_TIMEOUT_ENV = "AGENT_DEALER_CLAUDE_PROBE_TIMEOUT_MS";
export const CLAUDE_PROBE_TIMEOUT_MS_DEFAULT = 90_000;

/** Static evidence pointers — never credentials or raw payloads. */
export const CLAUDE_CACHE_EVIDENCE_REF = "claude-cache:cachedUsageUtilization";
export const CLAUDE_PROBE_EVIDENCE_REF = "claude-probe:usage-command";

/** Fixed local slash-command — asserted in tests; never interpolated, never
 * sent to the model (Claude Code resolves it locally, no API call). */
export const CLAUDE_PROBE_PROMPT = "/usage";
/** Cheapest supported model alias — structural safeguard only; see module
 * header on why this stays even though `/usage` never reaches the model. */
export const CLAUDE_PROBE_MODEL = "haiku";
/** Defensive spend cap (USD) — normal cost is $0; see module header. */
export const CLAUDE_PROBE_MAX_BUDGET_USD = 0.01;

/**
 * Either critical window (5H or 1W) at least this old triggers the refresh.
 * 14 minutes — one minute inside the 15-minute display `freshUntil` (NOT-281)
 * so the asynchronous single-flight `/usage` run normally completes before
 * the UI would mark the reading stale. Checked per window, never as a
 * newest-of-pair: one fresh sibling must not suppress its stale twin.
 */
export const CLAUDE_PROBE_STALE_AFTER_MS = 14 * 60 * 1000;
/**
 * Minimum gap between probe attempts (per account). Aligned with the trigger
 * above: a healthy observation causes at most one refresh per 14 minutes;
 * failures back off exponentially (14m → 28m → 56m → ~2h, capped at 8h).
 */
export const CLAUDE_PROBE_ATTEMPT_COOLDOWN_MS = 14 * 60 * 1000;
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
 * Fixed probe argv. Pinned by tests: the fixed local slash-command, cheapest
 * model, hard one-turn bound, no tools, no MCP, no session persistence,
 * stream JSON, defensive ≤$0.01 budget.
 *
 * Reviewer-requested hardening (2026-09-27, PR #165): `--model`/`--max-turns`/
 * `--tools` were originally dropped as "meaningless" because `/usage` never
 * reaches the model on 2.1.283 — but that is an empirical fact about one CLI
 * version, not a contract. Verified live that keeping all three does not
 * break local resolution (still `$0`, still `local_command: usage`), so they
 * stay as structural bounds: if some other CLI build ever makes `/usage`
 * fall through to a real prompt, the model is the cheapest alias, gets
 * exactly one turn, and has no tools to call — the same belt-and-braces the
 * original (abandoned) paid-turn design relied on. `--max-budget-usd` alone
 * is not sufficient (this repo's own live proof showed ambient context can
 * blow the cap before the check fires); see `runClaudeCapacityProbe` for the
 * matching fail-closed checks on the result (local-command marker present,
 * cost must be exactly $0).
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
// Free `/usage` refresh (default on)
// ---------------------------------------------------------------------------

/**
 * Refresh defaults ON when the setting is absent/empty. The historical
 * `paid-after-1h` value is still accepted explicitly (it now just means
 * "enabled" — the refresh costs nothing, see module header); `off` and
 * unrecognized values disable it so a typo never silently changes the
 * configured policy.
 */
export function isClaudePaidFallbackEnabled(): boolean {
  const setting = process.env[CLAUDE_CAPACITY_REFRESH_ENV];
  return setting === undefined || setting === "" || setting === CLAUDE_CAPACITY_REFRESH_PAID_VALUE;
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
  | "no_windows"
  // Reviewer-requested (2026-09-27, PR #165): the stream never resolved
  // `/usage` as a local command — on 2.1.283 this never happens, but if a
  // different CLI build ever falls through to a real prompt, fail closed
  // instead of trusting whatever signal it happened to produce.
  | "not_local_command"
  // The result did not prove exactly $0 cost — either a positive charge, or
  // `total_cost_usd` missing/unparsable so zero cannot be verified at all
  // (reviewer-requested, 2026-09-27: an unverifiable cost must fail closed
  // the same as a confirmed one — `costUsd === null` is not evidence of
  // safety). `/usage` costs exactly $0 whenever it resolves locally; any
  // other outcome means the structural safeguards above did not prevent (or
  // cannot rule out) a real model turn. Treated as a failure even if windows
  // were somehow produced, so backoff engages instead of quietly normalizing
  // recurring spend.
  | "unexpected_cost";

export interface ProbeRunResult {
  ok: boolean;
  windowsUpdated: string[];
  costUsd: number | null;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  failureKind: ProbeFailureKind | null;
  /**
   * NOT-366: the init event's `apiKeySource` (`none` = subscription login;
   * otherwise the name of the overriding auth source, e.g.
   * `ANTHROPIC_API_KEY`). Never a credential value. Under a non-subscription
   * auth source `/usage` resolves to a local cost summary with no
   * `usage_report` at all — the observed `no_windows` signature.
   */
  authSource?: string | null;
}

function probeAuthSource(events: Array<Record<string, unknown>>): string | null {
  for (const e of events) {
    if (e.type !== "system" || e.subtype !== "init") continue;
    const src = (e as { apiKeySource?: unknown }).apiKeySource;
    // Allow-list the shape so only a source *name* can ever be recorded.
    if (typeof src === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(src)) return src;
  }
  return null;
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

/**
 * True only when the stream shows `/usage` actually resolved as Claude
 * Code's local command (`local_command_run.command === "usage"`) — the
 * structural marker that the probe never reached the model. Absence means
 * the CLI build in use does not behave like 2.1.283; the caller must not
 * trust any windows the stream happens to carry (`not_local_command`).
 */
function hasLocalUsageCommandMarker(events: Array<Record<string, unknown>>): boolean {
  return events.some((e) => {
    const run = (e as { local_command_run?: unknown }).local_command_run;
    if (!run || typeof run !== "object") return false;
    return (run as Record<string, unknown>).command === "usage";
  });
}

/**
 * Extract account-wide 5H/1W readings directly from a `/usage` probe's
 * stream: the local-command result event carries `usage_report.rate_limits.
 * limits[]` in the exact shape (and role mapping via `limitEntryRole`) as
 * the cache file's `limits[]` — see module header. This is the primary,
 * most-reliable success signal for the probe (present on every successful
 * `/usage` run, verified live); the rate_limit_event and cache-re-read
 * checks below stay as additional, non-exclusive corroboration. Returns
 * null when no usable account-wide window is present — never fabricated.
 */
export function extractClaudeUsageReportLimits(
  events: Array<Record<string, unknown>>,
  nowMs: number,
  evidenceRef: string = CLAUDE_PROBE_EVIDENCE_REF
): AdapterWindowReading[] | null {
  let limits: unknown[] | null = null;
  let eventTimestamp: string | null = null;
  for (const e of events) {
    const report = (e as { usage_report?: unknown }).usage_report;
    if (!report || typeof report !== "object") continue;
    const rateLimits = (report as Record<string, unknown>).rate_limits;
    if (!rateLimits || typeof rateLimits !== "object") continue;
    const l = (rateLimits as Record<string, unknown>).limits;
    if (Array.isArray(l)) {
      limits = l;
      const ts = (e as { timestamp?: unknown }).timestamp;
      eventTimestamp = typeof ts === "string" ? ts : null;
    }
  }
  if (!limits) return null;
  const parsedTsMs = eventTimestamp !== null ? Date.parse(eventTimestamp) : Number.NaN;
  const observedMs = Number.isFinite(parsedTsMs) ? Math.min(parsedTsMs, nowMs) : nowMs;
  const observedAt = new Date(observedMs).toISOString();
  const byRole = new Map<"five_hour" | "weekly", AdapterWindowReading>();
  for (const item of limits) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const w = item as Record<string, unknown>;
    const name = pickString([w.kind, w.group, w.name, w.window, w.bucket, w.key, w.id]);
    if (!name) continue;
    const role = limitEntryRole(name);
    if (!role || byRole.has(role)) continue;
    const reading = cacheWindowReading(role, item, observedAt, observedMs, evidenceRef);
    if (reading) byRole.set(role, reading);
  }
  return byRole.size > 0 ? [...byRole.values()] : null;
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
 * Run one minimal FREE `/usage` probe and ingest whatever 5H/1W it yields.
 * Fails closed before touching any of it unless the stream both carries the
 * local-command marker (`local_command_run.command === "usage"`) and reports
 * exactly $0 cost — the structural proof `/usage` actually resolved locally
 * rather than falling through to a real (billable) model turn. Once that
 * holds, success ingests primarily the local command's own
 * `usage_report.rate_limits.limits[]` (present on every successful run),
 * plus any `rate_limit_event` the stream happens to carry and a re-read of
 * the local cache (the probe run itself refreshes Claude's own cache file)
 * as non-exclusive corroboration; success means the union covers both
 * critical roles. Never throws; never creates Dealer workflow/session rows,
 * worktrees, commits, PRs, or queue events.
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
      trigger: "stale_14m",
      probeCommand: CLAUDE_PROBE_PROMPT,
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
  const authSource = probeAuthSource(events);
  // Fail-closed structural checks (reviewer-requested, 2026-09-27, PR #165):
  // the whole design rests on `/usage` resolving as a local command that
  // never reaches the model. If either assumption is violated — no local-
  // command marker in the stream, or cost not provably exactly $0 — reject
  // the run entirely before ingesting anything from it, rather than trusting
  // whatever windows a real (unexpected) model turn happened to produce.
  // `costUsd !== 0` (not `> 0`) is deliberate: `null` — a missing or
  // unparsable `total_cost_usd` — is not evidence of zero cost either, and
  // must fail closed exactly like a confirmed charge (second review round).
  // This also makes a future CLI-behavior change loud (backoff engages,
  // logged as a distinct failure kind) instead of silently becoming a
  // recurring paid probe again.
  if (!hasLocalUsageCommandMarker(events)) return fail("not_local_command", { costUsd, authSource });
  if (costUsd !== 0) return fail("unexpected_cost", { costUsd, authSource });
  // Primary signal: the `/usage` local command's own structured result.
  // Present on every successful run (verified live) — most reliable source.
  let usageReportRoles = new Set<string>();
  try {
    const usageWindows = extractClaudeUsageReportLimits(events, nowMs);
    if (usageWindows) {
      usageReportRoles = rolesCoveredByReadings(usageWindows);
      recordClaudeWindowReadings(usageWindows, CLAUDE_RUNTIME, nowMs);
    }
  } catch {
    // A broken stream must not fail the probe path — other checks below
    // may still yield fresh rows.
  }
  // Secondary corroboration: any `rate_limit_event` the stream happens to
  // carry (kept from the original NOT-248 event path; harmless if absent).
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
  // strictly newer observation counts toward success. The re-read uses a
  // post-spawn clock: Claude writes `fetchedAtMs` during the probe, so it is
  // later than the pre-spawn `nowMs` and would be rejected as future
  // against the stale stamp.
  const postProbeNowMs = Math.max(nowMs, Date.now());
  let cacheRoles = new Set<string>();
  try {
    const reread = readClaudeLocalCache(postProbeNowMs);
    if (reread) {
      const afterObservedMs = maxReadingObservedMs(reread.windows);
      if (
        afterObservedMs !== null &&
        (preProbeCacheObservedMs === null || afterObservedMs > preProbeCacheObservedMs)
      ) {
        cacheRoles = rolesCoveredByReadings(reread.windows);
      }
      recordClaudeWindowReadings(reread.windows, CLAUDE_RUNTIME, postProbeNowMs);
    }
  } catch {
    // Advisory — stream coverage below still counts.
  }
  const covered = new Set([...usageReportRoles, ...streamRoles, ...cacheRoles]);
  if (spawnResult.exitCode !== 0 && covered.size === 0) {
    return fail("nonzero_exit", { costUsd, authSource });
  }
  if (!covered.has("five_hour") || !covered.has("weekly")) {
    // A subscription-authenticated `/usage` run carries both roles directly
    // in `usage_report.rate_limits.limits[]` (re-verified live at 2.1.292).
    // `no_windows` means the report was absent — e.g. an API-key auth source
    // (see `authSource`), or the CLI's own plan-limits fetch failing — and
    // is persisted as the window's unavailable reason (NOT-366).
    return fail("no_windows", { costUsd, authSource });
  }
  const out: ProbeRunResult = {
    ok: true,
    windowsUpdated: [CACHE_WINDOW_IDENTITIES.five_hour.windowKey, CACHE_WINDOW_IDENTITIES.weekly.windowKey],
    costUsd,
    exitCode: spawnResult.exitCode,
    timedOut: false,
    durationMs,
    failureKind: null,
    authSource,
  };
  logProbeOutcome(out);
  appendProbeDiagnostic({
    ts: new Date(nowMs).toISOString(),
    event: "claude_capacity_probe",
    trigger: "stale_14m",
    probeCommand: CLAUDE_PROBE_PROMPT,
    budgetUsd: CLAUDE_PROBE_MAX_BUDGET_USD,
    ...out,
  });
  return out;
}

// ---------------------------------------------------------------------------
// Unavailable-reason persistence (NOT-366)
// ---------------------------------------------------------------------------

/**
 * Operator-readable cause for a failed refresh. Deliberately prose: the
 * internal `ProbeFailureKind` identifiers stay in the diagnostic log and
 * never reach the stored row, the API, or the header (NOT-266).
 */
export function claudeProbeFailureMessage(
  kind: ProbeFailureKind,
  authSource: string | null = null
): string {
  switch (kind) {
    case "spawn":
      return "the Claude CLI could not be started for the /usage refresh";
    case "timeout":
      return "the Claude /usage refresh timed out";
    case "nonzero_exit":
      return "the Claude /usage refresh exited with an error";
    case "no_windows":
      if (authSource !== null && authSource !== "none") {
        return (
          `Claude /usage reported no plan limits: the CLI is authenticated via ${authSource}, ` +
          "which has no 5H/1W subscription windows"
        );
      }
      return "Claude /usage reported no 5H/1W plan limits";
    case "not_local_command":
      return "Claude /usage did not run as a local command, so its result was not trusted";
    case "unexpected_cost":
      return "the Claude /usage refresh could not be verified as free, so its result was rejected";
  }
}

function failureUnavailableReason(kind: ProbeFailureKind): CapacityUnavailableReason {
  // A payload arrived but yielded no trusted windows vs. no payload at all.
  return kind === "no_windows" || kind === "not_local_command" || kind === "unexpected_cost"
    ? "unparsable"
    : "missing";
}

/**
 * Record a failed refresh on every critical window that has no current
 * reading, so absence of data is stored with its cause instead of inferred
 * from an empty header. A window still carrying a current reading is left
 * alone (a fresh reading always wins). An existing stale row keeps its
 * last-good value and `observedAt` — only so newer-wins arbitration in
 * `recordClaudeWindowReadings` still works — and is flagged
 * `source: unavailable`, so read-time classification never shows it as a
 * number. The streak (count + first failure) continues from whatever is
 * already stored, so it survives a server restart; any successful reading
 * rewrites the row with no detail, clearing it.
 */
export function recordClaudeAcquisitionFailure(
  result: Pick<ProbeRunResult, "failureKind" | "authSource">,
  nowMs = Date.now(),
  inMemoryStreak: { count: number; firstFailureMs: number | null } = { count: 1, firstFailureMs: nowMs }
): number {
  const kind = result.failureKind;
  if (!kind) return 0;
  const rows = new Map(listCapacitySnapshots(CLAUDE_RUNTIME).map((r) => [r.windowKey, r]));
  let prevCount = 0;
  let firstMs = inMemoryStreak.firstFailureMs ?? nowMs;
  for (const identity of Object.values(CACHE_WINDOW_IDENTITIES)) {
    const detail = rows.get(identity.windowKey)?.unavailableDetail;
    if (!detail) continue;
    prevCount = Math.max(prevCount, detail.consecutiveFailures);
    const ms = Date.parse(detail.firstFailureAt);
    if (Number.isFinite(ms)) firstMs = Math.min(firstMs, ms);
  }
  const nowIso = new Date(nowMs).toISOString();
  const unavailableDetail: CapacityUnavailableDetail = {
    message: claudeProbeFailureMessage(kind, result.authSource ?? null),
    consecutiveFailures: Math.max(prevCount + 1, inMemoryStreak.count, 1),
    firstFailureAt: new Date(Math.min(firstMs, nowMs)).toISOString(),
    lastFailureAt: nowIso,
  };
  const writes = Object.values(CACHE_WINDOW_IDENTITIES).flatMap((identity) => {
    const row = rows.get(identity.windowKey);
    if (row && isWindowKnown(row, nowMs)) return [];
    return [
      {
        windowKey: identity.windowKey,
        providerBucket: identity.providerBucket,
        durationMinutes: identity.durationMinutes,
        displayLabel: row?.displayLabel ?? deriveWindowLabel(identity.durationMinutes, identity.providerBucket),
        usedValue: row?.usedValue ?? null,
        usedUnit: row?.usedUnit ?? null,
        remainingPercent: row?.remainingPercent ?? null,
        resetAt: row?.resetAt ?? null,
        observedAt: row?.observedAt ?? nowIso,
        freshUntil: row?.freshUntil ?? null,
        expiresAt: row?.expiresAt ?? null,
        source: "unavailable" as const,
        unavailableReason: failureUnavailableReason(kind),
        evidenceRef: CLAUDE_PROBE_EVIDENCE_REF,
        criticalRole: identity.criticalRole,
        unavailableDetail,
      },
    ];
  });
  if (writes.length > 0) recordCapacitySnapshots(CLAUDE_RUNTIME, writes);
  return writes.length;
}

// ---------------------------------------------------------------------------
// Freshness gate, single-flight, backoff
// ---------------------------------------------------------------------------

export type ClaudeCriticalWindowRole = "five_hour" | "weekly";

/**
 * Newest valid account-wide observation per critical window (event or cache
 * — both share window keys and critical roles). A row counts when it
 * carries a remaining %, its reset is absent or future, and its observed
 * time is not in the future. A role maps to null when it has no such
 * sample (missing, expired, or unparsable). Split per window on purpose
 * (NOT-281): the refresh gate must see a stale twin hiding behind a fresh
 * sibling, which a newest-of-pair maximum cannot show.
 */
export function newestValidClaudeObservationMsByRole(
  nowMs = Date.now()
): Record<ClaudeCriticalWindowRole, number | null> {
  const out: Record<ClaudeCriticalWindowRole, number | null> = {
    five_hour: null,
    weekly: null,
  };
  for (const row of listCapacitySnapshots(CLAUDE_RUNTIME)) {
    if (row.criticalRole !== "five_hour" && row.criticalRole !== "weekly") continue;
    if (row.remainingPercent === null) continue;
    if (row.resetAt !== null) {
      const resetMs = Date.parse(row.resetAt);
      if (!Number.isFinite(resetMs) || resetMs <= nowMs) continue;
    }
    const observedMs = Date.parse(row.observedAt);
    if (!Number.isFinite(observedMs) || observedMs > nowMs) continue;
    const prev = out[row.criticalRole];
    out[row.criticalRole] = prev === null ? observedMs : Math.max(prev, observedMs);
  }
  return out;
}

/**
 * Newest valid account-wide 5H/1W observation across both critical windows.
 * Kept for diagnostics; the refresh gate uses the per-role variant above.
 */
export function newestValidClaudeObservationMs(nowMs = Date.now()): number | null {
  const byRole = newestValidClaudeObservationMsByRole(nowMs);
  if (byRole.five_hour === null) return byRole.weekly;
  if (byRole.weekly === null) return byRole.five_hour;
  return Math.max(byRole.five_hour, byRole.weekly);
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
let firstClaudeProbeFailureMs: number | null = null;

/** Test helper — clear single-flight, attempt, and backoff state. */
export function resetClaudeCapacityRefreshState(): void {
  claudeProbeInFlight = null;
  lastClaudeProbeAttemptMs = 0;
  consecutiveClaudeProbeFailures = 0;
  firstClaudeProbeFailureMs = null;
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
 * On-demand free `/usage` refresh: when `claude_code` is configured and
 * either critical window (5H or 1W) is missing or at least 14 minutes old,
 * run one minimal bounded probe (single-flight across concurrent readers;
 * at most one attempt per account per 14 minutes while healthy, backing
 * off exponentially on failure). Per-window on purpose (NOT-281): a fresh
 * sibling must never suppress its stale twin. Explicitly disabled is a
 * strict no-op — no spawn at all. Never throws, never touches Dealer
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
    const byRole = newestValidClaudeObservationMsByRole(nowMs);
    const fiveFresh =
      byRole.five_hour !== null && nowMs - byRole.five_hour < CLAUDE_PROBE_STALE_AFTER_MS;
    const weeklyFresh =
      byRole.weekly !== null && nowMs - byRole.weekly < CLAUDE_PROBE_STALE_AFTER_MS;
    if (fiveFresh && weeklyFresh) {
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
      if (result.ok) {
        consecutiveClaudeProbeFailures = 0;
        firstClaudeProbeFailureMs = null;
      } else {
        consecutiveClaudeProbeFailures += 1;
        firstClaudeProbeFailureMs ??= nowMs;
        try {
          recordClaudeAcquisitionFailure(result, nowMs, {
            count: consecutiveClaudeProbeFailures,
            firstFailureMs: firstClaudeProbeFailureMs,
          });
        } catch {
          // Advisory — the failure is still in the diagnostic log.
        }
      }
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
 * local cache first, then consider the free `/usage` probe. Best-effort —
 * never throws. The route serves the stored snapshot regardless.
 */
export async function refreshClaudeCapacityIfStale(
  nowMs = Date.now(),
  opts: { runner?: ProbeRunner; bin?: string; timeoutMs?: number } = {}
): Promise<ProbeGateOutcome> {
  // Skip the file read entirely when no Claude account is configured:
  // ~/.claude.json can be several MB and this runs on every capacity poll.
  if (!configuredCapacityRuntimes().includes(CLAUDE_RUNTIME)) {
    return { probed: false, reason: "unconfigured" };
  }
  try {
    ingestClaudeLocalCache(nowMs);
  } catch {
    // Advisory — the probe gate below still applies.
  }
  return maybeProbeClaudeCapacity(nowMs, opts);
}
